// Cálculo de tamaños del efecto y combinación (metaanálisis orientativo). Lógica pura, sin DOM.
// Uso previsto: ayudar a decidir si un desenlace es combinable. No sustituye a R (metafor/meta) ni a RevMan.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const nz = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const Z975 = 1.959963984540054;

export const MEASURES = {
  MD: { label: 'Diferencia de medias (MD)', ratio: false },
  SMD: { label: 'Diferencia de medias estandarizada (g de Hedges)', ratio: false },
  RR: { label: 'Riesgo relativo (RR)', ratio: true },
  OR: { label: 'Odds ratio (OR)', ratio: true },
  HR: { label: 'Hazard ratio (HR)', ratio: true },
};

/* -------- distribución chi-cuadrado (cola superior) para el p-valor de Q -------- */
function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, t = x + 5.5;
  t -= (x + 0.5) * Math.log(t);
  let s = 1.000000000190015;
  for (const k of c) s += k / ++y;
  return -t + Math.log((2.5066282746310005 * s) / x);
}
function gammaPLower(a, x) { // P(a,x) regularizada
  if (x <= 0) return 0;
  if (x < a + 1) {
    let ap = a, sum = 1 / a, del = sum;
    for (let n = 0; n < 500; n++) { ap += 1; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return sum * Math.exp(-x + a * Math.log(x) - gammaln(a));
  }
  let b = x + 1 - a, c = 1 / 1e-300, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gammaln(a)) * h;
}
export const chi2sf = (x, df) => (df <= 0 || x <= 0 ? 1 : 1 - gammaPLower(df / 2, x / 2));

/* ------------------------ tamaño del efecto de una fila ------------------------ */
// fila = datos de un desenlace de un estudio (campos numéricos o null). Devuelve {yi, vi} en escala de análisis
// (logaritmo para RR/OR/HR) o null si no hay datos suficientes para esa medida.
export function effectOf(row, measure) {
  const type = row.type;
  const n1 = nz(row.int_n), n2 = nz(row.ctl_n);
  if (measure === 'MD' || measure === 'SMD') {
    const m1 = nz(row.int_mean), m2 = nz(row.ctl_mean), s1 = nz(row.int_sd), s2 = nz(row.ctl_sd);
    if (type !== 'continuous' && type !== undefined && type !== null && type !== 'other') {
      // un desenlace dicotómico no se combina como media
      if (type === 'dichotomous') return null;
    }
    if ([n1, n2, m1, m2, s1, s2].every(isNum) && n1 > 1 && n2 > 1 && s1 >= 0 && s2 >= 0) {
      if (measure === 'MD') return { yi: m1 - m2, vi: (s1 * s1) / n1 + (s2 * s2) / n2, how: 'datos brutos' };
      const df = n1 + n2 - 2, sp = Math.sqrt(((n1 - 1) * s1 * s1 + (n2 - 1) * s2 * s2) / df);
      if (!(sp > 0)) return null;
      const J = 1 - 3 / (4 * df - 1), g = (J * (m1 - m2)) / sp;
      return { yi: g, vi: (n1 + n2) / (n1 * n2) + (g * g) / (2 * (n1 + n2)), how: 'datos brutos' };
    }
  } else if (measure === 'RR' || measure === 'OR') {
    let a = nz(row.int_events), c = nz(row.ctl_events);
    if ([n1, n2, a, c].every(isNum) && n1 > 0 && n2 > 0 && a >= 0 && c >= 0 && a <= n1 && c <= n2) {
      let b = n1 - a, d = n2 - c, N1 = n1, N2 = n2;
      if (a === 0 || b === 0 || c === 0 || d === 0) { a += 0.5; b += 0.5; c += 0.5; d += 0.5; N1 += 1; N2 += 1; }
      if (measure === 'RR') return { yi: Math.log(a / N1 / (c / N2)), vi: 1 / a - 1 / N1 + 1 / c - 1 / N2, how: 'datos brutos' };
      return { yi: Math.log((a * d) / (b * c)), vi: 1 / a + 1 / b + 1 / c + 1 / d, how: 'datos brutos' };
    }
  }
  // efecto + IC publicados (varianza inversa genérica), solo si la medida coincide
  const em = String(row.effect_measure || '').toUpperCase().trim();
  const eff = nz(row.effect), lo = nz(row.ci_low), hi = nz(row.ci_high);
  if (em === measure && [eff, lo, hi].every(isNum)) {
    if (MEASURES[measure].ratio) {
      if (eff > 0 && lo > 0 && hi > lo) return { yi: Math.log(eff), vi: ((Math.log(hi) - Math.log(lo)) / (2 * Z975)) ** 2, how: 'efecto e IC publicados' };
    } else if (hi > lo) return { yi: eff, vi: ((hi - lo) / (2 * Z975)) ** 2, how: 'efecto e IC publicados' };
  }
  return null;
}

