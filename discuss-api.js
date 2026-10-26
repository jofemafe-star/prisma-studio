// Fase D3: borrador de discusión científica a partir de los datos extraídos (solo texto, sin PDF).
import { API_URL, ExtractError, httpMessage } from './extract-api.js';

export const SECTIONS = [
  { id: 'hallazgos', title: 'Resumen de los principales hallazgos' },
  { id: 'concordancia', title: 'Comparación de los resultados entre estudios' },
  { id: 'heterogeneidad', title: 'Heterogeneidad y posibles explicaciones' },
  { id: 'literatura', title: 'Comparación con la literatura previa' },
  { id: 'limitaciones', title: 'Fortalezas y limitaciones de la evidencia' },
  { id: 'implicaciones', title: 'Implicaciones clínicas y para la investigación' },
  { id: 'conclusion', title: 'Conclusión' },
];

export function discussTool() {
  return {
    name: 'redactar_discusion',
    description: 'Entrega el borrador de la discusión de una revisión sistemática, dividido en secciones.',
    input_schema: {
      type: 'object',
      properties: {
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', enum: SECTIONS.map((s) => s.id) },
              text: { type: 'string', description: 'Texto de la sección en párrafos separados por una línea en blanco. Texto plano, sin markdown ni viñetas.' },
            },
            required: ['id', 'text'],
          },
        },
        warnings: { type: 'array', items: { type: 'string' }, description: 'Avisos para los autores: datos insuficientes, estudios sin verificar, desenlaces no combinables, etc.' },
      },
      required: ['sections', 'warnings'],
    },
  };
}

export const DISCUSS_PROMPT = `Eres un asistente de redacción científica para revisiones sistemáticas en ciencias de la salud. Redactas un BORRADOR de la sección «Discusión» a partir de los datos que recibes en JSON (estudios incluidos, resultados por desenlace y, opcionalmente, literatura externa aportada por los autores) y lo entregas llamando a la herramienta «redactar_discusion».

Reglas estrictas:
1. Usa SOLO la información recibida. No uses conocimiento externo, no cites artículos que no estén en los datos y no inventes referencias, cifras, autores ni hallazgos.
2. Cada cifra que escribas debe copiarse tal cual de los datos (mismas unidades, mismos decimales). No calcules diferencias, porcentajes ni nuevos efectos. Usa coma decimal.
3. Cita los estudios incluidos con su etiqueta exacta entre paréntesis, p. ej. (Pérez 2019) o (Pérez 2019; Lee 2021). Cita la literatura externa solo con la etiqueta que se te dé. No cites nada más.
4. Distingue lo observado de lo interpretado: las explicaciones son «posibles» y deben apoyarse en diferencias reales entre estudios (población, intervención, comparador, seguimiento, diseño). No afirmes causalidad que los datos no permitan.
5. Respeta los resultados calculados: si un desenlace es «no viable» o «con cautela», dilo y no sobreinterpretes. Los meta-análisis son orientativos. Si hay estudios sin verificar, menciónalo en limitaciones y en avisos.
6. Si faltan datos para una sección, escribe lo que se pueda decir con los datos y añade un aviso; no rellenes con generalidades.
7. Redacta en español académico, tercera persona, párrafos continuos (sin viñetas ni markdown). Longitud orientativa: 1-3 párrafos por sección.
8. Secciones: hallazgos, concordancia, heterogeneidad, literatura (solo si hay literatura externa; si no la hay, omite la sección), limitaciones, implicaciones, conclusion. En «limitaciones» incluye las limitaciones señaladas por los autores de los estudios y las de la propia revisión derivadas de los datos (pocos estudios, datos sin verificar, comparadores distintos, etc.). No evalúes el riesgo de sesgo si los datos no lo incluyen: indícalo como limitación.
9. Si recibes «Instrucciones de los autores», síguelas para el enfoque y el tono, sin incumplir las reglas anteriores.`;

export function buildDiscussRequest(model, payload, refs, guide) {
  const refsTxt = (refs || []).map((r) => `[${r.label}] ${r.citation}\n${r.text}`).join('\n\n');
  return {
    model,
    max_tokens: 16000,
    system: DISCUSS_PROMPT,
    tools: [discussTool()],
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: `DATOS DE LA REVISIÓN (JSON):\n${JSON.stringify(payload)}\n\n${refsTxt ? `LITERATURA EXTERNA APORTADA POR LOS AUTORES (cita solo con la etiqueta entre corchetes):\n${refsTxt}\n\n` : 'No se ha aportado literatura externa.\n\n'}${guide ? `INSTRUCCIONES DE LOS AUTORES: ${String(guide).slice(0, 3000)}\n\n` : ''}Redacta el borrador llamando ÚNICAMENTE a la herramienta «redactar_discusion», sin texto adicional.`,
    }],
  };
}

