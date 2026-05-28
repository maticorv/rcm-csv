import * as pdfjsLib from "pdfjs-dist";
import Papa from "papaparse";

pdfjsLib.GlobalWorkerOptions.workerSrc =
  import.meta.env.BASE_URL.replace(/\/?$/, "/") + "pdf.worker.mjs";

export interface ConversionResult {
  csv: string;
  rows: string[][];
  pageCount: number;
  filename: string;
}

interface RawItem {
  str: string;
  x: number;
  y: number;
}

interface PdfTextItem {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

type OnProgress = (page: number, total: number) => void;

const CSV_HEADERS = [
  "Encargo",
  "Hoj.Entr.",
  "Importe",
  "Moneda",
  "Resumen / Producto",
  "Período Inicio",
  "Período Fin",
  "Orden",
  "Ceco",
  "Nro. RCM",
  "Centro Costo",
];

export async function pdfToCSV(
  file: File,
  onProgress?: OnProgress,
): Promise<ConversionResult> {
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) })
    .promise;
  const pageCount = pdf.numPages;

  const allItems: RawItem[][] = [];

  for (let i = 1; i <= pageCount; i++) {
    onProgress?.(i, pageCount);
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();

    const items: RawItem[] = content.items
      .filter(
        (item): item is PdfTextItem =>
          "str" in item && (item as PdfTextItem).str.trim() !== "",
      )
      .map((item) => {
        const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
        return {
          str: item.str.trim(),
          x: Math.round(tx[4]),
          y: Math.round(tx[5]),
        };
      });

    allItems.push(items);
  }

  const dataRows = parseRcmPages(allItems);
  const csvRows = [CSV_HEADERS, ...dataRows];
  const csv = Papa.unparse(csvRows);

  return {
    csv,
    rows: csvRows,
    pageCount,
    filename: file.name.replace(/\.pdf$/i, ".csv"),
  };
}

function parseRcmPages(pages: RawItem[][]): string[][] {
  const result: string[][] = [];
  let nroRcm = "";
  let centroCosto = "";

  for (const items of pages) {
    // Group items by Y row (tolerance 4px)
    const rowMap = groupByY(items, 4);
    const ys = [...rowMap.keys()].sort((a, b) => a - b);

    // Extract Nro. RCM from this page header (y ~ 33, look for value after "RCM:")
    for (const y of ys) {
      const row = rowMap.get(y)!;
      const rowed = row.map((i) => i.str);
      const rIdx = rowed.indexOf("RCM:");
      if (rIdx !== -1 && row[rIdx + 1]) {
        nroRcm = row[rIdx + 1].str;
        break;
      }
    }

    for (const y of ys) {
      const row = rowMap.get(y)!;

      // Detect "Centro Costo: XXX NNN" section header
      const centroIdx = row.findIndex((i) => i.str === "Centro" && i.x > 200);
      if (centroIdx !== -1) {
        const costoIdx = row.findIndex((i) => i.str === "Costo:" && i.x > 200);
        if (costoIdx !== -1) {
          const afterCosto = row.filter((i) => i.x > row[costoIdx].x);
          centroCosto = afterCosto.map((i) => i.str).join(" ");
          continue;
        }
      }

      // Skip non-data rows: header rows, TOTAL rows, document meta rows
      if (!isDataRow(row)) continue;

      const dataRow = extractColumns(row, nroRcm, centroCosto);
      if (dataRow) result.push(dataRow);
    }
  }

  return result;
}

function isDataRow(row: RawItem[]): boolean {
  // Data rows start with an 8-digit numeric Encargo at x < 30
  const firstItem = row.find((i) => i.x < 30);
  if (!firstItem) return false;
  return /^\d{7,9}$/.test(firstItem.str);
}

function extractColumns(
  row: RawItem[],
  nroRcm: string,
  centroCosto: string,
): string[] | null {
  // Encargo: x < 30
  const encargo = row.find((i) => i.x < 30)?.str ?? "";
  if (!encargo) return null;

  // Hoj.Entr.: 30 <= x < 130
  const hojEntr = row.find((i) => i.x >= 30 && i.x < 130)?.str ?? "";

  // Importe: 130 <= x < 210
  const importe = row.find((i) => i.x >= 130 && i.x < 210)?.str ?? "";

  // Moneda: 200 <= x < 230
  const moneda = row.find((i) => i.x >= 200 && i.x < 230)?.str ?? "";

  // Resumen/Producto: 230 <= x < 465 — join all chunks in order
  const resumenItems = row
    .filter((i) => i.x >= 230 && i.x < 465)
    .sort((a, b) => a.x - b.x);
  const resumen = buildResumen(resumenItems);

  // Período Inicio: 460 <= x < 530
  const periodoInicio = row.find((i) => i.x >= 460 && i.x < 530)?.str ?? "";

  // Período Fin: 530 <= x < 595
  const periodoFin = row.find((i) => i.x >= 530 && i.x < 595)?.str ?? "";

  // Orden: 595 <= x < 645
  const orden = row.find((i) => i.x >= 595 && i.x < 645)?.str ?? "";

  // Ceco: 645 <= x
  const ceco = row.find((i) => i.x >= 645)?.str ?? "";

  return [
    encargo,
    hojEntr,
    importe,
    moneda,
    resumen,
    periodoInicio,
    periodoFin,
    orden,
    ceco,
    nroRcm,
    centroCosto,
  ];
}

function buildResumen(items: RawItem[]): string {
  if (items.length === 0) return "";
  const parts: string[] = [];
  let last: RawItem | null = null;

  for (const item of items) {
    if (last && item.x - (last.x + 10) > 8) {
      // Gap between words — add space
      parts.push(" ");
    } else if (last) {
      parts.push(" ");
    }
    parts.push(item.str);
    last = item;
  }

  return parts.join("").trim().replace(/\s+/g, " ");
}

function groupByY(items: RawItem[], tolerance: number): Map<number, RawItem[]> {
  const map = new Map<number, RawItem[]>();
  const keys: number[] = [];

  for (const item of items) {
    const match = keys.find((k) => Math.abs(k - item.y) <= tolerance);
    if (match !== undefined) {
      map.get(match)!.push(item);
    } else {
      map.set(item.y, [item]);
      keys.push(item.y);
    }
  }

  return map;
}
