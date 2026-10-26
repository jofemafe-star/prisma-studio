// Pestaña «Discusión» (fase D3): borrador editable de la discusión científica, literatura de contexto y exportación a Word.
import { SECTIONS, discuss, corpusNumbers, checkNumbers, checkCitations } from './discuss-api.js';
import { MODELS, ExtractError } from './extract-api.js';
import { discussionDocxBlob } from './export.js';

const KEY_LS = 'prisma.apikey', MODEL_LS = 'prisma.model';
const ORD = (a, b) => (a.order ?? 0) - (b.order ?? 0);

export function initDiscussion(ctx, ex) {
  const { S, fb, $, $$, esc, toast, canEdit, newId, nest, setSaving, debounced, pend, download, myName } = ctx;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const apiKey = () => lsGet(KEY_LS) || '';
  const model = () => lsGet(MODEL_LS) || MODELS[0].id;
  const gen = { status: 'idle', msg: '' };
  let checkCtx = null; // { corpus, allowed } calculado al pintar

  const ref = (id) => fb.doc(fb.db, 'projects', S.cur.id, 'discussion', id);
  const write = (id, patch) => fb.setDoc(ref(id), { ...patch, updatedAt: fb.serverTimestamp(), updatedByName: myName() }, { merge: true });
  const D = () => (S.cur.discussion ||= { main: {}, refs: {} });
  const sectionsOf = () => Object.entries(D().main?.sections || {}).map(([id, s]) => ({ id, ...s })).sort(ORD);
  const refsOf = () => Object.entries(D().refs?.items || {}).map(([id, r]) => ({ id, ...r })).sort(ORD);
  function setPath(o, path, v) { let c = o; for (let i = 0; i < path.length - 1; i++) c = c[path[i]] ??= {}; c[path[path.length - 1]] = v; }

  /* ------------------------------ suscripción ------------------------------ */
  function subscribe(cur, errH) {
    cur.discussion = { main: {}, refs: {} };
    S.unsubProj.push(fb.onSnapshot(fb.collection(fb.db, 'projects', cur.id, 'discussion'), (snap) => {
      if (S.cur !== cur) return;
      snap.docs.forEach((d) => { cur.discussion[d.id] = d.data(); });
      for (const p of Object.values(pend)) if (p.kind === 'dc') setPath(cur.discussion[p.doc] ||= {}, p.path, p.value);
      if (S.tab === 'discuss') patch();
    }, errH));
  }

  function edit(docId, path, value) {
    setPath(D()[docId] ||= {}, path, value);
    const key = `dc:${docId}:${path.join('.')}`;
    pend[key] = { kind: 'dc', doc: docId, path, value };
    debounced(key, async () => {
      await write(docId, nest(path, value));
      if (pend[key]?.value === value) delete pend[key];
    });
  }

  /* ------------------------------ comprobaciones ------------------------------ */
  function buildCheckCtx() {
    const input = ex.discussionInput();
    const refs = refsOf();
    const labels = [...input.studies.map((s) => s.label), ...refs.map((r) => r.label)].filter(Boolean);
    return { input, labels, corpus: corpusNumbers(input, refs.map((r) => `${r.citation} ${r.text}`).join(' ')) };
  }
  const checksHtml = (text) => {
    if (!checkCtx) return '';
    const nums = checkNumbers(text, checkCtx.corpus), cites = checkCitations(text, checkCtx.labels);
    return (nums.length ? `<div class="flag f-amber">Cifras que no aparecen en los datos de la revisión: <b>${nums.map(esc).join(', ')}</b>. Compruébalas o corrígelas.</div>` : '')
      + (cites.length ? `<div class="flag f-amber">Citas que no corresponden a ningún estudio incluido ni a una referencia aportada: <b>${cites.map(esc).join('; ')}</b>.</div>` : '');
  };

  /* ------------------------------ generación ------------------------------ */
  async function generate() {
    if (!canEdit()) return;
    if (!apiKey()) { toast('Primero guarda tu clave de API en la pestaña «Extracción».', 'err'); return; }
    const payload = ex.discussionInput();
    if (!payload.studies.length) { toast('No hay estudios con datos extraídos.', 'err'); return; }
    if (sectionsOf().length && !confirm('Ya hay un borrador. Generar uno nuevo sustituirá TODAS las secciones actuales, incluidas tus ediciones. ¿Continuar?')) return;
    const cur = S.cur;
    payload.review = { title: cur.data?.title || '', extraction_instructions: cur.data?.meta?.exInstr || '' };
    gen.status = 'running'; gen.msg = ''; render();
    try {
      const out = await discuss({ apiKey: apiKey(), model: model(), payload, refs: refsOf(), guide: D().main?.guide || '', fetchImpl: ctx.fetchImpl });
      if (S.cur !== cur) return;
      const old = D().main?.sections || {}, sections = {};
      for (const id of Object.keys(old)) sections[id] = fb.deleteField();
      for (const s of out.sections) sections[s.id] = { title: s.title, text: s.text, order: s.order };
      const meta = { model: out.model, generatedAtMs: Date.now(), warnings: out.warnings, basis: { studies: payload.studies.length, verified: payload.studies.filter((s) => s.verified).length, outcomes: payload.outcomes.length } };
      D().main = { ...(D().main || {}), sections: Object.fromEntries(out.sections.map((s) => [s.id, { title: s.title, text: s.text, order: s.order }])), ...meta };
      for (const k of Object.keys(pend)) if (k.startsWith('dc:main:sections')) delete pend[k];
      await write('main', { sections, ...meta });
      gen.status = 'idle';
      toast('Borrador generado. Revísalo y edítalo antes de usarlo.', 'ok');
    } catch (e) {
      if (S.cur !== cur) return;
      gen.status = 'error'; gen.msg = e instanceof ExtractError ? e.message : (e?.message || String(e));
    }
    if (S.tab === 'discuss') render();
  }

  /* ------------------------------ referencias ------------------------------ */
  function addRef() {
    const id = newId('r'), row = { label: '', citation: '', text: '', order: Date.now() };
    ((D().refs ||= {}).items ||= {})[id] = row;
    render(); $(`[data-rid="${id}"] [data-d="label"]`)?.focus();
    setSaving('saving');
    write('refs', { items: { [id]: row } }).then(() => setSaving('saved')).catch((e) => setSaving('error', e));
  }
  function removeRef(id) {
    delete D().refs?.items?.[id];
    for (const k of Object.keys(pend)) if (k.startsWith(`dc:refs:items.${id}`)) delete pend[k];
    render(); setSaving('saving');
    write('refs', { items: { [id]: fb.deleteField() } }).then(() => setSaving('saved')).catch((e) => setSaving('error', e));
  }

  /* ------------------------------ vista ------------------------------ */
  const rowsFor = (t) => Math.max(5, Math.min(24, Math.ceil(String(t || '').length / 105) + String(t || '').split('\n').length));
  const sig = () => JSON.stringify([sectionsOf().map((s) => s.id), refsOf().map((r) => r.id), gen.status, canEdit(), !!apiKey()]);

  function html() {
    const ro = canEdit() ? '' : 'disabled';
    const input = checkCtx.input, nStud = input.studies.length, nVer = input.studies.filter((s) => s.verified).length;
    const main = D().main || {}, secs = sectionsOf(), refs = refsOf();
    const head = `<section class="card"><h2>Discusión científica (borrador asistido por IA)</h2>
      <p class="muted sm">La IA redacta un <b>borrador</b> de la discusión a partir de los datos extraídos de tus estudios (resumen de hallazgos, concordancias y discrepancias, heterogeneidad, limitaciones e implicaciones) y de la literatura que aportes abajo. <b>Solo cita los estudios incluidos y las referencias que añadas</b>; las cifras proceden de las tablas. Debes revisarlo y editarlo: es un punto de partida, no un texto final.</p>
      ${nStud ? `<p class="sm">Base del borrador: <b>${nStud}</b> estudios con datos extraídos (<b>${nVer}</b> verificados) y <b>${input.outcomes.length}</b> desenlaces.</p>` : '<div class="warn">Aún no hay estudios con datos extraídos. Ve a «Extracción».</div>'}
      ${nStud && nVer < nStud ? `<div class="warn">⚠ ${nStud - nVer} de ${nStud} estudios no están verificados: el borrador se apoyaría en datos sin comprobar.</div>` : ''}</section>`;
    const refCards = refs.map((r) => `<div class="hcard" data-rid="${r.id}">
        <div class="hhead"><label class="of w140"><span>Etiqueta de cita</span><input data-d="label" value="${esc(r.label)}" maxlength="60" placeholder="Autor Año" ${ro}></label>
          <label class="of grow2"><span>Referencia completa</span><input data-d="citation" value="${esc(r.citation)}" maxlength="500" ${ro}></label>
          ${ro ? '' : `<button class="btn sm danger" data-act="dc-rm-ref" data-rid="${r.id}" title="Quitar">×</button>`}</div>
        <label class="of"><span>Resumen o hallazgos clave (pega el abstract o los resultados que debe tener en cuenta)</span><textarea data-d="text" rows="3" maxlength="3000" ${ro}>${esc(r.text)}</textarea></label></div>`).join('');
    const litCard = `<section class="card" id="dc-refs"><h2>Literatura de contexto <span class="muted sm">(opcional)</span></h2>
      <p class="muted sm">Añade artículos externos a tu revisión con los que quieras comparar tus resultados. La IA solo conocerá lo que escribas aquí y solo los citará con la etiqueta que indiques. Sin literatura aportada, se omite la sección de comparación con la literatura.</p>
      ${refCards || '<p class="muted sm">Sin referencias añadidas.</p>'}${ro ? '' : '<div class="row"><button class="btn" data-act="dc-add-ref">+ Añadir referencia</button></div>'}</section>`;
    const genCard = !canEdit() ? '' : `<section class="card" id="dc-gen"><h2>Generar borrador</h2>
      <label>Instrucciones para la redacción <span class="muted sm">(opcional: enfoque, extensión, aspectos a destacar)</span>
        <textarea data-d="guide" rows="2" maxlength="3000" placeholder="Ejemplo: enfatiza las implicaciones para la práctica clínica en pacientes edéntulos; tono prudente.">${esc(main.guide || '')}</textarea></label>
      ${gen.status === 'running' ? '<p class="muted">Redactando el borrador… puede tardar entre 30 segundos y un par de minutos.</p>' : ''}
      ${gen.status === 'error' ? `<div class="warn">⚠ ${esc(gen.msg)}</div>` : ''}
      <div class="row"><button class="btn primary" data-act="dc-generate" ${gen.status === 'running' || !nStud ? 'disabled' : ''}>${secs.length ? 'Volver a generar el borrador' : 'Generar borrador'}</button>
        ${apiKey() ? '' : '<span class="muted sm">Necesitas guardar tu clave de API en la pestaña «Extracción».</span>'}</div></section>`;
    const draft = secs.length ? `<section class="card" id="dc-draft"><div class="head"><h2>Borrador</h2><span class="row">
        <button class="btn sm" data-act="dc-copy">Copiar texto</button><button class="btn sm primary" data-act="dc-docx">Descargar Word (.docx)</button></span></div>
      <p class="muted sm">Generado con ${esc(main.model || 'IA')}${main.generatedAtMs ? ' el ' + new Date(main.generatedAtMs).toLocaleString('es-ES') : ''}. Edita libremente: los cambios se guardan solos. Los avisos amarillos son comprobaciones automáticas de cifras y citas.</p>
      ${(main.warnings || []).length ? `<div class="flag f-amber"><b>Avisos de la IA:</b><ul>${main.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
      ${secs.map((s) => `<div class="dsec" data-sec="${s.id}"><h3>${esc(s.title)}</h3><textarea data-d="sec" rows="${rowsFor(s.text)}" ${ro}>${esc(s.text || '')}</textarea><div class="dchk">${checksHtml(s.text || '')}</div></div>`).join('')}
      <p class="muted sm"><i>Borrador redactado con asistencia de IA a partir de los datos extraídos. Revísalo y declara su uso según la política de la revista.</i></p></section>` : '';
    return head + litCard + genCard + draft;
  }

  function render() {
    const root = $('#tab-body');
    if (!root) return;
    checkCtx = buildCheckCtx();
    root.innerHTML = `<div id="dc-root" data-sig="${esc(sig())}">${html()}</div>`;
  }
  // actualización por cambios remotos: no pisa lo que se está escribiendo
  function patch() {
    const r = $('#dc-root');
    if (!r || r.dataset.sig !== sig()) return render();
    checkCtx = buildCheckCtx();
    const setv = (el, v) => { if (el && document.activeElement !== el && el.value !== v) el.value = v; };
    setv($('[data-d="guide"]', r), D().main?.guide || '');
    $$('[data-sec]', r).forEach((d) => { const s = D().main?.sections?.[d.dataset.sec]; setv($('textarea', d), s?.text || ''); });
    $$('[data-rid]', r).forEach((d) => { const x = D().refs?.items?.[d.dataset.rid] || {}; $$('[data-d]', d).forEach((el) => setv(el, x[el.dataset.d] || '')); });
  }

  /* ------------------------------ acciones ------------------------------ */
  const plainText = () => {
    const secs = sectionsOf();
    return secs.map((s) => `${s.title}\n\n${s.text}`).join('\n\n');
  };
  const actions = {
    'dc-generate'() { generate(); },
    'dc-add-ref'() { if (canEdit()) addRef(); },
    'dc-rm-ref'(el) { if (canEdit()) removeRef(el.dataset.rid); },
    async 'dc-copy'() {
      try { await navigator.clipboard.writeText(plainText()); toast('Texto copiado al portapapeles.', 'ok'); }
      catch { toast('No se pudo copiar automáticamente: selecciona el texto y cópialo a mano.', 'err'); }
    },
    async 'dc-docx'() {
      try {
        const input = (checkCtx || buildCheckCtx()).input;
        const blob = await discussionDocxBlob({ title: S.cur.data?.title || '', sections: sectionsOf(), studies: input.studies, refs: refsOf().filter((r) => r.citation) });
        download(blob, `${ctx.slug(S.cur.data?.title || 'revision')}_discusion.docx`);
      } catch (e) { toast('No se pudo generar el Word: ' + (e?.message || e), 'err'); }
    },
  };

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!S.cur?.shell || !t.closest?.('#dc-root') || !canEdit()) return;
    const k = t.dataset.d;
    if (k === 'guide') return edit('main', ['guide'], t.value);
    if (k === 'sec') {
      const d = t.closest('[data-sec]'); edit('main', ['sections', d.dataset.sec, 'text'], t.value);
      const c = $('.dchk', d); if (c) c.innerHTML = checksHtml(t.value);
      return;
    }
    const card = t.closest('[data-rid]');
    if (card && k) edit('refs', ['items', card.dataset.rid, k], t.value);
  });

  return { subscribe, render, patch, actions, reset() { gen.status = 'idle'; gen.msg = ''; checkCtx = null; } };
}
