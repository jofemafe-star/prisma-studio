// Exportación: descarga de archivos, SVG→PNG y generación de DOCX (librería docx cargada por <script>).

import { listOf, num } from './flow.js';

export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

export const svgBlob = (svg) => new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });

export async function svgToPng(svg, scale = 2) {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!m) throw new Error('SVG sin viewBox');
  const w = Number(m[1]), h = Number(m[2]);
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res;
    img.onerror = () => rej(new Error('No se pudo renderizar el diagrama'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const cv = document.createElement('canvas');
  cv.width = Math.round(w * scale);
  cv.height = Math.round(h * scale);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  return { blob, width: w, height: h, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

/** Texto que se imprime en la columna "ubicación" del checklist. */
export const locOf = (st = {}) => (st.status === 'na' ? 'N/A' : st.location || '');

const TXT = {
  es: {
    cols: ['Sección y tema', 'Ítem n.º', 'Ítem de la lista de verificación', 'Ubicación donde se informa el ítem'],
    project: 'Proyecto', authors: 'Autores', registration: 'Registro', date: 'Fecha',
    sources: 'Fuentes de información (ítem 6)', srcCols: ['Fuente', 'Tipo', 'Registros (n)', 'Última búsqueda'],
    db: 'Base de datos', reg: 'Registro', flow: 'Diagrama de flujo PRISMA 2020', checklist: 'Lista de verificación',
    locale: 'es-ES',
  },
  en: {
    cols: ['Section and Topic', 'Item #', 'Checklist item', 'Location where item is reported'],
    project: 'Project', authors: 'Authors', registration: 'Registration', date: 'Date',
    sources: 'Information sources (item 6)', srcCols: ['Source', 'Type', 'Records (n)', 'Last searched'],
    db: 'Database', reg: 'Register', flow: 'PRISMA 2020 flow diagram', checklist: 'Checklist',
    locale: 'en-GB',
  },
};

/**
 * Construye el documento Word. `D` es el objeto global `docx` (o el módulo en Node).
 * opts: { project, template, checklist, lang, flow (resultado de compute), flowPng, includeFlow }
 */
export function buildDocx(opts, D = globalThis.docx) {
  if (!D) throw new Error('La librería docx no está cargada');
  const { Document, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, ImageRun, AlignmentType } = D;
  const { project, template, checklist = {}, lang = 'es', flow, flowPng, includeFlow } = opts;
  const T = TXT[lang] || TXT.es;
  const meta = project.meta || {};
  const font = 'Arial';

  const P = (text, o = {}) =>
    new Paragraph({
      alignment: o.align,
      spacing: { before: o.before ?? 0, after: o.after ?? 80 },
      children: [new TextRun({ text: String(text ?? ''), bold: o.bold, italics: o.italics, size: o.size ?? 20, font, color: o.color })],
    });

  const cell = (text, w, o = {}) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      columnSpan: o.span,
      shading: o.fill ? { type: ShadingType.CLEAR, color: 'auto', fill: o.fill } : undefined,
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: String(text ?? '').split('\n').map((l) =>
        new Paragraph({ spacing: { after: 0 }, children: [new TextRun({ text: l, bold: o.bold, size: o.size ?? 18, font })] })),
    });

  const children = [];
  children.push(P(template.title[lang] || template.title.en, { bold: true, size: 32, after: 120 }));
  children.push(P(`${T.project}: ${project.title || ''}`, { bold: true }));
  if (meta.authors) children.push(P(`${T.authors}: ${meta.authors}`));
  if (meta.registration) children.push(P(`${T.registration}: ${meta.registration}`));
  children.push(P(`${T.date}: ${new Date().toLocaleDateString(T.locale)}`, { after: 200 }));

  // --- Checklist (4 columnas, como el formato oficial) ---
  const W = [1900, 700, 4700, 2338];
  const total = W.reduce((a, b) => a + b, 0);
  const rows = [
    new TableRow({ tableHeader: true, children: T.cols.map((c, i) => cell(c, W[i], { bold: true, fill: 'D9E2F3' })) }),
  ];
  for (const sec of template.sections) {
    const items = template.items.filter((i) => i.section === sec.id);
    if (!items.length) continue;
    rows.push(new TableRow({ children: [cell(sec[lang] || sec.en, total, { span: 4, bold: true, fill: 'EDEDED' })] }));
    for (const it of items) {
      rows.push(new TableRow({
        cantSplit: true,
        children: [
          cell(it.topic ? it.topic[lang] || it.topic.en : '', W[0], { bold: true }),
          cell(it.id, W[1]),
          cell(it[lang] || it.en, W[2]),
          cell(locOf(checklist[it.id]), W[3]),
        ],
      }));
    }
  }
  children.push(new Table({ width: { size: total, type: WidthType.DXA }, columnWidths: W, rows }));
  if (lang === 'es' && template.translationNote) children.push(P(template.translationNote, { italics: true, size: 16, before: 120 }));

  // --- Flujo y fuentes (opcional) ---
  if (includeFlow && flow) {
    children.push(new Paragraph({ pageBreakBefore: true, spacing: { after: 120 }, children: [new TextRun({ text: T.flow, bold: true, size: 28, font })] }));
    if (flowPng) {
      const wDoc = 600; // px aprox. (cabe en A4 con márgenes)
      children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new ImageRun({ data: flowPng.bytes, type: 'png', transformation: { width: wDoc, height: Math.round((wDoc * flowPng.height) / flowPng.width) } })],
      }));
    }
    if (flow.sources.length) {
      children.push(P(T.sources, { bold: true, before: 240, after: 100, size: 22 }));
      const SW = [3900, 1800, 1700, 2238];
      const sr = [new TableRow({ tableHeader: true, children: T.srcCols.map((c, i) => cell(c, SW[i], { bold: true, fill: 'D9E2F3' })) })];
      for (const s of flow.sources) {
        sr.push(new TableRow({ children: [
          cell(s.name || '—', SW[0]), cell(s.type === 'register' ? T.reg : T.db, SW[1]),
          cell(String(num(s.n)), SW[2]), cell(s.date || '', SW[3]),
        ] }));
      }
      children.push(new Table({ width: { size: SW.reduce((a, b) => a + b, 0), type: WidthType.DXA }, columnWidths: SW, rows: sr }));
    }
  }

  children.push(P(template.citation, { italics: true, size: 16, before: 240 }));

  return new Document({
    creator: 'PRISMA Studio',
    title: `${template.title[lang] || template.title.en} — ${project.title || ''}`,
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
      children,
    }],
  });
}

export async function docxBlob(opts, D = globalThis.docx) {
  return D.Packer.toBlob(buildDocx(opts, D));
}

export { listOf };
