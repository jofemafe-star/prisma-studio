// PRISMA Studio — checklist PRISMA 2020 + diagrama de flujo, multiusuario con Firebase.
import { fb, configured } from './firebase.js';
import { compute, flowSvg, emptyFlow, listOf, num } from './flow.js';
import { download, svgBlob, svgToPng, docxBlob, locOf } from './export.js';

/* ============================== utilidades ============================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};
const newId = (p) => p + '_' + Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, '0')).join('');
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'proyecto';
const fmt = (ts) => {
  try { const d = ts?.toDate ? ts.toDate() : null; return d ? d.toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : ''; } catch { return ''; }
};
function setIn(o, path, v) {
  let c = o;
  for (let i = 0; i < path.length - 1; i++) c = c[path[i]] ??= {};
  c[path[path.length - 1]] = v;
}
const nest = (path, v) => path.reduceRight((acc, k) => ({ [k]: acc }), v);
const ROLE_ES = { owner: 'Propietario', editor: 'Editor', viewer: 'Lector' };

const root = $('#app');
function toast(msg, kind = 'info') {
  const box = $('#toast');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 't ' + kind;
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), kind === 'err' ? 8000 : 3500);
}

/* ================================ estado ================================ */
const S = {
  user: null, ready: false, tplIndex: [], tpl: {},
  projects: [], invites: [], cur: null,
  tab: 'checklist', filter: 'all', lang: ls.get('lang') || 'es',
  unsubHome: [], unsubProj: [],
};
const pend = {};            // ediciones locales aún no confirmadas por el servidor
const timers = new Map();   // escrituras con debounce

const role = () => S.cur?.data?.members?.[S.user?.uid] || null;
const canEdit = () => ['owner', 'editor'].includes(role());
const isOwner = () => role() === 'owner';
const myName = () => S.user.displayName || (S.user.email || '').split('@')[0];

function setSaving(state, e) {
  const el = $('#savestate');
  if (!el) return;
  el.textContent = state === 'saving' ? 'Guardando…' : state === 'saved' ? 'Guardado ✓' : `Error al guardar: ${e?.code === 'permission-denied' ? 'sin permiso' : e?.message || e}`;
  el.style.color = state === 'error' ? 'var(--err)' : '';
}
function debounced(key, fn, ms = 700) {
  const old = timers.get(key);
  if (old) clearTimeout(old.t);
  setSaving('saving');
  const run = async () => {
    timers.delete(key);
    try { await fn(); if (!timers.size) setSaving('saved'); } catch (e) { console.error(e); setSaving('error', e); }
  };
  timers.set(key, { t: setTimeout(run, ms), run });
}
function flushAll() {
  for (const [, v] of [...timers]) { clearTimeout(v.t); v.run(); }
}

/* ============================== plantillas ============================== */
async function loadTemplates() {
  if (S.tplIndex.length) return;
  const r = await fetch('plantillas.json');
  if (!r.ok) throw new Error('No se pudo cargar plantillas.json');
  S.tplIndex = await r.json();
}
async function getTpl(id) {
  if (!S.tpl[id]) {
    const e = S.tplIndex.find((t) => t.id === id);
    if (!e) throw new Error(`Guía desconocida: ${id}`);
    const r = await fetch(e.file);
    if (!r.ok) throw new Error('No se pudo cargar la plantilla ' + e.file);
    S.tpl[id] = await r.json();
  }
  return S.tpl[id];
}
const guideName = (id) => S.tplIndex.find((t) => t.id === id)?.name || id;

/* ================================ vistas ================================ */
const topbar = () =>
  `<header class="top"><a class="brand" href="#/">PRISMA&nbsp;Studio</a><span class="grow"></span>` +
  `<span class="muted who">${esc(S.user?.displayName || '')} ${esc(S.user?.email || '')}</span>` +
  `<button class="btn sm" data-act="logout">Salir</button></header>`;

function renderSetup() {
  root.innerHTML = `<main class="auth card"><h1>Falta la configuración de Firebase</h1>
  <p>Abre <code>firebase-config.js</code> y pega la configuración web de tu proyecto Firebase.
  Los pasos están en <code>README.md</code>.</p></main>`;
}

function renderAuth(msg = '') {
  root.innerHTML = `<main class="auth card">
    <h1>PRISMA Studio</h1>
    <p class="muted">Lista de verificación PRISMA 2020 y diagrama de flujo para revisiones sistemáticas, en equipo.</p>
    <button class="btn primary wide" data-act="google">Continuar con Google</button>
    <div class="sep"><span>o con email</span></div>
    <form id="em-form">
      <label>Email<input id="a-email" type="email" autocomplete="email" required></label>
      <label>Contraseña<input id="a-pw" type="password" autocomplete="current-password" required minlength="6"></label>
      <label>Nombre (solo al crear cuenta)<input id="a-name" autocomplete="name"></label>
      <div class="row"><button class="btn primary" type="submit">Entrar</button>
      <button class="btn" type="button" data-act="signup">Crear cuenta</button></div>
    </form>
    <button class="link" data-act="reset">He olvidado la contraseña</button>
    <p class="err" id="a-err">${esc(msg)}</p></main>`;
}

function renderVerify() {
  root.innerHTML = `<main class="auth card"><h1>Verifica tu email</h1>
    <p>Hemos enviado un enlace de verificación a <b>${esc(S.user.email)}</b>. Ábrelo y vuelve aquí.</p>
    <div class="row"><button class="btn primary" data-act="verify-done">Ya lo he verificado</button>
    <button class="btn" data-act="resend-verify">Reenviar email</button>
    <button class="btn" data-act="logout">Salir</button></div><p class="err" id="a-err"></p></main>`;
}

