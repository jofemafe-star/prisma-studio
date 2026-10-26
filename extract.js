// Pestañas «Extracción» y «Comparación»: estudios, extracción con IA (PDF), verificación manual,
// tablas comparativas y viabilidad del metaanálisis.
import { STUDY_FIELDS, OUTCOME_NUM, MODELS, MAX_PDF_BYTES, callClaude, pdfToBase64, ping, ExtractError, harmonize } from './extract-api.js';
import { assess, MEASURES, back, fmtNum, normKey } from './meta.js';

const KEY_LS = 'prisma.apikey', MODEL_LS = 'prisma.model';
const ORD = (a, b) => (a.order ?? 0) - (b.order ?? 0);
const toNum = (s) => { const t = String(s ?? '').trim().replace(',', '.'); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : null; };
const showNum = (v) => (v === null || v === undefined ? '' : String(v).replace('.', ','));

export function initExtraction(ctx) {
  const { S, fb, $, $$, esc, toast, canEdit, newId, nest, setSaving, debounced, pend, download, myName } = ctx;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };
  const queue = []; let running = false;
  const cmp = { outcome: null, timepoint: null, measure: null };

  const stRef = (sid) => fb.doc(fb.db, 'projects', S.cur.id, 'studies', sid);
  const write = (sid, patch) => fb.setDoc(stRef(sid), { ...patch, updatedAt: fb.serverTimestamp(), updatedByName: myName() }, { merge: true });
  const studies = () => Object.entries(S.cur.studies || {}).map(([id, s]) => ({ id, ...s })).sort((a, b) => (a.createdMs ?? 0) - (b.createdMs ?? 0) || String(a.label).localeCompare(String(b.label)));
  const outcomesOf = (s) => Object.entries(s.outcomes || {}).map(([id, o]) => ({ id, ...o })).sort(ORD);
  const apiKey = () => lsGet(KEY_LS) || '';
  const model = () => lsGet(MODEL_LS) || MODELS[0].id;

  /* ----------------------------- suscripción ----------------------------- */
  function subscribe(cur, errH) {
    S.unsubProj.push(fb.onSnapshot(fb.collection(fb.db, 'projects', cur.id, 'studies'), (snap) => {
      if (S.cur !== cur) return;
      const seen = new Set();
      snap.docs.forEach((d) => {
        const x = d.data();
        cur.studies[d.id] = { ...x, createdMs: x.createdAt?.toMillis?.() ?? cur.studies[d.id]?.createdMs ?? Date.now() };
        seen.add(d.id);
      });
      for (const id of Object.keys(cur.studies)) if (!seen.has(id) && !snap.metadata?.hasPendingWrites) delete cur.studies[id];
      for (const p of Object.values(pend)) if (p.kind === 'st' && cur.studies[p.sid]) setPath(cur.studies[p.sid], p.path, p.value);
      if (S.tab === 'extract') patchExtraction();
      else if (S.tab === 'compare') renderCompare();
    }, errH));
  }
  function setPath(o, path, v) { let c = o; for (let i = 0; i < path.length - 1; i++) c = c[path[i]] ??= {}; c[path[path.length - 1]] = v; }

  /* ------------------------------ extracción ------------------------------ */
  async function addFiles(files) {
    if (!canEdit()) return;
    if (!apiKey()) { toast('Primero guarda tu clave de API en «Conexión con la IA».', 'err'); return; }
    for (const file of files) {
      if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) { toast(`«${file.name}» no es un PDF.`, 'err'); continue; }
      if (file.size > MAX_PDF_BYTES) { toast(`«${file.name}» pesa más de ${MAX_PDF_BYTES / 1048576} MB: usa una versión más ligera.`, 'err'); continue; }
      const sid = newId('st');
      const label = file.name.replace(/\.pdf$/i, '');
      S.cur.studies[sid] = { label, fileName: file.name, status: 'queued', verified: false, fields: {}, outcomes: {}, createdMs: Date.now() };
      await fb.setDoc(stRef(sid), { label, fileName: file.name, status: 'queued', error: '', verified: false, fields: {}, outcomes: {}, createdAt: fb.serverTimestamp(), createdByName: myName(), updatedAt: fb.serverTimestamp(), updatedByName: myName() });
      queue.push({ sid, file, pid: S.cur.id });
    }
    patchExtraction();
    runQueue();
  }

  async function runQueue() {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift();
      await extractOne(job).catch((e) => console.error(e));
    }
    running = false;
  }

  async function extractOne({ sid, file, pid, replace }) {
    const ref = fb.doc(fb.db, 'projects', pid, 'studies', sid);
    const put = (patch) => fb.setDoc(ref, { ...patch, updatedAt: fb.serverTimestamp(), updatedByName: myName() }, { merge: true });
    try {
      await put({ status: 'extracting', error: '' });
      const buf = await file.arrayBuffer();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8 * 60 * 1000);
      let out;
      const instr = { project: S.cur?.id === pid ? (S.cur.data?.meta?.exInstr || '') : '', article: S.cur?.studies?.[sid]?.instr || '' };
      try { out = await callClaude({ apiKey: apiKey(), model: model(), pdfBase64: pdfToBase64(buf), instr, fetchImpl: ctx.fetchImpl, signal: ctl.signal }); }
      finally { clearTimeout(timer); }
      const { study, outcomes } = out.result;
      const oc = {};
      outcomes.forEach((o, i) => { oc[newId('o')] = { ...o, order: Date.now() + i }; });
      const patch = { status: 'extracted', error: '', fields: study, outcomes: oc, verified: false, verifiedBy: '', model: out.model, extractedAt: fb.serverTimestamp(), instrUsed: [instr.project && `Revisión: ${instr.project}`, instr.article && `Artículo: ${instr.article}`].filter(Boolean).join('\n').slice(0, 6200) };
      if (replace) for (const oid of Object.keys(S.cur?.studies?.[sid]?.outcomes || {})) if (!(oid in oc)) oc[oid] = fb.deleteField();
      const guess = study.authors_year?.v;
      if (guess && (!S.cur?.studies?.[sid]?.label || S.cur.studies[sid].label === file.name.replace(/\.pdf$/i, ''))) patch.label = guess;
      await put(patch);
      toast(`Extracción completada: ${guess || file.name}`, 'ok');
    } catch (e) {
      const msg = e instanceof ExtractError ? e.message : (e?.message || String(e));
      await put({ status: 'error', error: msg }).catch(() => {});
      toast(`Error en «${file.name}»: ${msg}`, 'err');
    }
  }

  /* --------------------------- edición manual --------------------------- */
  function edit(sid, path, value) {
    const st = S.cur.studies[sid];
    if (!st) return;
    setPath(st, path, value);
    const key = `st:${sid}:${path.join('.')}`;
    pend[key] = { kind: 'st', sid, path, value };
    debounced(key, async () => {
      await write(sid, nest(path, value));
      if (pend[key]?.value === value) delete pend[key];
    });
  }
  function addOutcome(sid) {
    const st = S.cur.studies[sid];
    const oid = newId('o');
    const row = { outcome: '', timepoint: '', type: 'continuous', int_label: '', ctl_label: '', effect_measure: '', notes: '', quote: '', page: '', order: Date.now(), ...Object.fromEntries(OUTCOME_NUM.map((k) => [k, null])) };
    (st.outcomes ||= {})[oid] = row;
    paintDetail(true);
    $(`#ex-detail [data-oid="${oid}"] [data-o="outcome"]`)?.focus();
    setSaving('saving');
    write(sid, { outcomes: { [oid]: row } }).then(() => setSaving('saved')).catch((e) => setSaving('error', e));
  }
  function removeOutcome(sid, oid) {
    const st = S.cur.studies[sid];
    delete st.outcomes?.[oid];
    for (const k of Object.keys(pend)) if (k.startsWith(`st:${sid}:outcomes.${oid}`)) delete pend[k];
    paintDetail(true);
    setSaving('saving');
    write(sid, { outcomes: { [oid]: fb.deleteField() } }).then(() => setSaving('saved')).catch((e) => setSaving('error', e));
  }

  /* ------------------------------- vista: Extracción ------------------------------- */
  const statusBadge = (s) => {
    if (s.status === 'queued') return '<span class="badge">En cola…</span>';
    if (s.status === 'extracting') return '<span class="badge b-wait">Extrayendo…</span>';
    if (s.status === 'error') return '<span class="badge b-err">Error</span>';
    return s.verified ? `<span class="badge b-ok">Verificado ✓${s.verifiedBy ? ' · ' + esc(s.verifiedBy) : ''}</span>` : '<span class="badge b-warn">Por verificar</span>';
  };

  function connHtml() {
    const has = !!apiKey();
    return `<section class="card" id="ex-conn"><h2>Conexión con la IA</h2>
      <p class="muted sm">La extracción la hace Claude (Anthropic) con <b>tu propia clave de API</b>. La clave se guarda solo en este navegador: no se sube a Firebase ni la ve el resto del equipo, y cada persona usa y paga la suya. Los PDF se envían a Anthropic para analizarlos y no se guardan en esta web.</p>
      <div class="row"><input id="ex-key" data-ex="key" type="password" autocomplete="off" placeholder="sk-ant-…" value="${esc(apiKey())}" style="flex:1;min-width:220px">
        <select data-ex="model">${MODELS.map((m) => `<option value="${m.id}" ${m.id === model() ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
        <button class="btn" data-act="ex-testkey">Probar clave</button></div>
      <p class="muted sm" id="ex-keystate">${has ? 'Clave guardada en este navegador.' : 'Aún no hay clave. Créala en console.anthropic.com → API keys, y fija un límite de gasto mensual.'} No uses esto en ordenadores compartidos.</p></section>`;
  }

  function instrHtml() {
    const ro = canEdit() ? '' : 'disabled';
    const val = S.cur.data?.meta?.exInstr || '';
    if (!canEdit() && !val) return '';
    return `<section class="card" id="ex-instr"><h2>Instrucciones de extracción de la revisión</h2>
      <p class="muted sm">Dile a la IA <b>qué debe extraer</b> en esta revisión: la pregunta, las comparaciones de interés, los desenlaces y momentos de medida, y qué ignorar. Se aplican a <b>todos los artículos que extraigas a partir de ahora</b> (los ya extraídos no cambian hasta que pulses «Volver a extraer»). Las reglas de rigor (no inventar ni calcular datos) no se pueden desactivar.</p>
      <textarea data-meta="exInstr" rows="4" maxlength="3000" ${ro} placeholder="Ejemplo: Pregunta de la revisión: implantes frente a prótesis fija en pacientes edéntulos. Extrae solo la comparación implante (intervención) vs prótesis fija (control); ignora los grupos sin tratamiento. Desenlaces: supervivencia, pérdida ósea marginal (mm) y complicaciones, a 1, 3 y 5 años.">${esc(val)}</textarea>
      <p class="muted sm">Se comparte con todo el equipo. Si dejas esto vacío, la IA extrae las comparaciones de cada grupo de intervención frente al control.</p></section>`;
  }

  function listHtml() {
    const rows = studies();
    const ro = canEdit();
    return `<section class="card"><div class="head"><h2>Estudios incluidos (${rows.length})</h2>
      ${ro ? `<span><input type="file" id="ex-files" accept="application/pdf,.pdf" multiple hidden><button class="btn primary" data-act="ex-pick">+ Añadir artículos (PDF)</button></span>` : ''}</div>
      <p class="muted sm">Sube los PDF de los estudios que has incluido. Cada artículo tarda de 30 s a unos minutos. Hasta ~50 páginas por artículo (límite de la API: 100 páginas, 32 MB). <b>Verifica siempre los datos extraídos</b> con el artículo antes de usarlos.</p>
      ${rows.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Estudio</th><th>Estado</th><th>Desenlaces</th><th>Editado</th><th></th></tr></thead><tbody>
        ${rows.map((s) => `<tr data-sid="${s.id}" class="${S.exOpen === s.id ? 'sel' : ''}"><td><b>${esc(s.label || s.fileName)}</b><br><span class="muted sm">${esc(s.fileName || '')}</span>${s.status === 'error' ? `<br><span class="err sm">${esc(s.error)}</span>` : ''}</td>
          <td>${statusBadge(s)}</td><td>${outcomesOf(s).length}</td><td class="muted sm">${esc(s.updatedByName || '')}</td>
          <td class="nowrap"><button class="btn sm" data-act="ex-open" data-sid="${s.id}">${S.exOpen === s.id ? 'Cerrar' : 'Abrir'}</button>
          ${ro ? `<button class="btn sm danger" data-act="ex-del" data-sid="${s.id}">Eliminar</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Todavía no hay estudios. Pulsa «+ Añadir artículos (PDF)».</p>'}</section>`;
  }

  function renderExtraction() {
    if (S.exOpen && !S.cur.studies[S.exOpen]) S.exOpen = null;
    $('#tab-body').innerHTML = `<div id="ex-root">${canEdit() ? connHtml() : ''}${instrHtml()}<div id="ex-list">${listHtml()}</div><div id="ex-detail"></div></div>`;
    paintDetail(true);
  }

  function patchExtraction() {
    if (!$('#ex-root')) return renderExtraction();
    if (S.exOpen && !S.cur.studies[S.exOpen]) S.exOpen = null;
    $('#ex-list').innerHTML = listHtml();
    paintDetail(false);
  }

  const detailSig = (s) => [s.status, s.verified, !!s.instrUsed, outcomesOf(s).map((o) => o.id).join(',')].join('|');

  function paintDetail(force) {
    const box = $('#ex-detail');
    if (!box) return;
    const sid = S.exOpen, s = sid && S.cur.studies[sid];
    if (!s) { box.innerHTML = ''; box.dataset.sig = ''; return; }
    const sig = sid + '#' + detailSig(s);
    const ro = canEdit() ? '' : 'disabled';
    if (force || box.dataset.sig !== sig) {
      const ae = document.activeElement;
      const keep = ae && box.contains(ae) ? { oid: ae.closest('[data-oid]')?.dataset.oid, o: ae.dataset.o, fid: ae.dataset.fid, ex: ae.dataset.ex } : null;
      const fields = STUDY_FIELDS.map((f) => {
        const x = s.fields?.[f.id] || {};
        return `<tr><th class="fl">${esc(f.label)}</th><td><textarea rows="2" data-ex="field" data-fid="${f.id}" ${ro} placeholder="${esc(f.hint)}">${esc(x.v || '')}</textarea>
          ${x.q ? `<div class="quote">«${esc(x.q)}»${x.p ? ` · p. ${esc(x.p)}` : ''}</div>` : ''}</td></tr>`;
      }).join('');
      const names = [...new Set(studies().flatMap((st) => outcomesOf(st).map((o) => o.outcome)).filter(Boolean))];
      const num = (o, k, lbl) => `<label class="of"><span>${lbl}</span><input class="n" data-o="${k}" inputmode="decimal" value="${esc(showNum(o[k]))}" ${ro}></label>`;
      const txt = (o, k, lbl, cls = '') => `<label class="of ${cls}"><span>${lbl}</span><input data-o="${k}" ${k === 'outcome' ? 'list="ex-outnames"' : ''} value="${esc(o[k] || '')}" ${ro}></label>`;
      const orows = outcomesOf(s).map((o, i) => `<div class="ocard" data-oid="${o.id}">
        <div class="ohead"><span class="onum">${i + 1}</span>${txt(o, 'outcome', 'Desenlace', 'grow2')}${txt(o, 'timepoint', 'Momento', 'w140')}
          <label class="of w140"><span>Tipo</span><select data-o="type" ${ro}><option value="continuous" ${o.type === 'continuous' ? 'selected' : ''}>continuo</option><option value="dichotomous" ${o.type === 'dichotomous' ? 'selected' : ''}>dicotómico</option><option value="other" ${!['continuous', 'dichotomous'].includes(o.type) ? 'selected' : ''}>otro</option></select></label>
          ${ro ? '' : `<button class="btn sm danger" data-act="ex-rm-o" data-row="${o.id}" title="Quitar este desenlace">×</button>`}</div>
        <div class="ogroups">
          <div class="ogrp"><b>Intervención</b><div class="ofl">${txt(o, 'int_label', 'Grupo', 'grow2')}${num(o, 'int_n', 'n')}${num(o, 'int_mean', 'Media')}${num(o, 'int_sd', 'DE')}${num(o, 'int_events', 'Eventos')}</div></div>
          <div class="ogrp"><b>Control</b><div class="ofl">${txt(o, 'ctl_label', 'Grupo', 'grow2')}${num(o, 'ctl_n', 'n')}${num(o, 'ctl_mean', 'Media')}${num(o, 'ctl_sd', 'DE')}${num(o, 'ctl_events', 'Eventos')}</div></div>
          <div class="ogrp"><b>Efecto publicado</b><div class="ofl">${txt(o, 'effect_measure', 'Medida', 'w80')}${num(o, 'effect', 'Efecto')}${num(o, 'ci_low', 'IC inf.')}${num(o, 'ci_high', 'IC sup.')}${num(o, 'p_value', 'p')}</div></div>
        </div>
        <label class="of"><span>Notas</span><textarea rows="1" data-o="notes" ${ro}>${esc(o.notes || '')}</textarea></label>
        ${o.quote || o.page ? `<div class="quote">Origen${o.page ? ' (p. ' + esc(o.page) + ')' : ''}: ${o.quote ? '«' + esc(o.quote) + '»' : ''}</div>` : ''}
      </div>`).join('');
      box.innerHTML = `<section class="card"><div class="head"><h2>${esc(s.label || s.fileName)}</h2><span>${statusBadge(s)}</span></div>
        ${s.status === 'error' ? `<div class="warn">⚠ ${esc(s.error)}</div>` : ''}
        ${s.status === 'extracting' || s.status === 'queued' ? '<p class="muted">La IA está leyendo el artículo… puedes seguir trabajando; los datos aparecerán aquí al terminar.</p>' : ''}
        <label>Nombre del estudio<input data-ex="label" value="${esc(s.label || '')}" maxlength="200" ${ro}></label>
        <h3>Características</h3><table class="tbl flat"><tbody>${fields}</tbody></table>
        <h3>Desenlaces <span class="muted sm">(una fila por desenlace, momento y comparación)</span></h3>
        <p class="muted sm">Usa el <b>mismo nombre</b> de desenlace en todos los estudios para poder compararlos (te sugiere los ya usados). Medias y DE para variables continuas; eventos y n para dicotómicas; efecto + IC cuando solo se publica eso.</p>
        <datalist id="ex-outnames">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <div class="olist">${orows || '<p class="muted">Sin desenlaces.</p>'}</div>
        ${ro ? '' : `<div class="row"><button class="btn" data-act="ex-add-o">+ Añadir fila de desenlace</button></div>`}
        ${ro && !s.instrUsed ? '' : `<div class="card-sub"><label>Instrucciones solo para este artículo <span class="muted sm">(se aplican al pulsar «Volver a extraer»; se suman a las de la revisión)</span>
          <textarea data-ex="instr" rows="2" maxlength="3000" ${ro} placeholder="Ejemplo: en este artículo extrae también el grupo de prótesis removible como comparador y usa solo la tabla 4.">${esc(s.instr || '')}</textarea></label>
          ${s.instrUsed ? `<p class="muted sm">Última extracción hecha con estas instrucciones:<br><i>${esc(s.instrUsed).replace(/\n/g, '<br>')}</i></p>` : ''}</div>`}
        <div class="row" style="margin-top:.8rem">
          ${ro ? '' : `<label class="chk"><input type="checkbox" data-ex="verified" ${s.verified ? 'checked' : ''} ${s.status !== 'extracted' ? 'disabled' : ''}> He comprobado estos datos con el artículo original</label>
          <span class="grow"></span><input type="file" id="ex-refile" accept="application/pdf,.pdf" hidden><button class="btn sm" data-act="ex-reextract">Volver a extraer (subir PDF)…</button>`}
        </div></section>`;
      box.dataset.sig = sig;
      if (keep?.oid && keep.o) $(`[data-oid="${keep.oid}"] [data-o="${keep.o}"]`, box)?.focus();
      else if (keep?.fid) $(`[data-fid="${keep.fid}"]`, box)?.focus();
      else if (keep?.ex === 'label') $('[data-ex="label"]', box)?.focus();
      else if (keep?.ex === 'instr') $('[data-ex="instr"]', box)?.focus();
      return;
    }
    // misma estructura: solo actualizar valores que no se están editando
    const setv = (el, v) => { if (el && document.activeElement !== el && el.value !== v) el.value = v; };
    setv($('[data-ex="label"]', box), s.label || '');
    setv($('[data-ex="instr"]', box), s.instr || '');
    $$('[data-fid]', box).forEach((el) => setv(el, s.fields?.[el.dataset.fid]?.v || ''));
    $$('[data-oid]', box).forEach((tr) => {
      const o = s.outcomes?.[tr.dataset.oid] || {};
      $$('[data-o]', tr).forEach((el) => {
        const k = el.dataset.o;
        setv(el, OUTCOME_NUM.includes(k) ? showNum(o[k]) : o[k] || (k === 'type' ? 'continuous' : ''));
      });
    });
  }


  /* ------------------- armonización de desenlaces con IA (solo texto) ------------------- */
  const harm = { status: 'idle', groups: [], items: [], refs: [], msg: '', cur: null };
  const harmReset = () => { harm.status = 'idle'; harm.groups = []; harm.items = []; harm.refs = []; harm.msg = ''; harm.cur = null; };

  function harmItems() {
    const items = [], refs = [];
    for (const s of studies()) {
      if (s.status !== 'extracted') continue;
      for (const o of outcomesOf(s)) {
        if (!o.outcome) continue;
        refs.push({ sid: s.id, oid: o.id });
        items.push({ i: items.length, study: s.label || s.fileName || '', outcome: o.outcome, timepoint: o.timepoint || '', type: o.type || '', effect_measure: o.effect_measure || '', intervention: o.int_label || '', control: o.ctl_label || '', notes: String(o.notes || '').slice(0, 300), source: String(o.quote || '').slice(0, 200) });
      }
    }
    return { items, refs };
  }
  const harmChanged = (g) => g.members.some((i) => harm.items[i].outcome !== g.name.trim() || (harm.items[i].timepoint || '') !== g.timepoint.trim());
  const harmCount = () => harm.groups.filter((g) => g.apply && g.name.trim()).length;

  async function runHarm() {
    if (!canEdit()) return;
    if (!apiKey()) { toast('Primero guarda tu clave de API en la pestaña «Extracción».', 'err'); return; }
    const { items, refs } = harmItems();
    if (!items.length) { toast('No hay desenlaces extraídos que armonizar.', 'err'); return; }
    const cur = S.cur;
    harmReset(); harm.status = 'running'; harm.cur = cur.id; renderCompare();
    try {
      const out = await harmonize({ apiKey: apiKey(), model: model(), items, context: cur.data?.meta?.exInstr || '', fetchImpl: ctx.fetchImpl });
      if (S.cur !== cur) return;
      harm.items = items; harm.refs = refs;
      harm.groups = out.groups.map((g) => { const x = { ...g }; x.apply = false; return x; });
      harm.groups.forEach((g) => { g.apply = harmChanged(g) && g.combinable && g.confidence !== 'baja'; });
      harm.status = 'review';
    } catch (e) {
      if (S.cur !== cur) return;
      harm.status = 'error'; harm.msg = e instanceof ExtractError ? e.message : (e?.message || String(e));
    }
    if (S.tab === 'compare') renderCompare();
  }

  async function applyHarm() {
    if (!canEdit() || harm.status !== 'review') return;
    const byStudy = {}; let n = 0;
    for (const g of harm.groups) {
      const name = g.name.trim(); if (!g.apply || !name) continue;
      const tp = g.timepoint.trim();
      for (const i of g.members) {
        const { sid, oid } = harm.refs[i]; const o = S.cur.studies[sid]?.outcomes?.[oid]; if (!o) continue;
        const patch = { outcome: name, timepoint: tp };
        if (!('origOutcome' in o) && (o.outcome || '') !== name) patch.origOutcome = o.outcome || '';
        if (!('origTimepoint' in o) && (o.timepoint || '') !== tp) patch.origTimepoint = o.timepoint || '';
        const tag = g.concern ? `[Armonización IA: ${g.concern}]` : '';
        if (tag && !String(o.notes || '').includes(tag)) patch.notes = (o.notes ? o.notes + ' ' : '') + tag;
        (byStudy[sid] ||= {})[oid] = patch; n++;
      }
    }
    if (!n) { toast('No hay ningún grupo seleccionado para aplicar.', 'err'); return; }
    for (const [sid, os] of Object.entries(byStudy)) for (const [oid, patch] of Object.entries(os)) Object.assign(S.cur.studies[sid].outcomes[oid], patch);
    setSaving('saving');
    try { await Promise.all(Object.entries(byStudy).map(([sid, os]) => write(sid, { outcomes: os }))); setSaving('saved'); }
    catch (e) { setSaving('error', e); return; }
    toast(`Armonizados ${n} desenlaces.`, 'ok');
    harmReset(); renderCompare();
  }

  function harmHtml() {
    if (!canEdit()) return '';
    const head = '<h2>Armonizar desenlaces con IA</h2>';
    const intro = '<p class="muted sm">La IA lee la lista de desenlaces ya extraídos (solo texto, sin los PDF; cuesta céntimos) y propone qué filas de distintos estudios miden lo mismo, con un nombre y un momento unificados. <b>No cambia nada hasta que revises la propuesta y pulses «Aplicar».</b> Los casos dudosos (otra escala, método o definición) se marcan como no combinables.</p>';
    if (harm.status === 'running') return `<section class="card" id="harm">${head}<p class="muted">Analizando los desenlaces… puede tardar unos segundos.</p></section>`;
    if (harm.status === 'error') return `<section class="card" id="harm">${head}<div class="warn">⚠ ${esc(harm.msg)}</div><div class="row"><button class="btn" data-act="harm-run">Reintentar</button></div></section>`;
    if (harm.status === 'review') {
      const rel = [], solo = [];
      harm.groups.forEach((g, gi) => { const nSt = new Set(g.members.map((i) => harm.refs[i].sid)).size; (g.members.length >= 2 || harmChanged(g) || g.concern || !g.combinable ? rel : solo).push({ g, gi, nSt }); });
      rel.sort((a, b) => b.nSt - a.nSt);
      const badge = (g) => `${harmChanged(g) ? '' : '<span class="badge">ya unificado</span> '}<span class="badge ${g.confidence === 'alta' ? 'b-ok' : g.confidence === 'media' ? 'b-warn' : 'b-err'}">confianza ${g.confidence}</span>${g.combinable ? '' : ' <span class="badge b-err">no combinable sin revisar</span>'}`;
      const cards = rel.map(({ g, gi, nSt }) => `<div class="hcard" data-gi="${gi}">
        <div class="hhead"><label class="chk"><input type="checkbox" data-h="apply" ${g.apply ? 'checked' : ''}> Aplicar</label>
          <label class="of grow2"><span>Desenlace unificado</span><input data-h="name" value="${esc(g.name)}" maxlength="200"></label>
          <label class="of w140"><span>Momento unificado</span><input data-h="tp" value="${esc(g.timepoint)}" maxlength="100"></label>
          <span>${badge(g)}</span></div>
        ${g.concern ? `<div class="flag f-amber">${esc(g.concern)}</div>` : ''}
        <div class="hmem">${g.members.map((i) => { const it = harm.items[i]; return `<div class="sm"><b>${esc(it.study)}</b>: «${esc(it.outcome)}»${it.timepoint ? ' · ' + esc(it.timepoint) : ''}${it.intervention || it.control ? ` <span class="muted">(${esc(it.intervention || '—')} vs ${esc(it.control || '—')})</span>` : ''}</div>`; }).join('')}</div>
      </div>`).join('');
      return `<section class="card" id="harm">${head}
        <p class="muted sm">Propuesta de la IA: <b>${rel.length}</b> grupos para revisar. Corrige nombres y momentos, desmarca los que no quieras aplicar y pulsa «Aplicar». Los nombres originales se conservan en cada fila.</p>
        ${cards || '<p class="muted">Los desenlaces ya están unificados: no hay cambios que proponer.</p>'}
        ${solo.length ? `<p class="muted sm"><b>Sin pareja en otros estudios:</b> ${solo.map(({ g }) => esc(harm.items[g.members[0]].study) + ': «' + esc(g.name) + '»').join('; ')}.</p>` : ''}
        <div class="row"><button class="btn primary" data-act="harm-apply" id="harm-apply-btn">Aplicar ${harmCount()} grupos seleccionados</button><button class="btn" data-act="harm-cancel">Descartar propuesta</button></div></section>`;
    }
    return `<section class="card" id="harm">${head}${intro}<div class="row"><button class="btn primary" data-act="harm-run">Analizar desenlaces</button>${apiKey() ? '' : '<span class="muted sm">Necesitas guardar tu clave de API en la pestaña «Extracción».</span>'}</div></section>`;
  }


  /* --------------- datos para la discusión (solo estudios con datos extraídos) --------------- */
  function discussionInput() {
    const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
    const sts = studies().filter((s) => s.status === 'extracted');
    const val = (s, id) => s.fields?.[id]?.v || '';
    const studiesOut = sts.map((s) => ({
      label: val(s, 'authors_year') || s.label, verified: !!s.verified,
      country: val(s, 'country'), design: val(s, 'design'), n_total: val(s, 'n_total'), population: val(s, 'population'),
      intervention: val(s, 'intervention'), comparator: val(s, 'comparator'), follow_up: val(s, 'follow_up'),
      funding: val(s, 'funding'), authors_conclusion: val(s, 'conclusion'), authors_limitations: val(s, 'limitations'),
    }));
    const lab = (r) => r.label;
    const outcomes = groups().map((g) => {
      const tp = modeTimepoint(g.rows);
      const a = assess(g.rows, { timepoint: tp });
      const pl = a.pooled, nat = (x) => r2(back(a.measure, x));
      return {
        outcome: g.name, timepoint: tp === '(sin especificar)' ? '' : tp, measure: a.measure, studies_combined: a.k, level: a.level, verdict: a.verdict,
        pooled: pl && a.k >= 2 ? { random_effects: { estimate: nat(pl.random.est), ci95_low: nat(pl.random.lo), ci95_high: nat(pl.random.hi) }, fixed_effect: { estimate: nat(pl.fixed.est), ci95_low: nat(pl.fixed.lo), ci95_high: nat(pl.fixed.hi) }, I2_percent: Math.round(pl.I2), Q: r2(pl.Q), df: pl.df, p_heterogeneity: r2(pl.pQ), tau2: r2(pl.tau2) } : null,
        alerts: a.flags.map((f) => f.text),
        rows: g.rows.map((r) => ({
          study: lab(r), verified: r.verified, timepoint: r.row.timepoint || '', comparison: `${r.row.int_label || '—'} vs ${r.row.ctl_label || '—'}`, type: r.row.type || '',
          intervention: { n: r.row.int_n ?? null, mean: r.row.int_mean ?? null, sd: r.row.int_sd ?? null, events: r.row.int_events ?? null },
          control: { n: r.row.ctl_n ?? null, mean: r.row.ctl_mean ?? null, sd: r.row.ctl_sd ?? null, events: r.row.ctl_events ?? null },
          published_effect: { measure: r.row.effect_measure || '', value: r.row.effect ?? null, ci_low: r.row.ci_low ?? null, ci_high: r.row.ci_high ?? null, p: r.row.p_value ?? null },
          notes: String(r.row.notes || '').slice(0, 300),
        })),
      };
    });
    // la etiqueta de cita de cada fila debe coincidir con la del estudio
    const labelOf = new Map(sts.map((s) => [s.label || s.fileName, val(s, 'authors_year') || s.label]));
    outcomes.forEach((o) => o.rows.forEach((r) => { r.study = labelOf.get(r.study) || r.study; }));
    return { studies: studiesOut, outcomes };
  }

  /* ------------------------------- vista: Comparación ------------------------------- */
  const OUT_LEVEL = { green: ['v-green', 'Viable'], amber: ['v-amber', 'Con cautela'], red: ['v-red', 'No viable'] };

  function groups() {
    const g = new Map();
    for (const s of studies()) {
      if (s.status !== 'extracted') continue;
      for (const o of outcomesOf(s)) {
        if (!o.outcome) continue;
        const k = normKey(o.outcome);
        if (!g.has(k)) g.set(k, { key: k, names: {}, rows: [] });
        const e = g.get(k);
        e.names[o.outcome] = (e.names[o.outcome] || 0) + 1;
        e.rows.push({ studyId: s.id, label: s.label || s.fileName, verified: !!s.verified, row: o });
      }
    }
    return [...g.values()].map((e) => ({ ...e, name: Object.entries(e.names).sort((a, b) => b[1] - a[1])[0][0] }))
      .sort((a, b) => new Set(b.rows.map((r) => r.studyId)).size - new Set(a.rows.map((r) => r.studyId)).size || a.name.localeCompare(b.name));
  }
  const modeTimepoint = (rows) => {
    const c = {};
    for (const r of rows) { const t = normKey(r.row.timepoint) || '(sin especificar)'; c[t] = (c[t] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || '*';
  };

  function forestSvg(a) {
    const es = a.used, m = a.measure, p = a.pooled;
    if (!es.length) return '';
    const W = 760, rowH = 24, top = 34, left = 200, right = 160, pw = W - left - right;
    const H = top + (es.length + 2) * rowH + 40;
    const ci = es.map((e) => [e.yi - 1.96 * Math.sqrt(e.vi), e.yi + 1.96 * Math.sqrt(e.vi)]);
    let lo = Math.min(...ci.map((c) => c[0]), p.random.lo, 0), hi = Math.max(...ci.map((c) => c[1]), p.random.hi, 0);
    const pad = (hi - lo) * 0.08 || 0.5; lo -= pad; hi += pad;
    const X = (v) => left + ((v - lo) / (hi - lo)) * pw;
    const ratio = MEASURES[m].ratio;
    const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    const f = (v) => fmtNum(back(m, v), 2);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="Arial,sans-serif" font-size="12" role="img" aria-label="Gráfico de bosque">
      <rect width="${W}" height="${H}" fill="#fff"/><text x="8" y="18" font-weight="700">Estudio</text><text x="${W - right + 10}" y="18" font-weight="700">${m} [IC 95 %]</text>
      <line x1="${X(0)}" x2="${X(0)}" y1="${top - 6}" y2="${H - 34}" stroke="#555" stroke-dasharray="3 3"/>`;
    const wmax = Math.max(...p.weightsRandom);
    es.forEach((e, i) => {
      const y = top + i * rowH + rowH / 2, sz = 4 + 7 * (p.weightsRandom[i] / wmax);
      s += `<text x="8" y="${y + 4}">${esc(String(e.label).slice(0, 30))}</text>
        <line x1="${X(ci[i][0])}" x2="${X(ci[i][1])}" y1="${y}" y2="${y}" stroke="#1f4e79" stroke-width="1.5"/>
        <rect x="${X(e.yi) - sz / 2}" y="${y - sz / 2}" width="${sz}" height="${sz}" fill="#1f4e79"/>
        <text x="${W - right + 10}" y="${y + 4}">${f(e.yi)} [${f(ci[i][0])}; ${f(ci[i][1])}]</text>`;
    });
    const y = top + es.length * rowH + rowH / 2 + 6, r = p.random;
    s += `<text x="8" y="${y + 4}" font-weight="700">Efectos aleatorios</text>
      <polygon points="${X(r.lo)},${y} ${X(r.est)},${y - 8} ${X(r.hi)},${y} ${X(r.est)},${y + 8}" fill="#b26a00"/>
      <text x="${W - right + 10}" y="${y + 4}" font-weight="700">${f(r.est)} [${f(r.lo)}; ${f(r.hi)}]</text>
      <line x1="${left}" x2="${left + pw}" y1="${H - 34}" y2="${H - 34}" stroke="#333"/>`;
    ticks.forEach((t) => { s += `<line x1="${X(t)}" x2="${X(t)}" y1="${H - 34}" y2="${H - 29}" stroke="#333"/><text x="${X(t)}" y="${H - 14}" text-anchor="middle">${f(t)}</text>`; });
    s += `<text x="${left + pw / 2}" y="${H - 1}" text-anchor="middle" fill="#555" font-size="10">${ratio ? 'escala logarítmica; ' : ''}línea discontinua = sin efecto</text></svg>`;
    return s;
  }

  function renderCompare() {
    const sts = studies().filter((s) => s.status === 'extracted');
    const root = $('#tab-body');
    if (!sts.length) { root.innerHTML = '<section class="card"><h2>Comparación</h2><p class="muted">Aún no hay estudios con datos extraídos. Ve a la pestaña «Extracción».</p></section>'; return; }
    const gs = groups();
    const unver = sts.filter((s) => !s.verified).length;
    if (!cmp.outcome || !gs.find((g) => g.key === cmp.outcome)) { cmp.outcome = gs[0]?.key || null; cmp.timepoint = null; cmp.measure = null; }
    const cur = gs.find((g) => g.key === cmp.outcome);

    const overview = gs.map((g) => {
      const a = assess(g.rows, { timepoint: modeTimepoint(g.rows) });
      const [cls, lab] = OUT_LEVEL[a.level];
      return `<tr class="${g.key === cmp.outcome ? 'sel' : ''}"><td><b>${esc(g.name)}</b></td><td>${new Set(g.rows.map((r) => r.studyId)).size}</td><td>${a.k}</td><td>${a.measure || '—'}</td>
        <td>${a.pooled && a.k > 1 ? fmtNum(a.pooled.I2, 0) + ' %' : '—'}</td><td><span class="vdot ${cls}">${lab}</span></td>
        <td><button class="btn sm" data-act="cmp-pick" data-key="${esc(g.key)}">Ver</button></td></tr>`;
    }).join('');

    let detail = '';
    if (cur) {
      const tp = cmp.timepoint || modeTimepoint(cur.rows);
      const a = assess(cur.rows, { timepoint: tp, measure: cmp.measure });
      const [cls, lab] = OUT_LEVEL[a.level];
      const p = a.pooled;
      const tpOpts = ['*', ...(a.timepoints || [])];
      const natural = (x) => fmtNum(back(a.measure, x), 2);
      detail = `<section class="card"><h2>Desenlace: ${esc(cur.name)}</h2>
        <div class="row"><label class="inl">Momento de medida <select data-cmp="timepoint">${tpOpts.map((t) => `<option value="${esc(t)}" ${t === tp ? 'selected' : ''}>${t === '*' ? 'Todos (no recomendado)' : esc(t)}</option>`).join('')}</select></label>
          <label class="inl">Medida del efecto <select data-cmp="measure">${(a.options || []).map((o) => `<option value="${o.measure}" ${o.measure === a.measure ? 'selected' : ''}>${esc(MEASURES[o.measure].label)} · ${o.n} estudios</option>`).join('')}</select></label></div>
        <div class="verdict ${cls}"><span class="vdot ${cls}">${lab}</span> — ${esc(a.verdict)}</div>
        ${a.flags.map((f) => `<div class="flag f-${f.level}">${f.level === 'blue' ? 'ℹ' : '⚠'} ${esc(f.text)}</div>`).join('')}
        ${a.used.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Estudio</th><th>Momento</th><th>Comparador</th><th>Efecto (${a.measure})</th><th>IC 95 %</th><th>Peso (aleat.)</th><th>Origen</th><th></th></tr></thead><tbody>
          ${a.used.map((e, i) => `<tr><td>${esc(e.label)}</td><td>${esc(e.row.timepoint || '—')}</td><td>${esc(e.row.ctl_label || '—')}</td><td>${natural(e.yi)}</td>
            <td>${natural(e.yi - 1.96 * Math.sqrt(e.vi))} a ${natural(e.yi + 1.96 * Math.sqrt(e.vi))}</td><td>${p ? fmtNum(p.weightsRandom[i], 1) + ' %' : ''}</td><td class="muted sm">${e.how}</td><td>${e.verified ? '✓' : '<span class="muted">sin verificar</span>'}</td></tr>`).join('')}
          </tbody></table></div>` : ''}
        ${a.skipped.length ? `<p class="muted sm"><b>No incluidos:</b> ${a.skipped.map((s) => `${esc(s.label)} (${esc(s.why)})`).join('; ')}.</p>` : ''}
        ${p && a.k >= 2 ? `<div class="forest" id="cmp-forest">${forestSvg(a)}</div>
          <div class="tablewrap"><table class="tbl"><tbody>
          <tr><th>Efectos aleatorios (DerSimonian-Laird)</th><td><b>${natural(p.random.est)}</b> (IC 95 %: ${natural(p.random.lo)} a ${natural(p.random.hi)})</td></tr>
          <tr><th>Efecto fijo (varianza inversa)</th><td>${natural(p.fixed.est)} (IC 95 %: ${natural(p.fixed.lo)} a ${natural(p.fixed.hi)})</td></tr>
          <tr><th>Heterogeneidad</th><td>Q = ${fmtNum(p.Q, 2)} (gl = ${p.df}; p ${p.pQ < 0.001 ? '< 0,001' : '= ' + fmtNum(p.pQ, 3)}) · I² = ${fmtNum(p.I2, 0)} % · τ² = ${fmtNum(p.tau2, 3)}</td></tr></tbody></table></div>
          <div class="row"><button class="btn" data-act="cmp-forest-svg">Descargar gráfico (.svg)</button></div>` : ''}
        <p class="muted sm">Cálculo <b>orientativo</b> para decidir si compensa hacer el análisis. Para publicar, repite el análisis con R (metafor/meta) o RevMan. La decisión final de combinar depende también de la similitud clínica y metodológica de los estudios, no solo de I².</p></section>`;
    }

    root.innerHTML = `${harmHtml()}<section class="card"><div class="head"><h2>Características de los estudios</h2><button class="btn sm" data-act="cmp-csv" data-kind="chars">Descargar (.csv)</button></div>
      ${unver ? `<div class="warn">⚠ ${unver} de ${sts.length} estudios aún no están verificados. Comprueba los datos con los artículos antes de sacar conclusiones.</div>` : ''}
      <div class="tablewrap"><table class="tbl wide"><thead><tr><th>Estudio</th>${STUDY_FIELDS.slice(1).map((f) => `<th>${esc(f.label)}</th>`).join('')}<th>Verif.</th></tr></thead><tbody>
      ${sts.map((s) => `<tr><td><b>${esc(s.fields?.authors_year?.v || s.label)}</b></td>${STUDY_FIELDS.slice(1).map((f) => `<td class="cell">${esc(s.fields?.[f.id]?.v || '')}</td>`).join('')}<td>${s.verified ? '✓' : ''}</td></tr>`).join('')}
      </tbody></table></div></section>
      <section class="card"><div class="head"><h2>Desenlaces y viabilidad del metaanálisis</h2><button class="btn sm" data-act="cmp-csv" data-kind="outcomes">Descargar (.csv)</button></div>
      <p class="muted sm">Un desenlace es combinable si varios estudios lo miden de forma comparable y aportan datos utilizables. Si los nombres de un mismo desenlace difieren entre estudios, unifícalos en la pestaña «Extracción».</p>
      <div class="tablewrap"><table class="tbl"><thead><tr><th>Desenlace</th><th>Estudios</th><th>Con datos</th><th>Medida</th><th>I²</th><th>Viabilidad</th><th></th></tr></thead><tbody>${overview}</tbody></table></div></section>${detail}`;
  }

  /* --------------------------------- CSV --------------------------------- */
  const csvCell = (v) => { const t = String(v ?? ''); return /[";\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const csvBlob = (rows) => new Blob(['﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  function csv(kind) {
    const base = ctx.slug(S.cur.data.title);
    const sts = studies().filter((s) => s.status === 'extracted');
    if (kind === 'chars') {
      const rows = [['Estudio', ...STUDY_FIELDS.map((f) => f.label), 'Verificado'], ...sts.map((s) => [s.label, ...STUDY_FIELDS.map((f) => s.fields?.[f.id]?.v || ''), s.verified ? 'sí' : 'no'])];
      return download(csvBlob(rows), `${base}_caracteristicas.csv`);
    }
    const cols = ['outcome', 'timepoint', 'type', 'int_label', 'int_n', 'int_mean', 'int_sd', 'int_events', 'ctl_label', 'ctl_n', 'ctl_mean', 'ctl_sd', 'ctl_events', 'effect_measure', 'effect', 'ci_low', 'ci_high', 'p_value', 'notes', 'page'];
    const rows = [['Estudio', 'Verificado', ...cols], ...sts.flatMap((s) => outcomesOf(s).map((o) => [s.label, s.verified ? 'sí' : 'no', ...cols.map((c) => (OUTCOME_NUM.includes(c) ? showNum(o[c]) : o[c] || ''))]))];
    download(csvBlob(rows), `${base}_desenlaces.csv`);
  }

  /* -------------------------------- acciones -------------------------------- */
  const actions = {
    'ex-pick'() { $('#ex-files')?.click(); },
    async 'ex-testkey'(el) {
      const st = $('#ex-keystate');
      el.disabled = true; st.textContent = 'Comprobando…';
      try { await ping({ apiKey: apiKey(), model: model(), fetchImpl: ctx.fetchImpl }); st.textContent = '✓ La clave funciona con el modelo seleccionado.'; st.style.color = 'var(--ok)'; }
      catch (e) { st.textContent = '✗ ' + e.message; st.style.color = 'var(--err)'; }
      finally { el.disabled = false; }
    },
    'ex-open'(el) { S.exOpen = S.exOpen === el.dataset.sid ? null : el.dataset.sid; patchExtraction(); if (S.exOpen) $('#ex-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    async 'ex-del'(el) {
      const s = S.cur.studies[el.dataset.sid];
      if (!confirm(`¿Eliminar «${s?.label || 'este estudio'}» y todos sus datos extraídos?`)) return;
      delete S.cur.studies[el.dataset.sid];
      if (S.exOpen === el.dataset.sid) S.exOpen = null;
      patchExtraction();
      await fb.deleteDoc(stRef(el.dataset.sid));
    },
    'harm-run'() { runHarm(); },
    'harm-apply'() { applyHarm(); },
    'harm-cancel'() { harmReset(); renderCompare(); },
    'ex-add-o'() { if (S.exOpen) addOutcome(S.exOpen); },
    'ex-rm-o'(el) { if (S.exOpen) removeOutcome(S.exOpen, el.dataset.row); },
    'ex-reextract'() {
      if (!confirm('Volver a extraer sustituirá los datos actuales de este estudio (incluidas tus correcciones). ¿Continuar?')) return;
      if (!apiKey()) return toast('Primero guarda tu clave de API.', 'err');
      $('#ex-refile')?.click();
    },
    'cmp-pick'(el) { cmp.outcome = el.dataset.key; cmp.timepoint = null; cmp.measure = null; renderCompare(); $('#tab-body .verdict')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
    'cmp-csv'(el) { csv(el.dataset.kind); },
    'cmp-forest-svg'() { const svg = $('#cmp-forest svg'); if (svg) download(new Blob([svg.outerHTML], { type: 'image/svg+xml;charset=utf-8' }), `${ctx.slug(S.cur.data.title)}_bosque.svg`); },
  };

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!S.cur?.shell || !t.closest?.('#ex-root')) return;
    if (t.dataset.ex === 'key') { lsSet(KEY_LS, t.value.trim()); $('#ex-keystate').textContent = t.value.trim() ? 'Clave guardada en este navegador.' : 'Sin clave.'; $('#ex-keystate').style.color = ''; return; }
    const sid = S.exOpen;
    if (!sid || !canEdit()) return;
    if (t.dataset.ex === 'label') return edit(sid, ['label'], t.value);
    if (t.dataset.ex === 'instr') return edit(sid, ['instr'], t.value);
    if (t.dataset.ex === 'field') return edit(sid, ['fields', t.dataset.fid, 'v'], t.value);
    const tr = t.closest('[data-oid]');
    if (tr && t.dataset.o) {
      const k = t.dataset.o;
      edit(sid, ['outcomes', tr.dataset.oid, k], OUTCOME_NUM.includes(k) ? toNum(t.value) : t.value);
    }
  });

  document.addEventListener('input', (e) => {
    const t = e.target, h = t.dataset?.h;
    if (!h || harm.status !== 'review') return;
    const g = harm.groups[+t.closest('[data-gi]')?.dataset.gi]; if (!g) return;
    if (h === 'name') g.name = t.value; else if (h === 'tp') g.timepoint = t.value;
    const b = $('#harm-apply-btn'); if (b) b.textContent = `Aplicar ${harmCount()} grupos seleccionados`;
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset?.h === 'apply' && harm.status === 'review') {
      const g = harm.groups[+t.closest('[data-gi]')?.dataset.gi]; if (g) g.apply = t.checked;
      const b = $('#harm-apply-btn'); if (b) b.textContent = `Aplicar ${harmCount()} grupos seleccionados`;
      return;
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!S.cur?.shell) return;
    if (t.dataset?.cmp) { cmp[t.dataset.cmp] = t.value; if (t.dataset.cmp === 'timepoint') cmp.measure = null; renderCompare(); return; }
    if (!t.closest?.('#ex-root')) return;
    if (t.dataset.ex === 'model') { lsSet(MODEL_LS, t.value); return; }
    if (t.id === 'ex-files') { const fs = [...t.files]; t.value = ''; addFiles(fs); return; }
    if (t.id === 'ex-refile') {
      const f = t.files[0]; t.value = '';
      if (!f || !S.exOpen) return;
      if (f.size > MAX_PDF_BYTES) return toast(`El PDF pesa más de ${MAX_PDF_BYTES / 1048576} MB.`, 'err');
      const sid = S.exOpen;
      S.cur.studies[sid].status = 'queued';
      queue.push({ sid, file: f, pid: S.cur.id, replace: true });
      patchExtraction(); runQueue();
      return;
    }
    const sid = S.exOpen;
    if (!sid || !canEdit()) return;
    if (t.dataset.ex === 'verified') {
      const v = t.checked;
      S.cur.studies[sid].verified = v;
      write(sid, { verified: v, verifiedBy: v ? myName() : '' }).then(() => setSaving('saved')).catch((err) => setSaving('error', err));
      S.cur.studies[sid].verifiedBy = v ? myName() : '';
      patchExtraction();
      return;
    }
    const tr = t.closest('[data-oid]');
    if (tr && t.dataset.o === 'type') edit(sid, ['outcomes', tr.dataset.oid, 'type'], t.value);
  });

  return { subscribe, renderExtraction, renderCompare, actions, discussionInput, reset() { harmReset(); queue.length = 0; S.exOpen = null; cmp.outcome = cmp.timepoint = cmp.measure = null; } };
}