/* ------------------------------- combinación ------------------------------- */
export function pool(effects) {
  const es = effects.filter((e) => e && isNum(e.yi) && isNum(e.vi) && e.vi > 0);
  const k = es.length;
  if (k === 0) return null;
  const w = es.map((e) => 1 / e.vi), sw = w.reduce((a, b) => a + b, 0);
  const fixed = es.reduce((s, e, i) => s + w[i] * e.yi, 0) / sw;
  const Q = es.reduce((s, e, i) => s + w[i] * (e.yi - fixed) ** 2, 0);
  const df = k - 1;
  const sw2 = w.reduce((a, b) => a + b * b, 0);
  const C = sw - sw2 / sw;
  const tau2 = k > 1 && C > 0 ? Math.max(0, (Q - df) / C) : 0;
  const wr = es.map((e) => 1 / (e.vi + tau2)), swr = wr.reduce((a, b) => a + b, 0);
  const random = es.reduce((s, e, i) => s + wr[i] * e.yi, 0) / swr;
  const seF = Math.sqrt(1 / sw), seR = Math.sqrt(1 / swr);
  const I2 = k > 1 && Q > 0 ? Math.max(0, (Q - df) / Q) * 100 : 0;
  return {
    k, Q, df, pQ: k > 1 ? chi2sf(Q, df) : null, I2, tau2,
    fixed: { est: fixed, se: seF, lo: fixed - Z975 * seF, hi: fixed + Z975 * seF },
    random: { est: random, se: seR, lo: random - Z975 * seR, hi: random + Z975 * seR },
    weightsFixed: w.map((x) => (100 * x) / sw), weightsRandom: wr.map((x) => (100 * x) / swr),
  };
}

// pasa de la escala de análisis (log) a la escala natural
export const back = (measure, x) => (MEASURES[measure]?.ratio ? Math.exp(x) : x);