function authErr(e) {
  const m = {
    'auth/invalid-credential': 'Email o contraseña incorrectos.',
    'auth/wrong-password': 'Email o contraseña incorrectos.',
    'auth/user-not-found': 'Email o contraseña incorrectos.',
    'auth/email-already-in-use': 'Ya existe una cuenta con ese email.',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
    'auth/invalid-email': 'Email no válido.',
    'auth/popup-closed-by-user': '', 'auth/cancelled-popup-request': '',
    'auth/unauthorized-domain': 'Dominio no autorizado en Firebase (Authentication → Configuración → Dominios autorizados).',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
    'auth/network-request-failed': 'Sin conexión.',
  };
  return e?.code in m ? m[e.code] : e?.message || String(e);
}

/* ---------------------------------- Home --------------------------------- */
function renderHome() {
  root.innerHTML = `${topbar()}<main class="wrap">
    <div id="home-inv"></div>
    <section class="card"><div class="head"><h2>Mis proyectos</h2>
      <button class="btn primary" data-act="np-toggle">+ Nuevo proyecto</button></div>
      <form id="np-form" hidden>
        <label>Título de la revisión<input id="np-title" maxlength="200" required></label>
        <label>Autores (opcional)<input id="np-authors"></label>
        <label>Registro, p. ej. PROSPERO CRD… (opcional)<input id="np-reg"></label>
        <label>Guía / lista de verificación<select id="np-guide">${S.tplIndex.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></label>
        <div class="row"><button class="btn primary" type="submit">Crear proyecto</button>
        <button class="btn" type="button" data-act="np-toggle">Cancelar</button></div>
      </form>
      <div id="home-projects"></div></section></main>`;
  renderHomeLists();
}
function renderHomeLists() {
  const inv = $('#home-inv'), pr = $('#home-projects');
  if (!inv || !pr) return;
  inv.innerHTML = S.invites.length
    ? `<section class="card"><h2>Invitaciones pendientes</h2>${S.invites.map((i) =>
        `<div class="inv"><div class="grow"><b>${esc(i.projectTitle)}</b><div class="muted sm">${esc(i.invitedByName || '')} te invita como ${ROLE_ES[i.role] || esc(i.role)}</div></div>` +
        `<button class="btn primary sm" data-act="inv-accept" data-id="${esc(i.id)}">Aceptar</button>` +
        `<button class="btn sm" data-act="inv-decline" data-id="${esc(i.id)}">Rechazar</button></div>`).join('')}</section>`
    : '';
  pr.innerHTML = S.projects.length
    ? `<div class="projects">${S.projects.map((p) =>
        `<a class="proj" href="#/p/${esc(p.id)}"><b>${esc(p.title)}</b><span class="muted sm">${esc(guideName(p.guide))} · ${ROLE_ES[p.members?.[S.user.uid]] || ''}</span></a>`).join('')}</div>`
    : `<p class="muted">Aún no tienes proyectos. Crea uno o acepta una invitación.</p>`;
}

async function doCreate() {
  const title = $('#np-title').value.trim();
  if (!title) return;
  const u = S.user;
  const ref = fb.doc(fb.collection(fb.db, 'projects'));
  await fb.setDoc(ref, {
    title, guide: $('#np-guide').value, ownerUid: u.uid,
    members: { [u.uid]: 'owner' }, memberIds: [u.uid],
    memberInfo: { [u.uid]: { name: myName(), email: u.email.toLowerCase() } },
    meta: { authors: $('#np-authors').value.trim(), registration: $('#np-reg').value.trim() },
    createdAt: fb.serverTimestamp(), updatedAt: fb.serverTimestamp(),
  });
  // El documento de flujo se crea después (las reglas necesitan que el proyecto ya exista).
  await fb.setDoc(fb.doc(fb.db, 'projects', ref.id, 'flow', 'main'), emptyFlow(), { merge: true }).catch(() => {});
  location.hash = '#/p/' + ref.id;
}

/* ------------------------------ Proyecto ------------------------------- */
function closeProject() {
  flushAll();
  S.unsubProj.forEach((u) => u());
  S.unsubProj = [];
  S.cur = null;
  for (const k of Object.keys(pend)) delete pend[k];
}

async function openProject(pid) {
  if (S.cur?.id === pid) return;
  closeProject();
  const cur = (S.cur = { id: pid, data: null, checklist: {}, flow: emptyFlow(), invites: [], tpl: null, shell: false, loading: false, invSub: false, lastRole: null });
  S.tab = 'checklist';
  S.filter = 'all';
  root.innerHTML = `${topbar()}<main class="wrap"><p class="muted">Cargando proyecto…</p></main>`;

  const fail = (e) => {
    if (S.cur !== cur) return;
    const msg = e?.code === 'permission-denied' ? 'No tienes acceso a este proyecto (o ya no eres miembro).' : e?.message || 'No existe.';
    root.innerHTML = `${topbar()}<main class="wrap"><div class="card"><h2>No se puede abrir el proyecto</h2><p>${esc(msg)}</p><a href="#/">← Volver a mis proyectos</a></div></main>`;
  };

  S.unsubProj.push(fb.onSnapshot(fb.doc(fb.db, 'projects', pid), async (snap) => {
    if (S.cur !== cur) return;
    if (!snap.exists()) return fail({ message: 'El proyecto no existe o fue eliminado.' });
    cur.data = snap.data();
    for (const p of Object.values(pend)) {
      if (p.kind !== 'meta') continue;
      if (p.k === 'title') cur.data.title = p.value; else (cur.data.meta ||= {})[p.k] = p.value;
    }
    if (!cur.shell) {
      if (cur.loading) return;
      cur.loading = true;
      try { cur.tpl = await getTpl(cur.data.guide); } catch (e) { return fail(e); }
      if (S.cur !== cur) return;
      cur.shell = true;
      renderShell();
      subscribeChildren(cur);
    } else {
      onProjectChanged();
    }
    maybeSubscribeInvites(cur);
  }, fail));
}

