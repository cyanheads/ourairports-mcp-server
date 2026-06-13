/**
 * @fileoverview Minimal RFC-4180 CSV parser tuned for the OurAirports dumps.
 * Parses by HEADER NAME (not column position) because the live CSV column order
 * differs from the published data dictionary (e.g. icao_code precedes gps_code
 * in the real file). Handles quoted fields, embedded commas, embedded newlines,
 * and doubled `""` escapes — all of which appear in OurAirports name/keyword
 * columns.
 * @module src/services/airport-data/csv
 */

/**
 * Parse CSV text into an array of row objects keyed by the header row.
 *
 * Each row maps every header column to its raw string cell value. Empty cells
 * become `''`; callers decide what "absent" means per field (see the field
 * coercion helpers below). Trailing empty lines are ignored.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const header = rows[0] ?? [];
  const out: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells) continue;
    // Skip a stray fully-empty trailing line (one empty cell, no real data).
    if (cells.length === 1 && cells[0] === '') continue;
    const record: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      record[header[c] ?? `col${c}`] = cells[c] ?? '';
    }
    out.push(record);
  }
  return out;
}

/**
 * Tokenize CSV text into rows of raw cells. State machine over the full string;
 * quotes toggle "in field" mode where commas/newlines are literal and `""` is a
 * single quote.
 */
function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // swallow — handled by the following \n (CRLF) or treated as line end (bare CR)
      if (text[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += ch;
    }
  }

  // Flush the final field/row if the file didn't end with a newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/** Trimmed string, or `undefined` when the cell is empty. */
export function str(v: string | undefined): string | undefined {
  if (v === undefined) return;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/** Required trimmed string — throws when absent (use only for guaranteed PK-like columns). */
export function reqStr(v: string | undefined, field: string): string {
  const s = str(v);
  if (s === undefined) throw new Error(`Missing required CSV field: ${field}`);
  return s;
}

/** Parsed integer, or `undefined` when the cell is empty or non-numeric. */
export function int(v: string | undefined): number | undefined {
  const s = str(v);
  if (s === undefined) return;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Required parsed integer — throws when absent or non-numeric. */
export function reqInt(v: string | undefined, field: string): number {
  const n = int(v);
  if (n === undefined) throw new Error(`Missing or invalid required integer CSV field: ${field}`);
  return n;
}

/** Parsed float, or `undefined` when the cell is empty or non-numeric. */
export function num(v: string | undefined): number | undefined {
  const s = str(v);
  if (s === undefined) return;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * OurAirports boolean columns are `"1"`/`"0"` (and occasionally `"yes"`/`"no"`
 * or `"true"`/`"false"`). Anything else (including empty) is `false`.
 */
export function bool(v: string | undefined): boolean {
  const s = str(v)?.toLowerCase();
  return s === '1' || s === 'yes' || s === 'true';
}

/**
 * Strip keys whose value is `undefined`, returning the object with those keys
 * made optional. Lets a domain object be assembled as a flat literal (with
 * `undefined` for absent CSV cells) and then satisfy an interface declared under
 * `exactOptionalPropertyTypes` — absent fields are genuinely omitted, not set to
 * `undefined`. The runtime delete makes the cast sound.
 */
export function compact<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const out = { ...obj };
  for (const key of Object.keys(out) as (keyof T)[]) {
    if (out[key] === undefined) delete out[key];
  }
  return out as { [K in keyof T]?: Exclude<T[K], undefined> };
}