const str = (v, max = 12000) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));

export function normalizeDiscussion(input) {
  const byId = new Map();
  for (const s of Array.isArray(input?.sections) ? input.sections : []) {
    const def = SECTIONS.find((d) => d.id === s?.id);
    if (!def || byId.has(def.id)) continue;
    const text = str(s.text);
    if (text) byId.set(def.id, text);
  }
  const sections = SECTIONS.filter((d) => byId.has(d.id)).map((d, i) => ({ id: d.id, title: d.title, text: byId.get(d.id), order: i }));
  const warnings = (Array.isArray(input?.warnings) ? input.warnings : []).map((w) => str(w, 500)).filter(Boolean).slice(0, 20);
  return { sections, warnings };
}

/* ---------- comprobaciones automáticas del borrador (cifras y citas) ---------- */
const NUM_RE = /(?<![\w.,])\d+(?:[.,]\d+)?(?![\w])/g;
const canon = (t) => String(t).replace(/(\d),(\d)/g, '$1.$2');
const normTok = (t) => { const x = canon(t); return /\./.test(x) ? String(Number(x)) : String(Number(x)); };

export function corpusNumbers(...texts) {
  const set = new Set(['0.05', '0.01', '0.001', '95', '100']);
  for (const t of texts) for (const m of canon(typeof t === 'string' ? t : JSON.stringify(t)).matchAll(NUM_RE)) set.add(normTok(m[0]));
  return set;
}

export function checkNumbers(text, corpus) {
  const bad = new Set();
  for (const m of canon(text).matchAll(NUM_RE)) {
    const raw = m[0], n = Number(raw);
    if (!Number.isFinite(n)) continue;
    if (Number.isInteger(n) && (n <= 10 || (n >= 1900 && n <= 2100))) continue;
    if (!corpus.has(normTok(raw))) bad.add(raw.replace('.', ','));
  }
  return [...bad];
}

const normLabel = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function checkCitations(text, allowedLabels) {
  const ok = new Set(allowedLabels.map(normLabel)), bad = new Set();
  for (const m of String(text).matchAll(/\(([^()]*\b(?:19|20)\d{2}[a-z]?\b[^()]*)\)/g)) {
    for (const part of m[1].split(';')) {
      const p = part.trim(); if (!p) continue;
      if (!ok.has(normLabel(p))) bad.add(p);
    }
  }
  return [...bad];
}

async function discussOnce({ apiKey, model, payload, refs, guide, fetchImpl = globalThis.fetch, signal }) {
  if (!apiKey) throw new ExtractError('Falta la clave de API.', 'nokey');
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify(buildDiscussRequest(model, payload, refs, guide)),
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new ExtractError('Redacción cancelada.', 'abort');
    throw new ExtractError('No se pudo conectar con la API (¿sin internet o bloqueada por un cortafuegos/extensión?).', 'network');
  }
  let body = null;
  try { body = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) throw new ExtractError(httpMessage(res.status, body), 'http' + res.status);
  if (body?.stop_reason === 'max_tokens') throw new ExtractError('La respuesta se cortó por longitud. Reduce el número de desenlaces o las instrucciones.', 'truncated');
  const block = (body?.content || []).find((b) => b.type === 'tool_use' && b.name === 'redactar_discusion');
  if (!block?.input || typeof block.input !== 'object') throw new ExtractError('La IA no devolvió un borrador estructurado. Reintenta.', 'noresult');
  const out = normalizeDiscussion(block.input);
  if (!out.sections.length) throw new ExtractError('La IA devolvió un borrador vacío. Reintenta.', 'noresult');
  return { ...out, usage: body.usage || null, model: body.model || model };
}

export async function discuss(args) {
  if (!args.payload?.outcomes?.length && !args.payload?.studies?.length) throw new ExtractError('No hay estudios con datos extraídos.', 'empty');
  try { return await discussOnce(args); } catch (e) { if (e?.code === 'noresult') return await discussOnce(args); throw e; }
}
