/**
 * @fileoverview The airport-data service — the server's source of truth.
 *
 * Loads the six bundled OurAirports CSVs once at `setup()`, parses them by
 * header name (not column position), and builds in-memory indices: id→airport
 * maps, a priority-ordered unified code index, airport-ref join maps for
 * runways/frequencies, an ident-keyed navaid map, a flat coordinate array for
 * haversine scans, country/region maps, and a tokenized text-search index.
 *
 * Request-time queries use map lookups and corpus scans; airport search retains
 * a bounded top-N heap. No network, SQLite, or per-request parsing. The corpus
 * is replaced wholesale at image-build time, so there is nothing to sync.
 * @module src/services/airport-data/airport-data-service
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { bool, compact, forEachRow, int, num, positiveInt, reqInt, reqStr, str } from './csv.js';
import { resolveBundledDataDir } from './data-dir.js';
import { bearingDeg, haversineKm, nearest } from './geo.js';
import { RankedPage } from './ranked-page.js';
import { readSnapshot, type Snapshot } from './snapshot.js';
import type {
  Airport,
  AirportFacets,
  AirportNavaidsResult,
  CodeHolder,
  CodeResolution,
  Country,
  CountrySummary,
  Frequency,
  Navaid,
  NearbyAirportsResult,
  NearbyNavaidsResult,
  Region,
  RegionSummary,
  ResolvedVia,
  Runway,
  RunwayMatch,
  RunwaySearchFilters,
  RunwaySearchResult,
  SearchFilters,
  SearchResult,
} from './types.js';

const CSV_FILES = {
  airports: 'airports.csv',
  runways: 'runways.csv',
  navaids: 'navaids.csv',
  frequencies: 'airport-frequencies.csv',
  countries: 'countries.csv',
  regions: 'regions.csv',
} as const;

/** Append a value to a map of arrays, creating the array on first insertion. */
function pushToMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Code spaces in descending resolution priority — drives codeIndex insertion order. */
const CODE_PRIORITY: readonly { via: ResolvedVia; key: keyof Airport }[] = [
  { via: 'ident', key: 'ident' },
  { via: 'icao_code', key: 'icaoCode' },
  { via: 'iata_code', key: 'iataCode' },
  { via: 'gps_code', key: 'gpsCode' },
  { via: 'local_code', key: 'localCode' },
] as const;

const STOPWORD = new Set(['the', 'of', 'and', 'a', 'an']);
/**
 * Query-token alternatives. Each adds one exact indexed form beside the literal
 * token, which keeps its forward-prefix match, so an alternative never removes
 * a match. `st`/`saint` and `ste`/`sainte` run both ways because the corpus
 * spells both forms.
 */
const NAME_ALTERNATIVES = new Map([
  ['intl', 'international'],
  ['rgnl', 'regional'],
  ['muni', 'municipal'],
  ['fld', 'field'],
  ['mem', 'memorial'],
  ['ft', 'fort'],
  ['mt', 'mount'],
  ['st', 'saint'],
  ['saint', 'st'],
  ['ste', 'sainte'],
  ['sainte', 'ste'],
]);
/** Latin letters NFKD leaves whole, folded to ASCII so they stay inside their word. */
const LATIN_FOLD = new Map([
  ['æ', 'ae'],
  ['đ', 'd'],
  ['ð', 'd'],
  ['ħ', 'h'],
  ['ı', 'i'],
  ['ł', 'l'],
  ['ø', 'o'],
  ['œ', 'oe'],
  ['ß', 'ss'],
  ['þ', 'th'],
  ['ŧ', 't'],
  ['ə', 'e'],
  ['ᵫ', 'ue'],
]);

/** One airport's search text: every indexed token, plus name and municipality in order. */
interface AirportText {
  municipality: string[];
  name: string[];
  tokens: Set<string>;
}

/** One AND term of a query: an airport matches when it holds the code or carries every token. */
interface SearchTerm {
  codeHolders: ReadonlySet<number> | undefined;
  tokens: string[];
}

/**
 * Force a full GC so the transient parse garbage (raw file strings, per-field
 * slices) is returned to the OS at the end of `load()` rather than reclaimed
 * lazily ~a minute later. Bun-only: `Bun.gc` is absent under Node and other
 * runtimes, where this is a no-op — the streaming parser is the portable win.
 */
function releaseTransientParseMemory(): void {
  (globalThis as { Bun?: { gc?: (force: boolean) => void } }).Bun?.gc?.(true);
}

/**
 * Tokenize a string for the text-search index: decompose, lowercase, strip
 * diacritics, fold the Latin letters NFKD leaves whole (ł → l, ø → o, ß → ss),
 * replace other non-alphanumerics with spaces, split, drop short stopwords.
 * Lowercasing after NFKD keeps compatibility forms such as № → no.
 */