function subscribeChildren(cur) {
  const pid = cur.id;
  const errH = (e) => { if (S.cur === cur) toast('Error de sincronización: ' + (e.message || e.code), 'err'); };
  S.unsubProj.push(fb.onSnapshot(fb.collection(fb.db, 'projects', pid, 'checklist'), (snap) => {
    if (S.cur !== cur) return;
    snap.docs.forEach((d) => { cur.checklist[d.id] = d.data(); });
    for (const p of Object.values(pend)) if (p.kind === 'cl') (cur.checklist[p.id] ||= {})[p.k] = p.value;
    if (S.tab === 'checklist') patchChecklist();
  }, errH));
  const flowRef = fb.doc(fb.db, 'projects', pid, 'flow', 'main');
  S.unsubProj.push(fb.onSnapshot(flowRef, (snap) => {
    if (S.cur !== cur) return;
    if (!snap.exists()) {
      if (canEdit()) fb.setDoc(flowRef, emptyFlow(), { merge: true }).catch(() => {});
      return;
    }
    cur.flow = { ...emptyFlow(), ...snap.data() };
    for (const p of Object.values(pend)) if (p.kind === 'flow') setIn(cur.flow, p.path, p.value);
    if (S.tab === 'flow') syncFlow();
  }, errH));
}

function maybeSubscribeInvites(cur) {
  if (cur.invSub || !cur.shell || role() !== 'owner') return;
  cur.invSub = true;
  S.unsubProj.push(fb.onSnapshot(fb.query(fb.collection(fb.db, 'invitations'), fb.where('projectId', '==', cur.id)), (snap) => {
    if (S.cur !== cur) return;
    cur.invites = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (S.tab === 'members') renderMembers();
  }, () => {}));
}

function onProjectChanged() {
  const cur = S.cur;
  updateHeader();
  const r = role();
  if (r !== cur.lastRole) { cur.lastRole = r; maybeSubscribeInvites(cur); renderTab(); return; }
  if (S.tab === 'members') renderMembers();
  if (S.tab === 'export') {
    $$('[data-meta]').forEach((i) => {
      if (document.activeElement === i) return;
      i.value = i.dataset.meta === 'title' ? cur.data.title : cur.data.meta?.[i.dataset.meta] || '';
    });
  }
}

function updateHeader() {
  const t = $('#p-title'), r = $('#p-role');
  if (t) t.textContent = S.cur.data.title;
  if (r) r.textContent = ROLE_ES[role()] || '';
}

function renderShell() {
  const tabs = [['checklist', 'Lista de verificación'], ['flow', 'Diagrama de flujo'], ['members', 'Miembros'], ['export', 'Exportar']];
  root.innerHTML = `${topbar()}<main class="wrap">
    <div class="phead"><a href="#/" class="link">← Proyectos</a><h1 id="p-title"></h1><span id="p-role" class="badge"></span>
      <span class="grow"></span><span id="savestate" class="muted sm"></span>
      <select id="lang" title="Idioma de la lista, el diagrama y las exportaciones"><option value="es">Español</option><option value="en">English</option></select></div>
    <nav class="tabs">${tabs.map(([k, l]) => `<button data-act="tab" data-tab="${k}">${l}</button>`).join('')}</nav>
    <div id="tab-body"></div></main>`;
  $('#lang').value = S.lang;
  S.cur.lastRole = role();
  updateHeader();
  renderTab();
}

function renderTab() {
  if (!S.cur?.shell) return;
  $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  ({ checklist: renderChecklist, flow: renderFlow, members: renderMembers, export: renderExport })[S.tab]();
}

/* ----------------------------- Lista de verificación ---------------------------- */
function renderChecklist() {
  const tpl = S.cur.tpl, lang = S.lang, ro = canEdit() ? '' : 'disabled';
  const itemHtml = (it) => `<article class="item" data-id="${it.id}">
    <div class="num">${it.id}</div><div>
      <div class="topic">${it.topic ? esc(it.topic[lang] || it.topic.en) : ''}</div>
      <p>${esc(it[lang] || it.en)}</p>
      <div class="fields">
        <select data-k="status" ${ro}><option value="pending">Pendiente</option><option value="done">Hecho</option><option value="na">No aplica</option></select>
        <input data-k="location" placeholder="Ubicación (p. ej. Métodos, p. 4)" maxlength="1000" ${ro}>
        <textarea data-k="notes" rows="2" placeholder="Notas internas (no se exportan)" maxlength="5000" ${ro}></textarea>
      </div><div class="meta muted"></div></div></article>`;
  $('#tab-body').innerHTML = `
    <div class="toolbar"><div class="progress"><div id="bar"></div></div><span id="pcount" class="sm"></span>
      <div class="seg"><button data-act="filter" data-filter="all">Todos</button><button data-act="filter" data-filter="pending">Pendientes</button></div></div>
    <div id="ck" class="${S.filter === 'pending' ? 'only-pending' : ''}">${tpl.sections.map((sec) =>
      `<section class="sec"><h3>${esc(sec[lang] || sec.en)}</h3>${tpl.items.filter((i) => i.section === sec.id).map(itemHtml).join('')}</section>`).join('')}</div>
    ${lang === 'es' && tpl.translationNote ? `<p class="muted sm">${esc(tpl.translationNote)}</p>` : ''}`;
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.filter === S.filter));
  patchChecklist();
}

function patchChecklist() {
  const body = $('#ck');
  if (!body || S.tab !== 'checklist') return;
  const items = S.cur.tpl.items;
  let done = 0;
  for (const it of items) {
    const el = $(`.item[data-id="${it.id}"]`, body);
    if (!el) continue;
    const st = S.cur.checklist[it.id] || {};
    const status = st.status || 'pending';
    if (status !== 'pending') done++;
    el.classList.toggle('is-done', status === 'done');
    el.classList.toggle('is-na', status === 'na');
    for (const k of ['status', 'location', 'notes']) {
      const inp = $(`[data-k="${k}"]`, el);
      const v = st[k] ?? (k === 'status' ? 'pending' : '');
      if (inp && document.activeElement !== inp && inp.value !== v) inp.value = v;
    }
    const meta = $('.meta', el);
    if (meta) meta.textContent = st.updatedByName ? `Editado por ${st.updatedByName}${fmt(st.updatedAt) ? ' · ' + fmt(st.updatedAt) : ''}` : '';
  }
  const pct = Math.round((done * 100) / items.length);
  $('#bar').style.width = pct + '%';
  $('#pcount').textContent = `${done}/${items.length} ítems (${pct}%)`;
}

