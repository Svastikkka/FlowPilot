import type { DataTable } from './schema/types';
import { LIMITS, VARIABLE_NAME_RE } from './schema/zod';

// RFC 4180-style CSV parsing/serialization for data tables. The delimiter is
// detected (comma, semicolon or tab) from the header line.

export class CsvError extends Error {}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

export function parseCsvRows(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // BOM
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (quoted) throw new CsvError('Unclosed quote in CSV');
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/** Turns a header into a variable-safe column name, e.g. "E-mail address" → "e_mail_address". */
export function toColumnName(header: string, index: number): string {
  let name = header
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  if (!name) name = `column_${index + 1}`;
  if (/^\d/.test(name)) name = `_${name}`;
  return name;
}

export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = seen.get(n) ?? 0;
    seen.set(n, count + 1);
    return count === 0 ? n : `${n}_${count + 1}`;
  });
}

export interface ParsedCsv extends DataTable {
  /** Original header text, for showing the mapping to column names. */
  headers: string[];
}

export function parseCsv(text: string): ParsedCsv {
  const rows = parseCsvRows(text);
  if (rows.length === 0) throw new CsvError('The CSV file is empty');
  const [header, ...body] = rows;
  if (header.length > LIMITS.maxDataColumns) throw new CsvError(`A CSV can have at most ${LIMITS.maxDataColumns} columns`);
  if (body.length > LIMITS.maxDataRows) throw new CsvError(`A CSV can have at most ${LIMITS.maxDataRows} rows`);
  const columns = uniqueNames(header.map(toColumnName));
  for (const c of columns) if (!VARIABLE_NAME_RE.test(c)) throw new CsvError(`Invalid column name "${c}"`);
  return {
    headers: header,
    columns,
    rows: body.map((r) => columns.map((_, i) => (r[i] ?? '').slice(0, LIMITS.longText))),
  };
}

function escapeCell(value: string): string {
  // Neutralise spreadsheet formula injection when opened in Excel/Sheets.
  const safe = /^(?:[=+@\t\r]|-(?![\d.]))/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(columns: string[], rows: string[][]): string {
  return [columns, ...rows].map((r) => r.map((c) => escapeCell(c ?? '')).join(',')).join('\r\n');
}