function tokenize(text: string): string[] {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, (char) => LATIN_FOLD.get(char) ?? ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORD.has(t));
}

export class AirportDataService {
  private readonly airportsById = new Map<number, Airport>();
  /** Uppercased code string → airport id. Built in priority order, insert-if-absent. */
  private readonly codeIndex = new Map<string, number>();
  /** Which code space each codeIndex entry came from — for the resolution note. */
  private readonly codeVia = new Map<string, ResolvedVia>();
  /**
   * Code strings carried by more than one airport → every airport OTHER than
   * the codeIndex winner, with the spaces it carries the string in. Only shared
   * codes get an entry (~3.9k of ~111k keys).
   */
  private readonly sharedCodeHolders = new Map<string, CodeHolder[]>();
  private readonly runwaysByAirportRef = new Map<number, Runway[]>();
  private readonly frequenciesByAirportRef = new Map<number, Frequency[]>();
  private readonly navaidsByAirportIdent = new Map<string, Navaid[]>();
  private readonly navaidIdentIndex = new Map<string, Navaid[]>();
  private readonly countriesByCode = new Map<string, Country>();
  private readonly regionsByCode = new Map<string, Region>();
  /** alpha-2 country code → airport count (excludes closed). */
  private readonly airportCountByCountry = new Map<string, number>();
  /** ISO 3166-2 region code → airport count (excludes closed). */
  private readonly airportCountByRegion = new Map<string, number>();

  /** Flat [lat, lon, …] for airports, with a parallel id array (hot-loop friendly). */
  private airportCoords = new Float64Array(0);
  private airportCoordIds: number[] = [];
  /** Flat [lat, lon, …] for navaids, with a parallel index into `navaidList`. */
  private navaidCoords = new Float64Array(0);
  private navaidList: Navaid[] = [];

  /** Per-airport search text, keyed by id (not parallel to `airportCoordIds`). */
  private readonly textByAirportId = new Map<number, AirportText>();

  /** The bundle's snapshot.json record; undefined for a data drop without one. */
  private snapshot: Snapshot | undefined;
  private loaded = false;

  constructor(private readonly dataDir: string) {}