function itemEdit(id, k, val, delay) {
  const cur = S.cur, pid = cur.id, uid = S.user.uid, name = myName(), key = `cl:${id}:${k}`;
  (cur.checklist[id] ||= {})[k] = val;
  pend[key] = { kind: 'cl', id, k, value: val };
  patchChecklist();
  debounced(key, async () => {
    await fb.setDoc(fb.doc(fb.db, 'projects', pid, 'checklist', id),
      { [k]: val, updatedBy: uid, updatedByName: name, updatedAt: fb.serverTimestamp() }, { merge: true });
    if (pend[key]?.value === val) delete pend[key];
  }, delay);
}

/* ------------------------------ Diagrama de flujo ----------------------------- */
const numField = (key, label, ro) =>
  `<label class="nf"><span>${label}</span><input type="number" min="0" step="1" data-f="${key}" value="${num(S.cur.flow[key])}" ${ro}></label>`;
const outField = (key, label) => `<div class="nf out"><span>${label}</span><output data-out="${key}">0</output></div>`;

function srcRows() {
  const ro = canEdit() ? '' : 'disabled';
  const rows = listOf(S.cur.flow.sources);
  return rows.map((s) => `<div class="src" data-id="${esc(s.id)}">
    <select data-src="type" ${ro}><option value="database" ${s.type !== 'register' ? 'selected' : ''}>Base de datos</option><option value="register" ${s.type === 'register' ? 'selected' : ''}>Registro</option></select>
    <input data-src="name" placeholder="PubMed, Embase, ClinicalTrials.gov…" value="${esc(s.name)}" maxlength="120" ${ro}>
    <input data-src="n" type="number" min="0" step="1" title="Registros identificados" value="${num(s.n)}" ${ro}>
    <input data-src="date" type="date" title="Fecha de la última búsqueda" value="${esc(s.date || '')}" ${ro}>
    ${ro ? '' : `<button class="btn sm" data-act="rm-src" title="Quitar">✕</button>`}</div>`).join('') ||
    `<p class="muted sm">Sin fuentes todavía.</p>`;
}
function rsRows() {
  const ro = canEdit() ? '' : 'disabled';
  return listOf(S.cur.flow.reasons).map((r) => `<div class="rs" data-id="${esc(r.id)}">
    <input data-rs="text" placeholder="Motivo de exclusión (p. ej. población incorrecta)" value="${esc(r.text)}" maxlength="200" ${ro}>
    <input data-rs="n" type="number" min="0" step="1" value="${num(r.n)}" ${ro}>
    ${ro ? '' : `<button class="btn sm" data-act="rm-reason" title="Quitar">✕</button>`}</div>`).join('') ||
    `<p class="muted sm">Sin motivos todavía.</p>`;
}
const flowSig = () => listOf(S.cur.flow.sources).map((s) => s.id).join(',') + '|' + listOf(S.cur.flow.reasons).map((r) => r.id).join(',');

function renderFlow() {
  const ro = canEdit() ? '' : 'disabled';
  $('#tab-body').innerHTML = `<div class="flow-grid">
    <div class="card" id="flow-form" data-sig="${esc(flowSig())}">
      <h3 style="margin-top:0">1 · Identificación</h3>
      <p class="muted sm">Una fila por base de datos o registro consultado (ítems 6 y 16a).</p>
      <div id="src-list">${srcRows()}</div>
      ${ro ? '' : `<div class="row"><button class="btn sm" data-act="add-db">+ Base de datos</button><button class="btn sm" data-act="add-reg">+ Registro</button></div>`}
      <h4>Registros eliminados antes del cribado</h4>
      ${numField('duplicates', 'Duplicados eliminados', ro)}
      ${numField('automation', 'No elegibles según herramientas de automatización', ro)}
      ${numField('otherRemoved', 'Eliminados por otras razones', ro)}
      <h3>2 · Cribado</h3>
      ${outField('screened', 'Registros cribados')}
      ${numField('excludedScreening', 'Registros excluidos (título/resumen)', ro)}
      ${outField('sought', 'Informes solicitados para su recuperación')}
      ${numField('notRetrieved', 'Informes no recuperados', ro)}
      ${outField('assessed', 'Informes evaluados para elegibilidad')}
      <h4>Informes excluidos, con motivo (ítem 16b)</h4>
      <div id="rs-list">${rsRows()}</div>
      ${ro ? '' : `<div class="row"><button class="btn sm" data-act="add-reason">+ Motivo de exclusión</button></div>`}
      <h3>3 · Incluidos</h3>
      ${outField('included', 'Estudios incluidos en la revisión')}
      ${numField('reportsIncluded', 'Informes de los estudios incluidos', ro)}
    </div>
    <div class="card flow-view"><div id="flow-warn"></div><div id="flow-svg"></div>
      <div class="row"><button class="btn sm" data-act="export" data-kind="svg">Descargar SVG</button>
      <button class="btn sm" data-act="export" data-kind="png">Descargar PNG</button></div></div></div>`;
  previewFlow();
}

function previewFlow() {
  if (S.tab !== 'flow' || !$('#flow-svg')) return;
  const c = compute(S.cur.flow);
  $$('[data-out]').forEach((o) => { o.textContent = c[o.dataset.out]; });
  $('#flow-warn').innerHTML = c.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('');
  $('#flow-svg').innerHTML = flowSvg(c, S.lang);
}

