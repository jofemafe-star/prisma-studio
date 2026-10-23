// Lógica pura del diagrama de flujo PRISMA 2020 (bases de datos y registros).
// Sin dependencias: se puede probar en Node y se usa igual en el navegador.

export const num = (v) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export const emptyFlow = () => ({
  sources: {},          // { id: { type:'database'|'register', name, n, date, order } }
  duplicates: 0,
  automation: 0,
  otherRemoved: 0,
  excludedScreening: 0,
  notRetrieved: 0,
  reportsIncluded: 0,
  reasons: {},          // { id: { text, n, order } }
});

export const listOf = (map) =>
  Object.entries(map || {})
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => (a.order || 0) - (b.order || 0));

export function compute(flow) {
  const f = { ...emptyFlow(), ...(flow || {}) };
  const sources = listOf(f.sources);
  const dbs = sources.filter((s) => s.type !== 'register');
  const regs = sources.filter((s) => s.type === 'register');
  const sum = (a) => a.reduce((t, s) => t + num(s.n), 0);

  const nDb = sum(dbs);
  const nReg = sum(regs);
  const identified = nDb + nReg;

  const duplicates = num(f.duplicates);
  const automation = num(f.automation);
  const otherRemoved = num(f.otherRemoved);
  const removed = duplicates + automation + otherRemoved;

  const screenedRaw = identified - removed;
  const screened = Math.max(0, screenedRaw);
  const excludedScreening = num(f.excludedScreening);
  const soughtRaw = screened - excludedScreening;
  const sought = Math.max(0, soughtRaw);
  const notRetrieved = num(f.notRetrieved);
  const assessedRaw = sought - notRetrieved;
  const assessed = Math.max(0, assessedRaw);
  const reasons = listOf(f.reasons);
  const excludedFT = sum(reasons);
  const includedRaw = assessed - excludedFT;
  const included = Math.max(0, includedRaw);
  const reportsIncluded = num(f.reportsIncluded);

  const warnings = [];
  if (identified === 0) warnings.push('Aún no hay registros identificados: añade al menos una base de datos o registro.');
  if (screenedRaw < 0) warnings.push('Los registros eliminados antes del cribado superan los registros identificados.');
  if (soughtRaw < 0) warnings.push('Los registros excluidos en el cribado superan los registros cribados.');
  if (assessedRaw < 0) warnings.push('Los informes no recuperados superan los informes solicitados.');
  if (includedRaw < 0) warnings.push('Los informes excluidos (suma de motivos) superan los informes evaluados.');
  if (included > 0 && reportsIncluded > 0 && reportsIncluded < included)
    warnings.push('Los informes de estudios incluidos no pueden ser menos que los estudios incluidos.');
  if (included > 0 && reportsIncluded === 0)
    warnings.push('Indica cuántos informes corresponden a los estudios incluidos.');
  if (sources.some((s) => !String(s.name || '').trim())) warnings.push('Hay fuentes de información sin nombre.');
  if (reasons.some((r) => !String(r.text || '').trim() && num(r.n) > 0))
    warnings.push('Hay motivos de exclusión con número pero sin descripción.');

  return {
    sources, dbs, regs, nDb, nReg, identified,
    duplicates, automation, otherRemoved, removed,
    screened, excludedScreening, sought, notRetrieved, assessed,
    reasons, excludedFT, included, reportsIncluded, warnings,
  };
}

/* ------------------------------ SVG ------------------------------ */