  /**
   * Read the snapshot record, then parse all six CSVs and build every index.
   * Idempotent. Throws naming `snapshot.json` when it is present but malformed.
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    const started = performance.now();
    // First, so a malformed record fails startup before the CSV parse.
    this.snapshot = await readSnapshot(this.dataDir);

    // Read → parse → drop one file at a time: each raw string is a temporary
    // that dies before the next read, and the awaits are GC yield points — so
    // the resident high-water mark is one file's parse, not all six raw strings
    // plus every file's transient parse garbage held live at once.
    const read = (file: string) => readFile(join(this.dataDir, file), 'utf-8');
    this.loadCountries(await read(CSV_FILES.countries));
    this.loadRegions(await read(CSV_FILES.regions));
    this.loadAirports(await read(CSV_FILES.airports));
    this.loadRunways(await read(CSV_FILES.runways));
    this.loadFrequencies(await read(CSV_FILES.frequencies));
    this.loadNavaids(await read(CSV_FILES.navaids));

    // Return the transient parse pages to the OS now, not ~a minute later.
    releaseTransientParseMemory();

    this.loaded = true;
    logger.info(
      'airport-data indices built',
      requestContextService.createRequestContext({
        operation: 'AirportDataLoad',
        additionalContext: {
          dataDir: this.dataDir,
          dataAsOf: this.dataAsOf,
          fetchedAt: this.snapshot?.fetchedAt ?? null,
          airports: this.airportsById.size,
          airportsWithRunways: this.runwaysByAirportRef.size,
          navaids: this.navaidList.length,
          countries: this.countriesByCode.size,
          regions: this.regionsByCode.size,
          codeKeys: this.codeIndex.size,
          durationMs: Math.round(performance.now() - started),
        },
      }),
    );
  }

  // ---- CSV → index builders -------------------------------------------------

  private loadCountries(csv: string): void {
    forEachRow(csv, (r) => {
      const code = str(r.get('code'));
      if (!code) return;
      const country: Country = {
        code,
        name: reqStr(r.get('name'), 'countries.name'),
        ...compact({
          continent: str(r.get('continent')),
          wikipediaLink: str(r.get('wikipedia_link')),
          keywords: str(r.get('keywords')),
        }),
      };
      this.countriesByCode.set(code.toUpperCase(), country);
    });
  }

  private loadRegions(csv: string): void {
    forEachRow(csv, (r) => {
      const code = str(r.get('code'));
      if (!code) return;
      const region: Region = {
        code,
        name: reqStr(r.get('name'), 'regions.name'),
        ...compact({
          localCode: str(r.get('local_code')),
          continent: str(r.get('continent')),
          isoCountry: str(r.get('iso_country')),
          wikipediaLink: str(r.get('wikipedia_link')),
        }),
      };
      this.regionsByCode.set(code.toUpperCase(), region);
    });
  }

  private loadAirports(csv: string): void {
    const lats: number[] = [];
    const lons: number[] = [];

    forEachRow(csv, (r) => {
      const lat = num(r.get('latitude_deg'));
      const lon = num(r.get('longitude_deg'));
      // Coordinates are guaranteed in this dataset; skip the rare malformed row
      // rather than poison the coordinate array with NaN.
      if (lat === undefined || lon === undefined) return;

      const airport: Airport = {
        id: reqInt(r.get('id'), 'airports.id'),
        ident: reqStr(r.get('ident'), 'airports.ident'),
        type: reqStr(r.get('type'), 'airports.type'),
        name: reqStr(r.get('name'), 'airports.name'),
        latitudeDeg: lat,
        longitudeDeg: lon,
        scheduledService: bool(r.get('scheduled_service')),
        ...compact({
          elevationFt: int(r.get('elevation_ft')),
          continent: str(r.get('continent')),
          isoCountry: str(r.get('iso_country')),
          isoRegion: str(r.get('iso_region')),
          municipality: str(r.get('municipality')),
          icaoCode: str(r.get('icao_code')),
          iataCode: str(r.get('iata_code')),
          gpsCode: str(r.get('gps_code')),
          localCode: str(r.get('local_code')),
          homeLink: str(r.get('home_link')),
          wikipediaLink: str(r.get('wikipedia_link')),
          keywords: str(r.get('keywords')),
        }),
      };

      this.airportsById.set(airport.id, airport);
      lats.push(lat);
      lons.push(lon);
      this.airportCoordIds.push(airport.id);

      this.indexTokens(airport);

      if (airport.type !== 'closed') {
        if (airport.isoCountry) {
          this.airportCountByCountry.set(
            airport.isoCountry.toUpperCase(),
            (this.airportCountByCountry.get(airport.isoCountry.toUpperCase()) ?? 0) + 1,
          );
        }
        if (airport.isoRegion) {
          this.airportCountByRegion.set(
            airport.isoRegion.toUpperCase(),
            (this.airportCountByRegion.get(airport.isoRegion.toUpperCase()) ?? 0) + 1,
          );
        }
      }
    });

    // Code index is built AFTER all airports are loaded, in global priority
    // passes — so a unique ident is never shadowed by an earlier row's national
    // code (#2).
    this.buildCodeIndex();

    // Pack coordinates into a single Float64Array, parallel to airportCoordIds.
    const coords = new Float64Array(lats.length * 2);
    for (let i = 0; i < lats.length; i++) {
      coords[i * 2] = lats[i] as number;
      coords[i * 2 + 1] = lons[i] as number;
    }
    this.airportCoords = coords;
  }

  /**
   * Build the unified code index in GLOBAL priority passes: register every
   * airport's `ident`, then every `icao_code`, then `iata_code`, `gps_code`,
   * and `local_code` — each pass insert-if-absent over airports in CSV row
   * order. Idents are globally unique, so pass 1 is collision-free and a unique
   * ident can never be shadowed by an earlier-row airport's national (gps/local)
   * code (#2).
   *
   * A string already claimed by a *different* airport records that airport as
   * a holder of the shared code, with the space it carries it in — so the
   * resolution note can name every other airport and say whether priority or
   * row order (a tie within the winner's own space) decided the match.
   */
  private buildCodeIndex(): void {
    for (const { via, key } of CODE_PRIORITY) {
      for (const airport of this.airportsById.values()) {
        const raw = airport[key];
        if (typeof raw !== 'string' || raw.length === 0) continue;
        const upper = raw.toUpperCase();
        const claimedBy = this.codeIndex.get(upper);
        if (claimedBy === undefined) {
          this.codeIndex.set(upper, airport.id);
          this.codeVia.set(upper, via);
        } else if (claimedBy !== airport.id) {
          this.addSharedHolder(upper, airport, via);
        }
      }
    }
  }

  /** Record `airport` as carrying the shared code `upper` in space `via`. */
  private addSharedHolder(upper: string, airport: Airport, via: ResolvedVia): void {
    const holders = this.sharedCodeHolders.get(upper);
    if (!holders) {
      this.sharedCodeHolders.set(upper, [{ airport, spaces: [via] }]);
      return;
    }
    const existing = holders.find((h) => h.airport.id === airport.id);
    if (existing) existing.spaces.push(via);
    else holders.push({ airport, spaces: [via] });
  }