function syncFlow() {
  const form = $('#flow-form');
  if (S.tab !== 'flow' || !form) return;
  const f = S.cur.flow;
  const sig = flowSig();
  if (form.dataset.sig !== sig) {
    const ae = document.activeElement;
    const keep = ae && form.contains(ae) ? { id: ae.closest('[data-id]')?.dataset.id, a: ae.dataset.src ? 'src' : ae.dataset.rs ? 'rs' : null, k: ae.dataset.src || ae.dataset.rs } : null;
    $('#src-list').innerHTML = srcRows();
    $('#rs-list').innerHTML = rsRows();
    form.dataset.sig = sig;
    if (keep?.id && keep.a) $(`[data-id="${keep.id}"] [data-${keep.a}="${keep.k}"]`, form)?.focus();
  }
  const setv = (inp, v) => { if (inp && document.activeElement !== inp && inp.value !== String(v)) inp.value = v; };
  $$('[data-f]', form).forEach((i) => setv(i, num(f[i.dataset.f])));
  $$('.src', form).forEach((r) => {
    const s = f.sources[r.dataset.id] || {};
    $$('[data-src]', r).forEach((i) => setv(i, i.dataset.src === 'n' ? num(s.n) : s[i.dataset.src] ?? (i.dataset.src === 'type' ? 'database' : '')));
  });
  $$('.rs', form).forEach((r) => {
    const s = f.reasons[r.dataset.id] || {};
    $$('[data-rs]', r).forEach((i) => setv(i, i.dataset.rs === 'n' ? num(s.n) : s.text ?? ''));
  });
  previewFlow();
}

function writeFlow(pid, patch) {
  const uid = S.user.uid;
  return fb.setDoc(fb.doc(fb.db, 'projects', pid, 'flow', 'main'),
    { ...patch, updatedAt: fb.serverTimestamp(), updatedBy: uid }, { merge: true });
}
function flowEdit(path, value) {
  const cur = S.cur, pid = cur.id, key = 'flow:' + path.join('.');
  setIn(cur.flow, path, value);
  pend[key] = { kind: 'flow', path, value };
  previewFlow();
  debounced(key, async () => {
    await writeFlow(pid, nest(path, value));
    if (pend[key]?.value === value) delete pend[key];
  });
}
function flowAdd(group, obj, prefix) {
  const cur = S.cur, id = newId(prefix);
  cur.flow[group] ||= {};
  cur.flow[group][id] = obj;
  syncFlow();
  $(`[data-id="${id}"] input:not([type="number"]):not([type="date"])`)?.focus();
  setSaving('saving');
  writeFlow(cur.id, { [group]: { [id]: obj } }).then(() => setSaving('saved')).catch((e) => setSaving('error', e));
}
function flowRemove(group, id) {
  const cur = S.cur;
  delete cur.flow[group]?.[id];
  for (const k of Object.keys(pend)) {
    if (!k.startsWith(`flow:${group}.${id}`)) continue;
    delete pend[k];
    const t = timers.get(k);
    if (t) { clearTimeout(t.t); timers.delete(k); }
  }
  syncFlow();
  setSaving('saving');
  writeFlow(cur.id, { [group]: { [id]: fb.deleteField() } }).then(() => setSaving('saved')).catch((e) => setSaving('error', e));
}

/* ---------------------------------- Miembros --------------------------------- */
function renderMembers() {
  const d = S.cur.data, me = S.user.uid, owner = isOwner();
  const entries = Object.entries(d.members).sort(([a], [b]) => (a === d.ownerUid ? -1 : b === d.ownerUid ? 1 : 0));
  const rows = entries.map(([id, r]) => {
    const info = d.memberInfo?.[id] || {};
    const editable = owner && id !== d.ownerUid;
    return `<tr><td>${esc(info.name || '—')}${id === me ? ' <span class="badge">tú</span>' : ''}</td><td>${esc(info.email || '')}</td>
      <td>${editable ? `<select data-role-of="${esc(id)}"><option value="editor" ${r === 'editor' ? 'selected' : ''}>Editor</option><option value="viewer" ${r === 'viewer' ? 'selected' : ''}>Lector</option></select>` : ROLE_ES[r] || esc(r)}</td>
      <td>${editable ? `<button class="btn sm danger" data-act="rm-member" data-uid="${esc(id)}">Quitar</button>` : id === me && !owner ? `<button class="btn sm danger" data-act="leave">Salir del proyecto</button>` : ''}</td></tr>`;
  }).join('');
  const pending = S.cur.invites.filter((i) => i.status === 'pending');
  $('#tab-body').innerHTML = `<section class="card"><h2>Miembros</h2>
      <table class="members"><thead><tr><th>Nombre</th><th>Email</th><th>Rol</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted sm"><b>Propietario</b>: gestiona miembros y borra el proyecto · <b>Editor</b>: edita lista y flujo · <b>Lector</b>: solo consulta y exporta.</p></section>
    ${owner ? `<section class="card"><h2>Invitar a una persona</h2>
      <form id="invite-form" class="row"><input id="inv-email" type="email" placeholder="email@ejemplo.com" required style="flex:1;min-width:220px">
        <select id="inv-role"><option value="editor">Editor</option><option value="viewer">Lector</option></select>
        <button class="btn primary" type="submit">Invitar</button></form>
      <p class="muted sm">La app no envía correos: comparte el enlace de la app. Al entrar (o crear su cuenta) con <b>ese mismo email</b> y verificarlo, la persona verá la invitación en «Mis proyectos».</p>
      <div class="row"><button class="btn sm" data-act="copy-link">Copiar enlace de la app</button></div>
      ${pending.length ? `<h4>Invitaciones pendientes</h4>${pending.map((i) =>
        `<div class="inv"><div class="grow">${esc(i.email)} <span class="badge">${ROLE_ES[i.role] || esc(i.role)}</span></div><button class="btn sm" data-act="revoke-inv" data-id="${esc(i.id)}">Revocar</button></div>`).join('')}` : ''}
    </section>
    <section class="card"><h2>Zona de peligro</h2><p class="muted sm">Borra el proyecto y todos sus datos para todos los miembros.</p>
      <button class="btn danger" data-act="del-project">Borrar proyecto</button></section>` : ''}`;
}