const LBL = {
  en: {
    title: 'Identification of studies via databases and registers',
    bands: ['Identification', 'Screening', 'Included'],
    identifiedFrom: 'Records identified from*:', databases: 'Databases', registers: 'Registers',
    removedBefore: 'Records removed before screening:',
    dup: 'Duplicate records removed', auto: 'Records marked as ineligible by automation tools',
    other: 'Records removed for other reasons',
    screened: 'Records screened', excluded: 'Records excluded**',
    sought: 'Reports sought for retrieval', notRetrieved: 'Reports not retrieved',
    assessed: 'Reports assessed for eligibility', reportsExcluded: 'Reports excluded:',
    reason: 'Reason', noReason: 'No reasons recorded',
    included: 'Studies included in review', reportsIncluded: 'Reports of included studies',
    fn1: '* Consider, if feasible to do so, reporting the number of records identified from each database or register searched (rather than the total number across all databases/registers).',
    fn2: '** If automation tools were used, indicate how many records were excluded by a human and how many were excluded by automation tools.',
    source: 'Source: Page MJ, et al. BMJ 2021;372:n71. doi: 10.1136/bmj.n71. This work is licensed under CC BY 4.0. To view a copy of this license, visit https://creativecommons.org/licenses/by/4.0/',
  },
  es: {
    title: 'Identificación de estudios a través de bases de datos y registros',
    bands: ['Identificación', 'Cribado', 'Incluidos'],
    identifiedFrom: 'Registros identificados desde*:', databases: 'Bases de datos', registers: 'Registros',
    removedBefore: 'Registros eliminados antes del cribado:',
    dup: 'Registros duplicados eliminados', auto: 'Registros marcados como no elegibles por herramientas de automatización',
    other: 'Registros eliminados por otras razones',
    screened: 'Registros cribados', excluded: 'Registros excluidos**',
    sought: 'Informes solicitados para su recuperación', notRetrieved: 'Informes no recuperados',
    assessed: 'Informes evaluados para su elegibilidad', reportsExcluded: 'Informes excluidos:',
    reason: 'Motivo', noReason: 'Sin motivos registrados',
    included: 'Estudios incluidos en la revisión', reportsIncluded: 'Informes de los estudios incluidos',
    fn1: '* Si es factible, considere indicar el número de registros identificados en cada base de datos o registro consultado (en lugar del total de todas las bases de datos/registros).',
    fn2: '** Si se utilizaron herramientas de automatización, indique cuántos registros fueron excluidos por una persona y cuántos por las herramientas de automatización.',
    source: 'Fuente: Page MJ, et al. BMJ 2021;372:n71. doi: 10.1136/bmj.n71. Diagrama adaptado; obra bajo licencia CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).',
  },
};

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function wrapText(text, max) {
  // Solo se parte en espacios normales: el espacio duro de "(n = 12)" evita separar el número.
  const words = String(text ?? '').split(/ +/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= max) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  const out = lines.flatMap((l) => (l.length > max ? l.match(new RegExp(`.{1,${max}}`, 'g')) : [l]));
  return out.length ? out : [''];
}