  private indexTokens(airport: Airport): void {
    const name = tokenize(airport.name);
    const municipality = airport.municipality ? tokenize(airport.municipality) : [];
    const tokens = new Set([...name, ...municipality]);
    if (airport.keywords) for (const t of tokenize(airport.keywords)) tokens.add(t);
    this.textByAirportId.set(airport.id, { municipality, name, tokens });
  }

  /**
   * Split a trimmed query into its AND terms and its tokens in query order, which
   * ranking reads. A word that is an exact code becomes a term its code holders
   * also satisfy; the tokens of every other word join one shared text term. Each
   * distinct word is tokenized once and each distinct token or code term matched
   * once, so matching work grows with the number of distinct tokens and codes in
   * the query.
   */
  private queryTerms(query: string): {
    exactCodeHolders: ReadonlySet<number> | undefined;
    queryTokens: string[];
    terms: SearchTerm[];
  } {
    const words = query.split(/\s+/);
    const tokensByWord = new Map<string, string[]>();
    const textTokens = new Set<string>();
    /** Keyed by code and tokens, which together decide what a code term matches. */
    const codeTerms = new Map<string, SearchTerm>();
    const queryTokens: string[] = [];
    let exactCodeHolders: ReadonlySet<number> | undefined;
    for (const word of words) {
      let tokens = tokensByWord.get(word);
      if (tokens === undefined) {
        tokens = tokenize(word);
        tokensByWord.set(word, tokens);
        if (tokens.length > 0) {
          const code = word.toUpperCase();
          const winner = this.codeIndex.get(code);
          if (winner === undefined) {
            for (const token of tokens) textTokens.add(token);
          } else {
            const key = `${code} ${tokens.join(' ')}`;
            if (!codeTerms.has(key)) {
              const codeHolders = new Set([winner]);
              for (const holder of this.sharedCodeHolders.get(code) ?? []) {
                codeHolders.add(holder.airport.id);
              }
              codeTerms.set(key, { codeHolders, tokens });
              if (words.length === 1) exactCodeHolders = codeHolders;
            }
          }
        }
      }
      for (const token of tokens) queryTokens.push(token);
    }
    const terms = [...codeTerms.values()];
    if (textTokens.size > 0) terms.push({ codeHolders: undefined, tokens: [...textTokens] });
    return { exactCodeHolders, queryTokens, terms };
  }

  private loadRunways(csv: string): void {
    forEachRow(csv, (r) => {
      const airportRef = int(r.get('airport_ref'));
      if (airportRef === undefined) return;
      const runway: Runway = {
        id: reqInt(r.get('id'), 'runways.id'),
        airportRef,
        airportIdent: reqStr(r.get('airport_ident'), 'runways.airport_ident'),
        lighted: bool(r.get('lighted')),
        closed: bool(r.get('closed')),
        ...compact({
          lengthFt: int(r.get('length_ft')),
          widthFt: int(r.get('width_ft')),
          surface: str(r.get('surface')),
          leIdent: str(r.get('le_ident')),
          leLatitudeDeg: num(r.get('le_latitude_deg')),
          leLongitudeDeg: num(r.get('le_longitude_deg')),
          leElevationFt: int(r.get('le_elevation_ft')),
          leHeadingDegT: num(r.get('le_heading_degT')),
          leDisplacedThresholdFt: int(r.get('le_displaced_threshold_ft')),
          heIdent: str(r.get('he_ident')),
          heLatitudeDeg: num(r.get('he_latitude_deg')),
          heLongitudeDeg: num(r.get('he_longitude_deg')),
          heElevationFt: int(r.get('he_elevation_ft')),
          heHeadingDegT: num(r.get('he_heading_degT')),
          heDisplacedThresholdFt: int(r.get('he_displaced_threshold_ft')),
        }),
      };
      pushToMap(this.runwaysByAirportRef, airportRef, runway);
    });
  }

  private loadFrequencies(csv: string): void {
    forEachRow(csv, (r) => {
      const airportRef = int(r.get('airport_ref'));
      if (airportRef === undefined) return;
      const freq: Frequency = {
        id: reqInt(r.get('id'), 'airport-frequencies.id'),
        airportRef,
        airportIdent: reqStr(r.get('airport_ident'), 'airport-frequencies.airport_ident'),
        type: reqStr(r.get('type'), 'airport-frequencies.type'),
        ...compact({
          description: str(r.get('description')),
          frequencyMhz: num(r.get('frequency_mhz')),
        }),
      };
      pushToMap(this.frequenciesByAirportRef, airportRef, freq);
    });
  }

