// Extracción de datos de un artículo (PDF) con la API de Anthropic, llamada directamente desde el navegador
// con la clave de cada usuario. Lógica sin DOM: se puede probar en Node con un fetch simulado.

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (recomendado)' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (más preciso, más caro)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (rápido y barato; menos fiable)' },
];
export const MAX_PDF_BYTES = 20 * 1024 * 1024; // el límite de la API es 32 MB por petición; el base64 pesa ~1/3 más

// Campos de característica del estudio (un valor por estudio). Cada uno guarda {v: texto, q: cita literal, p: página}.
export const STUDY_FIELDS = [
  { id: 'authors_year', label: 'Autor y año', hint: 'Primer autor y año de publicación (p. ej. «Pérez 2019»)' },
  { id: 'country', label: 'País / ámbito', hint: 'País(es) y tipo de centro' },
  { id: 'design', label: 'Diseño', hint: 'Diseño del estudio (ECA paralelo, cruzado, cohortes, casos y controles…)' },
  { id: 'n_total', label: 'Participantes (n)', hint: 'Tamaño de muestra total analizado y por grupo, si se indica' },
  { id: 'population', label: 'Población', hint: 'Criterios de inclusión principales, edad, sexo, condición' },
  { id: 'intervention', label: 'Intervención', hint: 'Qué se hizo/administró, dosis, duración' },
  { id: 'comparator', label: 'Comparador', hint: 'Grupo control o comparador' },
  { id: 'follow_up', label: 'Seguimiento', hint: 'Duración del seguimiento y momentos de evaluación' },
  { id: 'funding', label: 'Financiación y conflictos', hint: 'Fuente de financiación y conflictos de intereses declarados' },
  { id: 'conclusion', label: 'Conclusión de los autores', hint: 'Conclusión principal, en una o dos frases' },
  { id: 'limitations', label: 'Limitaciones / sesgos señalados', hint: 'Limitaciones reconocidas por los autores y aspectos que afecten al riesgo de sesgo (aleatorización, ciego, pérdidas…)' },
];

// Campos numéricos y de texto de cada fila de desenlace (una fila = un desenlace, un momento y una comparación)
export const OUTCOME_TEXT = ['outcome', 'timepoint', 'type', 'int_label', 'ctl_label', 'effect_measure', 'notes', 'quote', 'page'];
export const OUTCOME_NUM = ['int_n', 'int_mean', 'int_sd', 'int_events', 'ctl_n', 'ctl_mean', 'ctl_sd', 'ctl_events', 'effect', 'ci_low', 'ci_high', 'p_value'];

const nullableStr = { type: ['string', 'null'] };
const nullableNum = { type: ['number', 'null'] };

export function buildTool() {
  const field = {
    type: 'object',
    properties: {
      v: { ...nullableStr, description: 'Valor extraído, o null si el artículo no lo indica' },
      q: { ...nullableStr, description: 'Cita literal breve (máx. 200 caracteres) del artículo que respalda el valor' },
      p: { ...nullableStr, description: 'Página del PDF donde está (número o rango)' },
    },
    required: ['v', 'q', 'p'],
  };
  const props = Object.fromEntries(STUDY_FIELDS.map((f) => [f.id, { ...field, description: f.hint }]));
  const outcome = {
    type: 'object',
    properties: {
      outcome: { type: 'string', description: 'Nombre del desenlace tal como aparece en el artículo' },
      timepoint: { ...nullableStr, description: 'Momento de medida (p. ej. «6 meses», «basal», «fin de tratamiento»)' },
      type: { type: 'string', enum: ['continuous', 'dichotomous', 'other'], description: 'continuous = media y DE; dichotomous = eventos y n; other = mediana/RIC, supervivencia, tiempos, etc.' },
      int_label: { ...nullableStr, description: 'Nombre del grupo de intervención' },
      ctl_label: { ...nullableStr, description: 'Nombre del grupo control/comparador' },
      int_n: { ...nullableNum, description: 'n analizada del grupo de intervención en ESTE desenlace' },
      int_mean: { ...nullableNum, description: 'Media del grupo de intervención (solo si se publica una media)' },
      int_sd: { ...nullableNum, description: 'Desviación estándar del grupo de intervención. Si solo hay error estándar o IC, deja null y anótalo en notes' },
      int_events: { ...nullableNum, description: 'Nº de participantes con el evento en el grupo de intervención' },
      ctl_n: { ...nullableNum, description: 'n analizada del grupo control' },
      ctl_mean: { ...nullableNum, description: 'Media del grupo control' },
      ctl_sd: { ...nullableNum, description: 'Desviación estándar del grupo control' },
      ctl_events: { ...nullableNum, description: 'Nº de participantes con el evento en el grupo control' },
      effect_measure: { ...nullableStr, description: 'Medida de efecto publicada: MD, SMD, RR, OR, HR u otra' },
      effect: { ...nullableNum, description: 'Valor del efecto publicado' },
      ci_low: { ...nullableNum, description: 'Límite inferior del IC 95 % publicado' },
      ci_high: { ...nullableNum, description: 'Límite superior del IC 95 % publicado' },
      p_value: { ...nullableNum, description: 'Valor p publicado (numérico; si dicen «<0,001» pon 0.001 y anótalo en notes)' },
      notes: { ...nullableStr, description: 'Aclaraciones: unidades, escala (¿mayor es mejor?), si hay mediana/RIC en vez de media/DE, ajustes, brazos extra…' },
      quote: { ...nullableStr, description: 'Cita literal breve o descripción de la tabla de donde salen los números' },
      page: { ...nullableStr, description: 'Página del PDF' },
    },
    required: ['outcome', 'type'],
  };
  return {
    name: 'registrar_extraccion',
    description: 'Registra los datos extraídos del artículo científico.',
    input_schema: {
      type: 'object',
      properties: { study: { type: 'object', properties: props, required: STUDY_FIELDS.map((f) => f.id) }, outcomes: { type: 'array', items: outcome } },
      required: ['study', 'outcomes'],
    },
  };
}