export function flowSvg(c, lang = 'es') {
  const t = LBL[lang] || LBL.es;
  const W = 900, LH = 18, PAD = 10, GAP = 34, BAND = 40;
  const L = { x: 70, w: 360 }, R = { x: 490, w: 380 };
  const COL = '#1f4e79', FILL = '#e8f0fa';
  const n = (v) => `(n = ${v})`;
  const ln = (txt, o = {}) => ({ t: txt, ...o });

  const A = [ln(t.identifiedFrom, { b: 1 }), ln(`${t.databases} ${n(c.nDb)}`)];
  c.dbs.forEach((s) => A.push(ln(`${s.name || '—'} ${n(num(s.n))}`, { i: 1 })));
  A.push(ln(`${t.registers} ${n(c.nReg)}`));
  c.regs.forEach((s) => A.push(ln(`${s.name || '—'} ${n(num(s.n))}`, { i: 1 })));
  const B = [ln(t.removedBefore, { b: 1 }), ln(`${t.dup} ${n(c.duplicates)}`),
    ln(`${t.auto} ${n(c.automation)}`), ln(`${t.other} ${n(c.otherRemoved)}`)];
  const C = [ln(`${t.screened} ${n(c.screened)}`, { b: 1 })];
  const D = [ln(`${t.excluded} ${n(c.excludedScreening)}`)];
  const E = [ln(`${t.sought} ${n(c.sought)}`, { b: 1 })];
  const F = [ln(`${t.notRetrieved} ${n(c.notRetrieved)}`)];
  const G = [ln(`${t.assessed} ${n(c.assessed)}`, { b: 1 })];
  const H = [ln(t.reportsExcluded, { b: 1 })];
  if (c.reasons.length)
    c.reasons.forEach((r, k) => H.push(ln(`${r.text || `${t.reason} ${k + 1}`} ${n(num(r.n))}`, { i: 1 })));
  else H.push(ln(`${t.noReason} ${n(0)}`, { i: 1 }));
  const I = [ln(`${t.included} ${n(c.included)}`, { b: 1 }), ln(`${t.reportsIncluded} ${n(c.reportsIncluded)}`, { b: 1 })];

  const layout = (col, lines) => {
    const rows = [];
    for (const l of lines) {
      const ind = l.i ? 14 : 0;
      const cw = l.b ? 6.9 : 6.3;
      const max = Math.max(8, Math.floor((col.w - 2 * PAD - ind) / cw));
      wrapText(l.t, max).forEach((p) => rows.push({ t: p, b: l.b, ind }));
    }
    return { x: col.x, w: col.w, rows, h: rows.length * LH + 2 * PAD };
  };
  const draw = (bx, y) => {
    let s = `<rect x="${bx.x}" y="${y}" width="${bx.w}" height="${bx.h}" fill="${FILL}" stroke="${COL}" stroke-width="1.2"/>`;
    bx.rows.forEach((r, k) => {
      s += `<text x="${bx.x + PAD + r.ind}" y="${y + PAD + LH * (k + 1) - 5}" font-weight="${r.b ? 700 : 400}">${esc(r.t)}</text>`;
    });
    return s;
  };

  const defs = [[A, B], [C, D], [E, F], [G, H], [I, null]].map(([l, r]) => ({
    lb: layout(L, l), rb: r ? layout(R, r) : null,
  }));
  let y = 46;
  defs.forEach((d) => { d.y = y; d.h = Math.max(d.lb.h, d.rb ? d.rb.h : 0); y += d.h + GAP; });

  let body = '';
  defs.forEach((d, k) => {
    body += draw(d.lb, d.y);
    if (d.rb) {
      body += draw(d.rb, d.y);
      const ay = d.y + Math.min(d.lb.h, d.rb.h) / 2;
      body += `<line x1="${L.x + L.w}" y1="${ay}" x2="${R.x - 2}" y2="${ay}" stroke="${COL}" stroke-width="1.5" marker-end="url(#ah)"/>`;
    }
    if (k < defs.length - 1) {
      const cx = L.x + L.w / 2;
      body += `<line x1="${cx}" y1="${d.y + d.lb.h}" x2="${cx}" y2="${defs[k + 1].y - 2}" stroke="${COL}" stroke-width="1.5" marker-end="url(#ah)"/>`;
    }
  });

  const bottom = (k) => defs[k].y + defs[k].h;
  const b0 = [34, bottom(0) + GAP / 2 - 2];
  const b1 = [b0[1] + 4, bottom(3) + GAP / 2 - 2];
  const b2 = [b1[1] + 4, bottom(4) + 12];
  const band = (yy, label) =>
    `<rect x="10" y="${yy[0]}" width="${BAND}" height="${yy[1] - yy[0]}" fill="${COL}" rx="3"/>` +
    `<text transform="translate(${10 + BAND / 2 + 5},${(yy[0] + yy[1]) / 2}) rotate(-90)" text-anchor="middle" fill="#ffffff" font-weight="700" font-size="14">${esc(label)}</text>`;
  const bands = band(b0, t.bands[0]) + band(b1, t.bands[1]) + band(b2, t.bands[2]);

  const foot = [...wrapText(t.fn1, 150), ...wrapText(t.fn2, 150), ...wrapText(t.source, 150)];
  const fy = b2[1] + 22;
  const footSvg = foot.map((l, k) => `<text x="10" y="${fy + k * 14}" font-size="10.5" fill="#333333">${esc(l)}</text>`).join('');
  const H_TOTAL = fy + foot.length * 14 + 8;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H_TOTAL}" width="${W}" height="${H_TOTAL}" ` +
    `font-family="Arial, Helvetica, sans-serif" font-size="12.5" fill="#111111">` +
    `<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">` +
    `<path d="M0 0L10 5L0 10z" fill="${COL}"/></marker></defs>` +
    `<rect width="${W}" height="${H_TOTAL}" fill="#ffffff"/>` +
    `<text x="${L.x}" y="24" font-size="15" font-weight="700">${esc(t.title)}</text>` +
    bands + body + footSvg + `</svg>`
  );
}