  private loadNavaids(csv: string): void {
    const lats: number[] = [];
    const lons: number[] = [];

    forEachRow(csv, (r) => {
      const lat = num(r.get('latitude_deg'));
      const lon = num(r.get('longitude_deg'));
      if (lat === undefined || lon === undefined) return;

      const navaid: Navaid = {
        id: reqInt(r.get('id'), 'navaids.id'),
        ident: reqStr(r.get('ident'), 'navaids.ident'),
        name: reqStr(r.get('name'), 'navaids.name'),
        type: reqStr(r.get('type'), 'navaids.type'),
        latitudeDeg: lat,
        longitudeDeg: lon,
        ...compact({
          // Upstream writes -1 for an unknown frequency (closed navaids).
          frequencyKhz: positiveInt(r.get('frequency_khz')),
          elevationFt: int(r.get('elevation_ft')),
          isoCountry: str(r.get('iso_country')),
          dmeFrequencyKhz: positiveInt(r.get('dme_frequency_khz')),
          dmeChannel: str(r.get('dme_channel')),
          slavedVariationDeg: num(r.get('slaved_variation_deg')),
          magneticVariationDeg: num(r.get('magnetic_variation_deg')),
          usageType: str(r.get('usageType')),
          power: str(r.get('power')),
          associatedAirport: str(r.get('associated_airport')),
        }),
      };

      // navaidList index == coordinate index (both arrays grow in lockstep).
      this.navaidList.push(navaid);
      pushToMap(this.navaidIdentIndex, navaid.ident.toUpperCase(), navaid);
      lats.push(lat);
      lons.push(lon);

      if (navaid.associatedAirport) {
        pushToMap(this.navaidsByAirportIdent, navaid.associatedAirport.toUpperCase(), navaid);
      }
    });

    const coords = new Float64Array(lats.length * 2);
    for (let i = 0; i < lats.length; i++) {
      coords[i * 2] = lats[i] as number;
      coords[i * 2 + 1] = lons[i] as number;
    }
    this.navaidCoords = coords;
  }

  // ---- Accessors ------------------------------------------------------------

  /**
   * When the bundled OurAirports data was published (ISO 8601 UTC): the mirror's
   * `Last-Modified`, so rebuilding unchanged data keeps it. Null when the data
   * directory has no snapshot.json.
   */
  get dataAsOf(): string | null {
    return this.snapshot?.sourceLastModified ?? null;
  }

  /**
   * Resolve a code (any of IATA/ICAO/GPS/local/ident, case-insensitive) to its
   * airport. Returns the match, which code space hit, and every other airport
   * carrying the same string in any space. Returns `undefined` when no code
   * matches (the tool turns that into `unknown_code`).
   */
  resolveByCode(code: string): CodeResolution | undefined {
    const upper = code.trim().toUpperCase();
    if (upper.length === 0) return;
    const id = this.codeIndex.get(upper);
    if (id === undefined) return;
    const airport = this.airportsById.get(id);
    if (!airport) return;
    return {
      airport,
      resolvedVia: this.codeVia.get(upper) ?? 'ident',
      sharedWith: this.sharedCodeHolders.get(upper) ?? [],
    };
  }

  /** Runways for an airport (by its integer id), or `[]` when it has none. */
  runwaysForAirport(id: number): Runway[] {
    return this.runwaysByAirportRef.get(id) ?? [];
  }

  /** Frequencies for an airport (by its integer id), or `[]` when it has none. */
  frequenciesForAirport(id: number): Frequency[] {
    return this.frequenciesByAirportRef.get(id) ?? [];
  }

  /** Look up a country by alpha-2 code (case-insensitive). */
  country(code: string | undefined): Country | undefined {
    if (!code) return;
    return this.countriesByCode.get(code.toUpperCase());
  }

  /** Look up a region by ISO 3166-2 code (case-insensitive). */
  region(code: string | undefined): Region | undefined {
    if (!code) return;
    return this.regionsByCode.get(code.toUpperCase());
  }