async function doInvite() {
  const cur = S.cur;
  const email = $('#inv-email').value.trim().toLowerCase();
  const r = $('#inv-role').value;
  if (!/^\S+@\S+\.\S+$/.test(email)) return toast('Email no válido', 'err');
  if (Object.values(cur.data.memberInfo || {}).some((m) => m.email === email)) return toast('Esa persona ya es miembro', 'err');
  try {
    await fb.setDoc(fb.doc(fb.db, 'invitations', `${cur.id}_${email}`), {
      projectId: cur.id, projectTitle: cur.data.title, email, role: r, status: 'pending',
      invitedBy: S.user.uid, invitedByName: myName(), createdAt: fb.serverTimestamp(),
    });
    $('#inv-email').value = '';
    toast('Invitación creada. Comparte el enlace de la app con esa persona.', 'ok');
  } catch (e) {
    toast(e.code === 'permission-denied' ? 'No se pudo crear la invitación (¿ya existe una para ese email? Revócala primero).' : e.message, 'err');
  }
}

async function delProject() {
  const cur = S.cur, pid = cur.id, title = cur.data.title;
  const typed = prompt(`Esta acción borra el proyecto y todos sus datos para todos los miembros.\nEscribe el título del proyecto para confirmar:\n\n${title}`);
  if (typed === null) return;
  if (typed.trim() !== title.trim()) return toast('El título no coincide. No se ha borrado nada.', 'err');
  closeProject();
  root.innerHTML = `${topbar()}<main class="wrap"><p class="muted">Borrando proyecto…</p></main>`;
  try {
    for (const sub of ['checklist', 'flow']) {
      const snap = await fb.getDocs(fb.collection(fb.db, 'projects', pid, sub));
      await Promise.all(snap.docs.map((x) => fb.deleteDoc(x.ref)));
    }
    const inv = await fb.getDocs(fb.query(fb.collection(fb.db, 'invitations'), fb.where('projectId', '==', pid)));
    await Promise.all(inv.docs.map((x) => fb.deleteDoc(x.ref)));
    await fb.deleteDoc(fb.doc(fb.db, 'projects', pid));
    toast('Proyecto borrado', 'ok');
  } catch (e) { toast('Error al borrar: ' + (e.message || e.code), 'err'); }
  location.hash = '#/';
  route();
}

/* ---------------------------------- Exportar --------------------------------- */
function renderExport() {
  const d = S.cur.data, ro = canEdit() ? '' : 'disabled';
  const btn = (kind, t, sub) => `<button class="btn" data-act="export" data-kind="${kind}">${t}<small>${sub}</small></button>`;
  $('#tab-body').innerHTML = `
    <section class="card"><h2>Datos del informe</h2>
      <label>Título<input data-meta="title" maxlength="200" value="${esc(d.title)}" ${ro}></label>
      <label>Autores<input data-meta="authors" value="${esc(d.meta?.authors || '')}" ${ro}></label>
      <label>Registro (p. ej. PROSPERO CRD…)<input data-meta="registration" value="${esc(d.meta?.registration || '')}" ${ro}></label>
      <p class="muted sm">Idioma de las exportaciones: el seleccionado arriba a la derecha (${S.lang === 'es' ? 'Español' : 'English'}).</p></section>
    <section class="card"><h2>Exportar</h2><div class="export-grid">
      ${btn('docx-check', 'Lista de verificación (.docx)', 'Formato oficial de 4 columnas')}
      ${btn('docx-full', 'Informe completo (.docx)', 'Lista + diagrama de flujo + tabla de fuentes')}
      ${btn('svg', 'Diagrama de flujo (.svg)', 'Vectorial, editable')}
      ${btn('png', 'Diagrama de flujo (.png)', 'Imagen 2×')}
      ${btn('pdf', 'PDF (imprimir)', 'Abre el diálogo de impresión → «Guardar como PDF»')}
      ${btn('json', 'Copia de seguridad (.json)', 'Todos los datos del proyecto')}
    </div></section>`;
}

function metaEdit(k, val) {
  const cur = S.cur, pid = cur.id, key = 'meta:' + k;
  if (k === 'title') {
    if (!val.trim()) return;
    cur.data.title = val;
    updateHeader();
  } else cur.data.meta = { ...(cur.data.meta || {}), [k]: val };
  pend[key] = { kind: 'meta', k, value: val };
  debounced(key, async () => {
    await fb.setDoc(fb.doc(fb.db, 'projects', pid), { ...(k === 'title' ? { title: val } : { meta: { [k]: val } }), updatedAt: fb.serverTimestamp() }, { merge: true });
    if (pend[key]?.value === val) delete pend[key];
  }, 800);
}

async function doExport(kind) {
  const cur = S.cur, d = cur.data, tpl = cur.tpl, lang = S.lang;
  const c = compute(cur.flow), svg = flowSvg(c, lang), base = slug(d.title);
  if (kind === 'svg') return download(svgBlob(svg), `${base}_flujo-PRISMA.svg`);
  if (kind === 'png') { const p = await svgToPng(svg, 2); return download(p.blob, `${base}_flujo-PRISMA.png`); }
  if (kind === 'pdf') return printReport();
  if (kind === 'json') {
    const data = { exportedAt: new Date().toISOString(), project: { title: d.title, guide: d.guide, meta: d.meta || {} }, checklist: cur.checklist, flow: cur.flow };
    return download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `${base}_backup.json`);
  }
  // docx
  const pending = tpl.items.filter((i) => (cur.checklist[i.id]?.status || 'pending') === 'pending').length;
  if (pending && !confirm(`Hay ${pending} ítems pendientes de completar. ¿Exportar igualmente?`)) return;
  const full = kind === 'docx-full';
  const png = full ? await svgToPng(svg, 2) : null;
  const blob = await docxBlob({ project: d, template: tpl, checklist: cur.checklist, lang, flow: c, flowPng: png, includeFlow: full });
  download(blob, `${base}_PRISMA2020${full ? '_informe' : ''}.docx`);
}