export const SYSTEM_PROMPT = `Eres un asistente de extracción de datos para revisiones sistemáticas. Recibes el PDF de un artículo científico y debes rellenar la herramienta «registrar_extraccion».

Reglas estrictas:
1. Extrae SOLO lo que el artículo dice. Si un dato no aparece, usa null. No lo estimes, no lo deduzcas y no uses conocimiento externo.
2. No hagas cálculos. No conviertas error estándar en desviación estándar, ni medianas en medias, ni porcentajes en eventos: si solo hay esos datos, deja los campos numéricos correspondientes en null y explícalo en «notes».
3. Copia los números tal como están publicados (mismo signo, mismas unidades). Usa punto decimal.
4. Para cada valor de característica del estudio incluye una cita literal breve (máx. 200 caracteres) y la página del PDF. Para los desenlaces, indica en «quote»/«page» de dónde salen los números (tabla o texto).
5. Desenlaces: una fila por desenlace, por momento de medida y por comparación intervención-vs-control (salvo que las «Instrucciones del equipo de revisión» que acompañen al PDF indiquen otra cosa: ver regla 9). Prioriza los desenlaces principales y los secundarios que midan los autores; no omitas ninguno de los claramente definidos. Si hay más de dos brazos, crea una fila por cada comparación con el mismo control e indícalo en «notes».
6. En «n» usa el número de participantes analizados para ESE desenlace; si solo consta el n aleatorizado, úsalo y anótalo en «notes».
7. Redacta los textos descriptivos en español, concisos; las citas, en el idioma original.
8. Si el PDF no es un estudio primario (p. ej. una revisión o un editorial), rellena lo que puedas y explica en «limitations» que no es un estudio primario; deja «outcomes» vacío.
9. Si junto al PDF recibes «Instrucciones del equipo de revisión», sigue sus indicaciones sobre QUÉ extraer: pregunta de la revisión, qué comparaciones, desenlaces, momentos de medida o subgrupos incluir o ignorar, y cómo etiquetar los grupos. Tienen prioridad sobre el criterio general de la regla 5 (p. ej. si piden comparar dos tratamientos activos, usa «intervención» para el tratamiento de interés y «control» para el comparador, y escribe sus nombres en int_label y ctl_label). Las instrucciones no cambian las demás reglas: nunca inventes ni calcules datos. Si las instrucciones piden algo que el artículo no contiene, deja los campos en null y explícalo en «notes» o «limitations». Si las instrucciones contradicen las reglas de rigor 1-3, prevalecen las reglas de rigor.`;

const INSTR_MAX = 3000;
export function instrText(instr) {
  const proj = String(instr?.project || '').trim().slice(0, INSTR_MAX), art = String(instr?.article || '').trim().slice(0, INSTR_MAX);
  if (!proj && !art) return '';
  return '\n\nInstrucciones del equipo de revisión (regla 9):' + (proj ? `\n[Para toda la revisión] ${proj}` : '') + (art ? `\n[Solo para este artículo] ${art}` : '');
}