  /**
   * Full-text + faceted airport search. Filters the complete corpus (not a
   * page): AND across terms with exact code matches and forward text prefixes.
   * Applies the country/region facets and the shared `AirportFacets`.
   */
  search(filters: SearchFilters): SearchResult {
    // A query of only stopwords/punctuation tokenizes to nothing. That is NOT
    // the same as an omitted/blank query (which browses by facets): the caller
    // supplied search intent that matched no searchable term, so return zero
    // with a flag the tool turns into a "no searchable terms" notice (#3).
    const query = filters.query?.trim() ?? '';
    const { exactCodeHolders, queryTokens, terms } = this.queryTerms(query);
    if (query && terms.length === 0) {
      return { airports: [], totalMatched: 0, noSearchableTerms: true };
    }
    const upperQuery = query.toUpperCase();
    const country = filters.country?.toUpperCase();
    const region = filters.region?.toUpperCase();
    /**
     * A one-word code query leads with a tier of its code holders and the airports
     * whose municipality is that word; a municipality holder wins a score tie (#38).
     */
    type Candidate = { airport: Airport; tier: number; score: number; city: number; order: number };
    const compareRank = (
      airport: Airport,
      tier: number,
      score: number,
      city: number,
      b: Candidate,
    ) =>
      b.tier - tier ||
      b.score - score ||
      b.city - city ||
      airport.name.localeCompare(b.airport.name);
    const compare = (a: Candidate, b: Candidate) =>
      compareRank(a.airport, a.tier, a.score, a.city, b) || a.order - b.order;
    const page = new RankedPage(filters.limit, filters.offset ?? 0, compare);
    let totalMatched = 0;

    for (const airport of this.airportsById.values()) {
      if (!passesAirportFacets(airport, filters)) continue;
      if (country && airport.isoCountry?.toUpperCase() !== country) continue;
      if (region && airport.isoRegion?.toUpperCase() !== region) continue;

      const text = this.textByAirportId.get(airport.id);
      if (!text) continue;
      if (
        !terms.every(
          ({ codeHolders, tokens: needles }) =>
            codeHolders?.has(airport.id) ||
            needles.every((needle) => matchesTextToken(text.tokens, needle)),
        )
      )
        continue;
      const city = exactCodeHolders && containsPhrase(text.municipality, queryTokens) ? 1 : 0;
      const tier = city || exactCodeHolders?.has(airport.id) ? 1 : 0;
      const score = scoreAirport(airport, upperQuery, queryTokens, text.name);
      const order = totalMatched++;
      // Later dataset rows lose comparator ties. Reject before allocating a candidate.
      const worst = page.worst;
      if (worst && compareRank(airport, tier, score, city, worst) >= 0) continue;
      page.offer({ airport, tier, score, city, order });
    }

    return {
      airports: page.rows().map((m) => m.airport),
      totalMatched,
    };
  }

  /**
   * Runway-attribute search across the whole corpus, joined back to airports.
   * Mirrors `search()`'s airport-first filter order: airport-level facets
   * (country/region and the shared `AirportFacets`) narrow the airport set
   * first, then each surviving airport's runways are filtered by
   * surface (case-insensitive substring), min length/width, lighting, and the
   * closed-runway flag. Returns one row per runway in airport/runway traversal
   * order, or in parent-airport distance order when a spatial filter is set.
   *
   * Sparse thresholds exclude: when `minLengthFt`/`minWidthFt` is set, a runway
   * with an unknown value for that field is dropped, never assumed to pass — the
   * server can't claim a runway meets a threshold it has no data for.
   */
  searchRunways(filters: RunwaySearchFilters): RunwaySearchResult {
    const country = filters.country?.toUpperCase();
    const region = filters.region?.toUpperCase();
    const surfaces = typeof filters.surface === 'string' ? [filters.surface] : filters.surface;
    const fragments = surfaces?.map((fragment) => fragment.trim().toLowerCase());
    const { spatial } = filters;
    const airportFacets: AirportFacets = {
      ...filters,
      includeClosed: filters.includeClosedAirports,
    };
    const offset = filters.offset ?? 0;
    const matches: RunwayMatch[] = [];
    type Candidate = { airport: Airport; runway: Runway; distanceKm: number; order: number };
    const page = spatial
      ? new RankedPage<Candidate>(
          filters.limit,
          offset,
          (a, b) => a.distanceKm - b.distanceKm || a.order - b.order,
        )
      : undefined;
    let totalMatched = 0;

    for (const airport of this.airportsById.values()) {
      if (!passesAirportFacets(airport, airportFacets)) continue;
      if (country && airport.isoCountry?.toUpperCase() !== country) continue;
      if (region && airport.isoRegion?.toUpperCase() !== region) continue;

      const runways = this.runwaysByAirportRef.get(airport.id);
      if (!runways) continue;
      let distanceKm: number | null = null;
      if (spatial) {
        distanceKm = haversineKm(
          spatial.latitude,
          spatial.longitude,
          airport.latitudeDeg,
          airport.longitudeDeg,
        );
        if (distanceKm > spatial.radiusKm) continue;
      }

      for (const runway of runways) {
        if (!filters.includeClosedRunways && runway.closed) continue;
        if (filters.lighted !== undefined && runway.lighted !== filters.lighted) continue;
        if (
          filters.minLengthFt !== undefined &&
          (runway.lengthFt === undefined || runway.lengthFt < filters.minLengthFt)
        )
          continue;
        if (
          filters.minWidthFt !== undefined &&
          (runway.widthFt === undefined || runway.widthFt < filters.minWidthFt)
        )
          continue;
        if (fragments) {
          const surface = runway.surface?.trim().toLowerCase();
          if (surface === undefined || !fragments.some((fragment) => surface.includes(fragment)))
            continue;
        }
        const order = totalMatched++;
        if (page && distanceKm !== null) page.offer({ airport, runway, distanceKm, order });
        else if (order >= offset && matches.length < filters.limit)
          matches.push({ airport, runway, distanceKm: null, bearingDeg: null });
      }
    }

    if (page && spatial) {
      return {
        matches: page.rows().map(({ airport, runway, distanceKm }) => ({
          airport,
          runway,
          distanceKm,
          bearingDeg: bearingDeg(
            spatial.latitude,
            spatial.longitude,
            airport.latitudeDeg,
            airport.longitudeDeg,
          ),
        })),
        totalMatched,
      };
    }
    return { matches, totalMatched };
  }