/* --------------------------- viabilidad de un desenlace --------------------------- */
export const normKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// rows: [{studyId, label, verified, row}] (una fila por estudio y desenlace). opts: {measure, timepoint}
export function assess(rows, opts = {}) {
  const out = { measure: null, k: 0, used: [], skipped: [], flags: [], level: 'red', verdict: '', pooled: null, options: [] };
  if (!rows.length) { out.verdict = 'Sin datos para este desenlace.'; return out; }

  // medidas posibles según los datos disponibles
  const counts = {};
  for (const m of Object.keys(MEASURES)) counts[m] = rows.filter((r) => effectOf(r.row, m)).length;
  out.options = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ measure: m, n }));
  const measure = opts.measure && counts[opts.measure] ? opts.measure : out.options[0]?.measure || null;
  out.measure = measure;

  // momentos de medida
  const tps = [...new Set(rows.map((r) => normKey(r.row.timepoint) || '(sin especificar)'))];
  out.timepoints = tps;
  let sel = rows;
  if (opts.timepoint && opts.timepoint !== '*') sel = rows.filter((r) => (normKey(r.row.timepoint) || '(sin especificar)') === opts.timepoint);

  if (!measure) {
    out.verdict = 'No viable: ningún estudio aporta datos utilizables (faltan medias/DE/n o eventos/n, o el efecto con su IC).';
    out.skipped = sel.map((r) => ({ label: r.label, why: 'datos incompletos' }));
    return out;
  }

  const seen = new Set();
  const effs = [];
  for (const r of sel) {
    const e = effectOf(r.row, measure);
    if (!e) { out.skipped.push({ label: r.label, why: 'datos insuficientes para ' + measure }); continue; }
    if (seen.has(r.studyId)) { out.skipped.push({ label: r.label, why: 'varias filas del mismo estudio (no independientes): se usa solo la primera' }); continue; }
    seen.add(r.studyId);
    effs.push({ ...e, label: r.label, studyId: r.studyId, verified: r.verified, row: r.row });
  }
  out.used = effs;
  out.k = effs.length;
  out.pooled = pool(effs);

  // señales de alarma
  const unver = effs.filter((e) => !e.verified).length;
  if (unver) out.flags.push({ level: 'amber', text: `${unver} de ${effs.length} estudios aún sin verificar manualmente: revisa los datos antes de combinar.` });
  if (opts.timepoint === '*' && tps.length > 1) out.flags.push({ level: 'amber', text: `Hay ${tps.length} momentos de medida distintos (${tps.join(' · ')}); elige uno para no mezclar seguimientos.` });
  const cmp = new Set(effs.map((e) => normKey(e.row.ctl_label)).filter(Boolean));
  if (cmp.size > 1) out.flags.push({ level: 'amber', text: `Comparadores distintos entre estudios (${[...cmp].join(' · ')}): decide si son clínicamente comparables.` });
  const how = new Set(effs.map((e) => e.how));
  if (how.size > 1) out.flags.push({ level: 'blue', text: 'Se mezclan estudios con datos brutos y con efecto/IC publicados (ambos son válidos con varianza inversa).' });
  if (out.skipped.some((s) => s.why.startsWith('varias filas'))) out.flags.push({ level: 'amber', text: 'Hay estudios con varias filas para este desenlace (p. ej. varios brazos o momentos): no se combinan sin ajuste.' });

  const p = out.pooled;
  if (out.k < 2) {
    out.level = 'red';
    out.verdict = `No viable: solo ${out.k} estudio con datos utilizables (mínimo 2).`;
  } else {
    out.level = 'green';
    if (out.k < 5) { out.level = 'amber'; out.flags.push({ level: 'amber', text: `Pocos estudios (${out.k}): la heterogeneidad se estima con poca precisión; el IC de DerSimonian-Laird puede ser demasiado estrecho (valora Hartung-Knapp en R).` }); }
    if (p.I2 >= 75) { out.level = 'amber'; out.flags.push({ level: 'amber', text: `Heterogeneidad considerable (I² = ${p.I2.toFixed(0)} %): explora las causas (subgrupos, metarregresión) o plantea una síntesis narrativa.` }); }
    else if (p.I2 >= 50) out.flags.push({ level: 'blue', text: `Heterogeneidad moderada (I² = ${p.I2.toFixed(0)} %): usa modelo de efectos aleatorios.` });
    if (cmp.size > 1 || tps.length > 1 && opts.timepoint === '*') out.level = out.level === 'green' ? 'amber' : out.level;
    if (unver) out.level = out.level === 'green' ? 'amber' : out.level;
    out.verdict = out.level === 'green'
      ? `Técnicamente viable: ${out.k} estudios combinables con ${measure}.`
      : `Posible con cautela: ${out.k} estudios combinables con ${measure}, pero revisa las alertas.`;
  }
  return out;
}

export const fmtNum = (x, d = 2) => (isNum(x) ? x.toFixed(d).replace('.', ',') : '—');