function printReport() {
  const cur = S.cur, d = cur.data, tpl = cur.tpl, lang = S.lang;
  const c = compute(cur.flow);
  const L = lang === 'es'
    ? { cols: ['Sección y tema', 'Ítem n.º', 'Ítem de la lista de verificación', 'Ubicación donde se informa el ítem'], authors: 'Autores', reg: 'Registro', src: 'Fuentes de información (ítem 6)', sc: ['Fuente', 'Tipo', 'Registros (n)', 'Última búsqueda'], db: 'Base de datos', rg: 'Registro' }
    : { cols: ['Section and Topic', 'Item #', 'Checklist item', 'Location where item is reported'], authors: 'Authors', reg: 'Registration', src: 'Information sources (item 6)', sc: ['Source', 'Type', 'Records (n)', 'Last searched'], db: 'Database', rg: 'Register' };
  const rows = tpl.sections.map((sec) => {
    const its = tpl.items.filter((i) => i.section === sec.id);
    return `<tr class="sec"><td colspan="4">${esc(sec[lang] || sec.en)}</td></tr>` + its.map((it) =>
      `<tr><td><b>${it.topic ? esc(it.topic[lang] || it.topic.en) : ''}</b></td><td>${it.id}</td><td>${esc(it[lang] || it.en)}</td><td>${esc(locOf(cur.checklist[it.id]))}</td></tr>`).join('');
  }).join('');
  const srcRowsHtml = c.sources.map((s) => `<tr><td>${esc(s.name || '—')}</td><td>${s.type === 'register' ? L.rg : L.db}</td><td>${num(s.n)}</td><td>${esc(s.date || '')}</td></tr>`).join('');
  $('#print-root').innerHTML = `<h1>${esc(tpl.title[lang] || tpl.title.en)}</h1><p><b>${esc(d.title)}</b>
    ${d.meta?.authors ? `<br>${L.authors}: ${esc(d.meta.authors)}` : ''}${d.meta?.registration ? `<br>${L.reg}: ${esc(d.meta.registration)}` : ''}</p>
    <table><thead><tr>${L.cols.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
    <div class="pb">${flowSvg(c, lang)}</div>
    ${srcRowsHtml ? `<h3>${L.src}</h3><table><thead><tr>${L.sc.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${srcRowsHtml}</tbody></table>` : ''}
    <p class="fn">${esc(tpl.citation)}</p>`;
  window.print();
}

/* ================================= acciones ================================= */
const acts = {
  async google() {
    try { await fb.signInWithPopup(fb.auth, new fb.GoogleAuthProvider()); }
    catch (e) { const m = authErr(e); if (m) $('#a-err').textContent = m; }
  },
  async signup() { await emailAuth('signup'); },
  async reset() {
    const email = $('#a-email').value.trim();
    if (!email) { $('#a-err').textContent = 'Escribe tu email y vuelve a pulsar.'; return; }
    try { await fb.sendPasswordResetEmail(fb.auth, email); toast('Te hemos enviado un email para restablecer la contraseña.', 'ok'); }
    catch (e) { $('#a-err').textContent = authErr(e); }
  },
  async logout() {
    flushAll();
    location.hash = '#/'; // el siguiente usuario no debe aterrizar en el proyecto del anterior
    await fb.signOut(fb.auth);
  },
  async 'resend-verify'() { await fb.sendEmailVerification(S.user); toast('Email de verificación reenviado.', 'ok'); },
  async 'verify-done'() {
    await S.user.reload();
    await S.user.getIdToken(true);
    if (S.user.emailVerified) await startSession(S.user);
    else $('#a-err').textContent = 'Todavía no está verificado. Revisa tu correo (y la carpeta de spam).';
  },
  'np-toggle'() { const f = $('#np-form'); f.hidden = !f.hidden; if (!f.hidden) $('#np-title').focus(); },
  async 'inv-accept'(el) {
    const inv = S.invites.find((i) => i.id === el.dataset.id);
    if (!inv) return;
    const u = S.user;
    await fb.setDoc(fb.doc(fb.db, 'projects', inv.projectId), {
      members: { [u.uid]: inv.role }, memberIds: fb.arrayUnion(u.uid),
      memberInfo: { [u.uid]: { name: myName(), email: u.email.toLowerCase() } }, updatedAt: fb.serverTimestamp(),
    }, { merge: true });
    await fb.deleteDoc(fb.doc(fb.db, 'invitations', inv.id)).catch(() => {});
    location.hash = '#/p/' + inv.projectId;
  },
  async 'inv-decline'(el) { await fb.deleteDoc(fb.doc(fb.db, 'invitations', el.dataset.id)); },
  async 'revoke-inv'(el) { await fb.deleteDoc(fb.doc(fb.db, 'invitations', el.dataset.id)); },
  tab(el) { S.tab = el.dataset.tab; renderTab(); },
  filter(el) {
    S.filter = el.dataset.filter;
    $('#ck')?.classList.toggle('only-pending', S.filter === 'pending');
    $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.filter === S.filter));
  },
  'add-db'() { flowAdd('sources', { type: 'database', name: '', n: 0, date: '', order: Date.now() }, 's'); },
  'add-reg'() { flowAdd('sources', { type: 'register', name: '', n: 0, date: '', order: Date.now() }, 's'); },
  'add-reason'() { flowAdd('reasons', { text: '', n: 0, order: Date.now() }, 'r'); },
  'rm-src'(el) { flowRemove('sources', el.closest('.src').dataset.id); },
  'rm-reason'(el) { flowRemove('reasons', el.closest('.rs').dataset.id); },
  async 'rm-member'(el) {
    const uid = el.dataset.uid, info = S.cur.data.memberInfo?.[uid];
    if (!confirm(`¿Quitar a ${info?.name || info?.email || 'este miembro'} del proyecto?`)) return;
    await fb.setDoc(fb.doc(fb.db, 'projects', S.cur.id), {
      members: { [uid]: fb.deleteField() }, memberInfo: { [uid]: fb.deleteField() },
      memberIds: fb.arrayRemove(uid), updatedAt: fb.serverTimestamp(),
    }, { merge: true });
  },
  async leave() {
    if (!confirm('¿Salir de este proyecto? Perderás el acceso hasta que te vuelvan a invitar.')) return;
    const uid = S.user.uid, pid = S.cur.id;
    closeProject();
    await fb.setDoc(fb.doc(fb.db, 'projects', pid), {
      members: { [uid]: fb.deleteField() }, memberInfo: { [uid]: fb.deleteField() },
      memberIds: fb.arrayRemove(uid), updatedAt: fb.serverTimestamp(),
    }, { merge: true });
    location.hash = '#/';
    route();
  },
  'copy-link'() {
    const url = location.origin + location.pathname;
    (navigator.clipboard?.writeText(url) || Promise.reject()).then(() => toast('Enlace copiado', 'ok')).catch(() => prompt('Copia el enlace:', url));
  },
  'del-project': delProject,
  export: (el) => doExport(el.dataset.kind),
};