  /**
   * Airports within `radiusKm` of a coordinate, nearest-first by great-circle
   * distance, filtered by the airport facets, capped at `limit`. Each carries
   * its distance and bearing from the query point; `totalMatched` counts every
   * filtered in-radius airport before the cap.
   */
  nearbyAirports(
    lat: number,
    lon: number,
    radiusKm: number,
    limit: number,
    facets: AirportFacets,
    offset = 0,
  ): NearbyAirportsResult {
    const accept = (i: number): boolean => {
      const id = this.airportCoordIds[i];
      if (id === undefined) return false;
      const airport = this.airportsById.get(id);
      return airport !== undefined && passesAirportFacets(airport, facets);
    };
    const { hits, total } = nearest(this.airportCoords, lat, lon, radiusKm, limit, accept, offset);
    return {
      airports: hits.map((h) => {
        const airport = this.airportsById.get(this.airportCoordIds[h.index] as number) as Airport;
        return {
          airport,
          distanceKm: h.distanceKm,
          bearingDeg: bearingDeg(lat, lon, airport.latitudeDeg, airport.longitudeDeg),
        };
      }),
      totalMatched: total,
    };
  }

  /**
   * Navaids within `radiusKm` of a coordinate, nearest-first, optionally
   * filtered by navaid type, capped at `limit`; `totalMatched` counts every
   * type-filtered in-radius navaid before the cap.
   */
  nearbyNavaids(
    lat: number,
    lon: number,
    radiusKm: number,
    limit: number,
    type: string | undefined,
    offset = 0,
  ): NearbyNavaidsResult {
    const accept = (i: number): boolean => {
      if (!type) return true;
      const navaid = this.navaidList[i];
      return navaid?.type === type;
    };
    const { hits, total } = nearest(this.navaidCoords, lat, lon, radiusKm, limit, accept, offset);
    return {
      navaids: hits.map((h) => {
        const navaid = this.navaidList[h.index] as Navaid;
        return {
          navaid,
          distanceKm: h.distanceKm,
          bearingDeg: bearingDeg(lat, lon, navaid.latitudeDeg, navaid.longitudeDeg),
        };
      }),
      totalMatched: total,
    };
  }

  /**
   * Navaids associated with an airport ident, optionally filtered by type,
   * capped at `limit`, with the type-filtered total before the cap. An empty
   * list means the airport has no associated navaids (the tool distinguishes
   * this from "airport not found").
   */
  navaidsForAirport(
    ident: string,
    type: string | undefined,
    limit: number,
    offset = 0,
  ): AirportNavaidsResult {
    return navaidPage(this.navaidsByAirportIdent.get(ident.toUpperCase()), type, limit, offset);
  }

  /** Page through the exact ident's holders in dataset order, after filtering by type. */
  navaidsByIdent(
    ident: string,
    type: string | undefined,
    limit: number,
    offset = 0,
  ): AirportNavaidsResult {
    return navaidPage(this.navaidIdentIndex.get(ident.trim().toUpperCase()), type, limit, offset);
  }

