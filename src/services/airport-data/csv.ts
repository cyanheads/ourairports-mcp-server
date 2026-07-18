/**
 * @fileoverview Minimal RFC-4180 CSV reader tuned for the OurAirports dumps.
 * Parses by HEADER NAME (not column position) because the live CSV column order
 * differs from the published data dictionary (e.g. icao_code precedes gps_code
 * in the real file). Handles quoted fields, embedded commas, embedded newlines,
 * and doubled `""` escapes — all of which appear in OurAirports name/keyword
 * columns.
 *
 * Streaming, not array-materializing: `forEachRow` hands each row to a visitor
 * as soon as it is parsed, reusing a single cell buffer and a single row view.
 * It never builds the whole `string[][]` or a `Record<string,string>` per row,
 * so parsing the 12.6 MB airports.csv holds one row's cells live — not 85k row
 * objects and their strings stacked on top of the raw file. Cells are built by
 * character accumulation (flat, self-owned strings) rather than by slicing the
 * raw buffer — a slice-view would pin the whole multi-MB file string alive for
 * as long as any parsed field is retained, re-inflating the steady-state heap.
 * @module src/services/airport-data/csv
 */

/**
 * One parsed CSV row. `get(column)` returns the raw cell for a header column, or
 * `''` when the column is absent from the header or the row is short. The
 * instance is reused across rows — read what you need during the visit; do not
 * retain the row or its values beyond the callback.
 */
export interface CsvRow {
  get(column: string): string;
}

/**
 * Stream CSV rows to `visit`, keyed by the header row. Consumes the header row
 * (never visited), skips a stray fully-empty trailing line, and reads absent
 * trailing cells as `''` — matching the previous parseRows+parseCsv semantics
 * byte-for-byte (verified against the six bundled CSVs and a battery of quoting
 * / line-ending edge cases).
 *
 * State machine over the full string: a `"` toggles quoted mode where commas and
 * newlines are literal and `""` is a single quote; a top-level comma closes a
 * field; LF, bare CR, or CRLF closes the row; a trailing field/row with no
 * terminator is flushed at end-of-input.
 */
export function forEachRow(text: string, visit: (row: CsvRow) => void): void {
  const len = text.length;

  /** header column name → column index; built from the first row. */
  let headerIndex: Map<string, number> | undefined;
  /** Reused cell buffer for the current row; only [0, cellCount) is live. */
  const cells: string[] = [];
  let cellCount = 0;

  const view: CsvRow = {
    get(column) {
      const idx = headerIndex?.get(column);
      if (idx === undefined || idx >= cellCount) return '';
      return cells[idx] as string;
    },
  };

  let field = '';
  let inQuotes = false;

  const pushField = (): void => {
    cells[cellCount++] = field;
    field = '';
  };

  const finishRow = (): void => {
    if (headerIndex === undefined) {
      const map = new Map<string, number>();
      for (let c = 0; c < cellCount; c++) map.set(cells[c] as string, c); // later dup column wins
      headerIndex = map;
    } else if (!(cellCount === 1 && cells[0] === '')) {
      // Skip a stray fully-empty trailing line (one empty cell, no real data).
      visit(view);
    }
    cellCount = 0;
  };

  for (let i = 0; i < len; i++) {
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
      pushField();
    } else if (ch === '\n') {
      pushField();
      finishRow();
    } else if (ch === '\r') {
      // Bare CR ends the row; a CRLF's CR is swallowed (the following LF ends it).
      if (text[i + 1] !== '\n') {
        pushField();
        finishRow();
      }
    } else {
      field += ch;
    }
  }

  // Flush a final field/row when the input did not end with a newline.
  if (field !== '' || cellCount > 0) {
    pushField();
    finishRow();
  }
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