async function emailAuth(mode) {
  const email = $('#a-email').value.trim(), pw = $('#a-pw').value, name = $('#a-name').value.trim();
  const err = $('#a-err');
  err.textContent = '';
  if (!email || !pw) { err.textContent = 'Introduce email y contraseña.'; return; }
  try {
    if (mode === 'signup') {
      const cred = await fb.createUserWithEmailAndPassword(fb.auth, email, pw);
      if (name) await fb.updateProfile(cred.user, { displayName: name });
      await fb.sendEmailVerification(cred.user);
    } else await fb.signInWithEmailAndPassword(fb.auth, email, pw);
  } catch (e) { err.textContent = authErr(e); }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = acts[el.dataset.act];
  if (!fn) return;
  Promise.resolve()
    .then(() => fn(el, e))
    .catch((err) => { console.error(err); toast(err?.code === 'permission-denied' ? 'Sin permiso para esta acción.' : err?.message || String(err), 'err'); });
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = e.target.id;
  const run = id === 'em-form' ? () => emailAuth('login') : id === 'np-form' ? doCreate : id === 'invite-form' ? doInvite : null;
  if (run) Promise.resolve().then(run).catch((err) => { console.error(err); toast(err?.message || String(err), 'err'); });
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!S.cur?.shell || !t.dataset) return;
  if (t.dataset.f !== undefined) return flowEdit([t.dataset.f], num(t.value));
  const src = t.closest('.src');
  if (src && t.dataset.src) return flowEdit(['sources', src.dataset.id, t.dataset.src], t.dataset.src === 'n' ? num(t.value) : t.value);
  const rs = t.closest('.rs');
  if (rs && t.dataset.rs) return flowEdit(['reasons', rs.dataset.id, t.dataset.rs], t.dataset.rs === 'n' ? num(t.value) : t.value);
  const item = t.closest('.item');
  if (item && t.dataset.k) return itemEdit(item.dataset.id, t.dataset.k, t.value, t.tagName === 'SELECT' ? 50 : 700);
  if (t.dataset.meta) return metaEdit(t.dataset.meta, t.value);
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.id === 'lang') { S.lang = t.value; ls.set('lang', S.lang); renderTab(); return; }
  if (t.dataset?.roleOf && S.cur) {
    try {
      await fb.setDoc(fb.doc(fb.db, 'projects', S.cur.id), { members: { [t.dataset.roleOf]: t.value }, updatedAt: fb.serverTimestamp() }, { merge: true });
    } catch (err) { toast(err.message || err.code, 'err'); }
  }
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
window.addEventListener('pagehide', flushAll);
window.addEventListener('unhandledrejection', (e) => console.error(e.reason));

/* ================================ enrutado y arranque ================================ */
function route() {
  if (!S.user || !S.ready) return;
  const m = location.hash.match(/^#\/p\/([A-Za-z0-9]+)/);
  if (m) openProject(m[1]);
  else { if (S.cur) closeProject(); renderHome(); }
}
window.addEventListener('hashchange', route);

function subscribeHome() {
  const u = S.user, email = u.email.toLowerCase();
  S.unsubHome.push(fb.onSnapshot(fb.query(fb.collection(fb.db, 'projects'), fb.where('memberIds', 'array-contains', u.uid)), (snap) => {
    const t = (p) => p.updatedAt?.toMillis?.() ?? Date.now();
    S.projects = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => t(b) - t(a));
    if (!S.cur) renderHomeLists();
  }, (e) => toast('No se pudieron leer los proyectos: ' + (e.message || e.code), 'err')));
  S.unsubHome.push(fb.onSnapshot(fb.query(fb.collection(fb.db, 'invitations'), fb.where('email', '==', email)), (snap) => {
    S.invites = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => i.status === 'pending');
    if (!S.cur) renderHomeLists();
  }, () => {}));
}

async function startSession(user) {
  try { await loadTemplates(); }
  catch (e) {
    root.innerHTML = `<main class="auth card"><h1>No se pudieron cargar las plantillas</h1><p>${esc(e.message)}</p><p class="muted sm">Si abres el archivo con doble clic no funcionará: sirve la carpeta con un servidor local o publícala en GitHub Pages (ver README).</p></main>`;
    return;
  }
  await fb.setDoc(fb.doc(fb.db, 'users', user.uid), { name: user.displayName || '', email: (user.email || '').toLowerCase(), lastLogin: fb.serverTimestamp() }, { merge: true }).catch(() => {});
  subscribeHome();
  S.ready = true;
  route();
}

function stopSession() {
  flushAll();
  S.unsubHome.forEach((u) => u());
  S.unsubHome = [];
  closeProject();
  S.projects = []; S.invites = []; S.ready = false;
}

if (!configured) renderSetup();
else {
  fb.onAuthStateChanged(fb.auth, async (user) => {
    stopSession();
    S.user = user;
    if (!user) return renderAuth();
    const pw = user.providerData.some((p) => p.providerId === 'password');
    if (pw && !user.emailVerified) return renderVerify();
    await startSession(user);
  });
}