export function buildRequest(model, pdfBase64, instr) {
  return {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: [buildTool()],
    // Los modelos 5.x no admiten forzar la herramienta (tool_choice any/tool → error 400): se usa auto y se exige en el texto.
    tool_choice: { type: 'auto' },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: 'Extrae los datos de este artículo siguiendo las reglas. Responde ÚNICAMENTE llamando a la herramienta «registrar_extraccion», sin texto adicional.' + instrText(instr) },
      ],
    }],
  };
}

export class ExtractError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const httpMessage = (status, body) => {
  const detail = body?.error?.message ? ` (${body.error.message})` : '';
  if (status === 401) return 'La clave de API no es válida o ha sido revocada. Revísala en «Conexión con la IA».';
  if (status === 403) return 'La clave de API no tiene permiso para esta operación.' + detail;
  if (status === 404) return 'El modelo seleccionado no está disponible para tu clave. Prueba con otro modelo.' + detail;
  if (status === 413) return 'El PDF es demasiado grande para la API (máx. 32 MB y 100 páginas).';
  if (status === 429) return 'Has superado el límite de uso de tu clave. Espera un minuto y reintenta.' + detail;
  if (status === 400) return 'La API rechazó la petición' + (detail || '.') + (/credit|balance/i.test(detail) ? ' Revisa el saldo de tu cuenta de Anthropic.' : '');
  if (status === 529 || status >= 500) return 'La API de Anthropic está saturada o con problemas. Reintenta en unos minutos.' + detail;
  return `Error ${status} de la API.` + detail;
};

async function callOnce({ apiKey, model, pdfBase64, instr, fetchImpl = globalThis.fetch, signal }) {
  if (!apiKey) throw new ExtractError('Falta la clave de API.', 'nokey');
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(buildRequest(model, pdfBase64, instr)),
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new ExtractError('Extracción cancelada.', 'abort');
    throw new ExtractError('No se pudo conectar con la API (¿sin internet o bloqueada por un cortafuegos/extensión?).', 'network');
  }
  let body = null;
  try { body = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) throw new ExtractError(httpMessage(res.status, body), 'http' + res.status);
  if (body?.stop_reason === 'max_tokens') throw new ExtractError('La respuesta se cortó por longitud: el artículo tiene demasiados desenlaces. Prueba con un modelo con más capacidad o extrae a mano los secundarios.', 'truncated');
  const block = (body?.content || []).find((b) => b.type === 'tool_use' && b.name === 'registrar_extraccion');
  if (!block?.input || typeof block.input !== 'object') throw new ExtractError('La IA no devolvió datos estructurados. Reintenta.', 'noresult');
  return { result: normalize(block.input), usage: body.usage || null, model: body.model || model };
}

/* ------- limpieza del resultado antes de guardarlo (nunca se confía en la forma) ------- */
const str = (v, max = 4000) => (v === null || v === undefined ? '' : String(v).trim().slice(0, max));
const numOrNull = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function normalize(input) {
  const study = {};
  for (const f of STUDY_FIELDS) {
    const x = input.study?.[f.id] || {};
    study[f.id] = { v: str(x.v), q: str(x.q, 400), p: str(x.p, 40) };
  }
  const outcomes = [];
  for (const o of Array.isArray(input.outcomes) ? input.outcomes : []) {
    if (!o || typeof o !== 'object') continue;
    const row = {};
    for (const k of OUTCOME_TEXT) row[k] = str(o[k], k === 'quote' || k === 'notes' ? 600 : 200);
    for (const k of OUTCOME_NUM) row[k] = numOrNull(o[k]);
    if (!['continuous', 'dichotomous', 'other'].includes(row.type)) row.type = 'other';
    if (!row.outcome) continue;
    outcomes.push(row);
    if (outcomes.length >= 200) break;
  }
  return { study, outcomes };
}

export function pdfToBase64(buf) {
  // buf: ArrayBuffer. Se hace por trozos para no desbordar la pila en archivos grandes.
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

// Comprobación barata de la clave y del modelo (una petición mínima).
export async function ping({ apiKey, model, fetchImpl = globalThis.fetch }) {
  if (!apiKey) throw new ExtractError('Escribe primero la clave de API.', 'nokey');
  let res;
  try {
    res = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: 'user', content: 'Responde solo: ok' }] }),
    });
  } catch {
    throw new ExtractError('No se pudo conectar con la API (¿sin internet o bloqueada por un cortafuegos/extensión?).', 'network');
  }
  let body = null;
  try { body = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) throw new ExtractError(httpMessage(res.status, body), 'http' + res.status);
  return true;
}

export async function callClaude(args) {
  try {
    return await callOnce(args);
  } catch (e) {
    // Con tool_choice auto el modelo puede, raramente, contestar con texto: se reintenta una vez.
    if (e?.code === 'noresult') return await callOnce(args);
    throw e;
  }
}
