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
import type {
  Airport,
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
const NAME_EXPANSIONS = new Map([
  ['intl', 'international'],
  ['rgnl', 'regional'],
  ['muni', 'municipal'],
  ['fld', 'field'],
  ['mem', 'memorial'],
]);

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
 * Tokenize a string for the text-search index: lowercase, strip diacritics,
 * replace non-alphanumerics with spaces, split, drop short stopwords.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
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

  /** Per-airport token set, parallel to `airportCoordIds` is NOT assumed — keyed by id. */
  private readonly tokensByAirportId = new Map<number, Set<string>>();

  private loaded = false;

  constructor(private readonly dataDir: string) {}

  /** Parse all six CSVs and build every index. Idempotent. */
  async load(): Promise<void> {
    if (this.loaded) return;
    const started = performance.now();

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
          airports: this.airportsById.size,
          runways: this.runwaysByAirportRef.size,
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
    const tokens = new Set<string>();
    for (const t of tokenize(airport.name)) tokens.add(t);
    if (airport.municipality) for (const t of tokenize(airport.municipality)) tokens.add(t);
    if (airport.keywords) for (const t of tokenize(airport.keywords)) tokens.add(t);
    this.tokensByAirportId.set(airport.id, tokens);
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
   * Applies country/region/type facets and excludes closed airports by default.
   */
  search(filters: SearchFilters): SearchResult {
    // A query of only stopwords/punctuation tokenizes to nothing. That is NOT
    // the same as an omitted/blank query (which browses by facets): the caller
    // supplied search intent that matched no searchable term, so return zero
    // with a flag the tool turns into a "no searchable terms" notice (#3).
    const query = filters.query?.trim() ?? '';
    const terms: SearchTerm[] = [];
    let exactCodeHolders: ReadonlySet<number> | undefined;
    if (query) {
      const words = query.split(/\s+/);
      for (const word of words) {
        const tokens = tokenize(word);
        if (tokens.length === 0) continue;
        const code = word.toUpperCase();
        const winner = this.codeIndex.get(code);
        const codeHolders = winner === undefined ? undefined : new Set([winner]);
        if (codeHolders) {
          for (const holder of this.sharedCodeHolders.get(code) ?? []) {
            codeHolders.add(holder.airport.id);
          }
          if (words.length === 1) exactCodeHolders = codeHolders;
        }
        terms.push({ tokens, codeHolders });
      }
    }
    if (query && terms.length === 0) {
      return { airports: [], totalMatched: 0, noSearchableTerms: true };
    }
    const queryTokens = terms.flatMap((term) => term.tokens);
    const upperQuery = query.toUpperCase();
    const expandedNameTerms = queryTokens.some((token) => NAME_EXPANSIONS.has(token))
      ? queryTokens
      : undefined;
    const country = filters.country?.toUpperCase();
    const region = filters.region?.toUpperCase();
    type Candidate = { airport: Airport; exactCode: number; score: number; order: number };
    const compareRank = (airport: Airport, exactCode: number, score: number, b: Candidate) =>
      b.exactCode - exactCode || b.score - score || airport.name.localeCompare(b.airport.name);
    const compare = (a: Candidate, b: Candidate) =>
      compareRank(a.airport, a.exactCode, a.score, b) || a.order - b.order;
    const page = new RankedPage(filters.limit, filters.offset ?? 0, compare);
    let totalMatched = 0;

    for (const airport of this.airportsById.values()) {
      if (!filters.includeClosed && airport.type === 'closed') continue;
      if (filters.type && airport.type !== filters.type) continue;
      if (country && airport.isoCountry?.toUpperCase() !== country) continue;
      if (region && airport.isoRegion?.toUpperCase() !== region) continue;

      if (terms.length > 0) {
        const tokens = this.tokensByAirportId.get(airport.id);
        if (!tokens) continue;
        if (
          !terms.every(
            ({ codeHolders, tokens: needles }) =>
              codeHolders?.has(airport.id) ||
              needles.every((needle) => matchesTextToken(tokens, needle)),
          )
        )
          continue;
      }
      const exactCode = exactCodeHolders?.has(airport.id) ? 1 : 0;
      const score = scoreAirport(airport, upperQuery, expandedNameTerms);
      const order = totalMatched++;
      // Later dataset rows lose comparator ties. Reject before allocating a candidate.
      const worst = page.worst;
      if (worst && compareRank(airport, exactCode, score, worst) >= 0) continue;
      page.offer({ airport, exactCode, score, order });
    }

    return {
      airports: page.rows().map((m) => m.airport),
      totalMatched,
    };
  }

  /**
   * Runway-attribute search across the whole corpus, joined back to airports.
   * Mirrors `search()`'s airport-first filter order: airport-level facets
   * (country/region/type, closed airports excluded unless opted in) narrow the
   * airport set first, then each surviving airport's runways are filtered by
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
      if (!filters.includeClosedAirports && airport.type === 'closed') continue;
      if (filters.type && airport.type !== filters.type) continue;
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
   * distance, filtered by type/closed, capped at `limit`. Each carries its
   * distance and bearing from the query point; `totalMatched` counts every
   * filtered in-radius airport before the cap.
   */
  nearbyAirports(
    lat: number,
    lon: number,
    radiusKm: number,
    limit: number,
    type: string | undefined,
    includeClosed: boolean,
    offset = 0,
  ): NearbyAirportsResult {
    const accept = (i: number): boolean => {
      const id = this.airportCoordIds[i];
      if (id === undefined) return false;
      const airport = this.airportsById.get(id);
      if (!airport) return false;
      if (!includeClosed && airport.type === 'closed') return false;
      if (type && airport.type !== type) return false;
      return true;
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
  const expanded = NAME_EXPANSIONS.get(needle);
  return expanded !== undefined && haystack.has(expanded);
}

function expandedNameScore(name: string, queryTokens: string[]): number {
  const tokens = tokenize(name);
  const lastStart = tokens.length - queryTokens.length;
  for (let i = 0; i <= lastStart; i++) {
    const matches = queryTokens.every((query, j) => {
      const token = tokens[i + j];
      return token === query || token === NAME_EXPANSIONS.get(query);
    });
    if (matches) return lastStart === 0 ? 30 : 10;
  }
  return 0;
}

/**
 * Light relevance score: prefer operational over closed, larger airports over
 * smaller, scheduled-service fields, and exact name/code hits on the query.
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
  expandedNameTerms: string[] | undefined,
): number {
  let score = (TYPE_RANK[airport.type] ?? 0) * 10;
  if (airport.scheduledService) score += 5;
  if (query) {
    if (airport.iataCode?.toUpperCase() === query || airport.icaoCode?.toUpperCase() === query)
      score += 50;
    const upperName = airport.name.toUpperCase();
    if (upperName === query) score += 30;
    else if (expandedNameTerms) {
      const expanded = expandedNameScore(airport.name, expandedNameTerms);
      score += upperName.includes(query) ? Math.max(10, expanded) : expanded;
    } else if (upperName.includes(query)) score += 10;
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