  /**
   * List countries present in the dataset (with airport counts), optionally
   * filtered by country and continent together, optionally with their regions nested.
   */
  listCountries(
    continent: string | undefined,
    includeRegions: boolean,
    countryCode?: string,
  ): CountrySummary[] {
    const cont = continent?.toUpperCase();
    const out: CountrySummary[] = [];

    for (const country of this.countriesByCode.values()) {
      if (countryCode && country.code.toUpperCase() !== countryCode.toUpperCase()) continue;
      if (cont && country.continent?.toUpperCase() !== cont) continue;
      const summary: CountrySummary = {
        code: country.code,
        name: country.name,
        ...(country.continent && { continent: country.continent }),
        airportCount: this.airportCountByCountry.get(country.code.toUpperCase()) ?? 0,
      };
      if (includeRegions) summary.regions = this.regionsForCountry(country.code);
      out.push(summary);
    }

    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private regionsForCountry(countryCode: string): RegionSummary[] {
    const cc = countryCode.toUpperCase();
    const regions: RegionSummary[] = [];
    for (const region of this.regionsByCode.values()) {
      if (region.isoCountry?.toUpperCase() !== cc) continue;
      regions.push({
        code: region.code,
        name: region.name,
        airportCount: this.airportCountByRegion.get(region.code.toUpperCase()) ?? 0,
      });
    }
    regions.sort((a, b) => a.name.localeCompare(b.name));
    return regions;
  }
}

/**
 * The airport-level facets every airport scan applies. `closed` is a type, so a
 * `type` facet decides closed airports on its own and `includeClosed` widens
 * only an untyped scan. Reads fields only: nothing is allocated per airport.
 */
function passesAirportFacets(airport: Airport, facets: AirportFacets): boolean {
  const { type, scheduledService } = facets;
  if (type ? airport.type !== type : !facets.includeClosed && airport.type === 'closed')
    return false;
  return scheduledService === undefined || airport.scheduledService === scheduledService;
}

function navaidPage(
  all: Navaid[] | undefined,
  type: string | undefined,
  limit: number,
  offset: number,
): AirportNavaidsResult {
  if (!all) return { navaids: [], totalMatched: 0 };
  if (!type) return { navaids: all.slice(offset, offset + limit), totalMatched: all.length };
  const navaids: Navaid[] = [];
  let totalMatched = 0;
  for (const navaid of all) {
    if (navaid.type !== type) continue;
    const order = totalMatched++;
    if (order >= offset && navaids.length < limit) navaids.push(navaid);
  }
  return { navaids, totalMatched };
}

/**
 * Token match allowing forward prefix hits: a query token matches an indexed
 * token it is a prefix of (so "intern" matches "international"). The reverse
 * direction is intentionally absent — a query token must NOT match a shorter
 * indexed token that is merely a prefix of it, or a gibberish query like
 * "xqzzywvu" would match any airport carrying a bare "x" token (#1).
 */
function hasTokenPrefix(haystack: Set<string>, needle: string): boolean {
  if (haystack.has(needle)) return true;
  for (const t of haystack) {
    if (t.startsWith(needle)) return true;
  }
  return false;
}

function matchesTextToken(haystack: Set<string>, needle: string): boolean {
  if (hasTokenPrefix(haystack, needle)) return true;
  const alternative = NAME_ALTERNATIVES.get(needle);
  return alternative !== undefined && haystack.has(alternative);
}

/**
 * Name boost: 30 when the query tokens are the whole name, 10 when they appear
 * as consecutive name tokens, else 0. A query token also matches its
 * alternative, and the last may match as a forward prefix, which never counts
 * as the whole name.
 */
function nameScore(name: string[], query: string[]): number {
  const lastStart = name.length - query.length;
  let contained = false;
  for (let i = 0; i <= lastStart; i++) {
    let whole = lastStart === 0;
    const matches = query.every((token, j) => {
      const candidate = name[i + j] as string;
      if (candidate === token || candidate === NAME_ALTERNATIVES.get(token)) return true;
      whole = false;
      return j === query.length - 1 && candidate.startsWith(token);
    });
    if (matches && whole) return 30;
    contained ||= matches;
  }
  return contained ? 10 : 0;
}

/** Whether `query` appears in `tokens` as consecutive whole tokens. */
function containsPhrase(tokens: string[], query: string[]): boolean {
  const lastStart = tokens.length - query.length;
  for (let i = 0; i <= lastStart; i++) {
    if (query.every((token, j) => tokens[i + j] === token)) return true;
  }
  return false;
}

/**
 * Light relevance score: prefer operational over closed, larger airports over
 * smaller, scheduled-service fields, IATA equality, and name hits on the query.
 * Transparent ordering criteria — no synthetic composite "confidence".
 */
const TYPE_RANK: Record<string, number> = {
  large_airport: 6,
  medium_airport: 5,
  small_airport: 4,
  seaplane_base: 3,
  heliport: 2,
  balloonport: 1,
  closed: 0,
};

function scoreAirport(
  airport: Airport,
  query: string,
  queryTokens: string[],
  nameTokens: string[],
): number {
  let score = (TYPE_RANK[airport.type] ?? 0) * 10;
  if (airport.scheduledService) score += 5;
  if (query) {
    if (airport.iataCode?.toUpperCase() === query) score += 50;
    score += nameScore(nameTokens, queryTokens);
  }
  return score;
}

// --- Init/accessor pattern ---

let _service: AirportDataService | undefined;

/**
 * Construct the service (resolving the data dir from config or the bundled
 * default). Call `load()` on the returned instance during `setup()`.
 */
export function initAirportDataService(_config: AppConfig): AirportDataService {
  const dataDir = getServerConfig().dataDir ?? resolveBundledDataDir();
  _service = new AirportDataService(dataDir);
  return _service;
}

export function getAirportDataService(): AirportDataService {
  if (!_service) {
    throw new Error(
      'AirportDataService not initialized — call initAirportDataService() in setup()',
    );
  }
  return _service;
}
