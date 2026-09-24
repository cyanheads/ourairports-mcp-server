# ourairports-mcp-server — Design

Global aviation reference data (airports, runways, navaids, radio frequencies) from the public-domain OurAirports dataset, served offline from a bundled on-disk index. Zero runtime API dependency: no key, no rate limit, no upstream outage.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ourairports_search_airports` | The 80% entry point. Full-text and faceted search over the bundled airport corpus by name, municipality, country, region, or type. Returns ranked summaries with codes and coordinates for chaining into `ourairports_get_airport`. Closed airports are excluded by default. | `query` (text, optional), `country` (ISO 3166-1 alpha-2, optional), `region` (ISO 3166-2, optional), `type` (enum, optional), `include_closed` (bool, default false), `limit` (1–100, default 20) | `readOnlyHint: true`, `openWorldHint: false` |
| `ourairports_search_runways` | Cross-airport runway search. Filters the bundled runway corpus by airport facets (country, region, type) and runway facets (surface, min length/width, lighting), joined back to airport summaries. Returns one flat `{ airport, runway }` row per matching runway — the counterpart to `ourairports_get_airport`'s per-airport runway list. | `country`/`region`/`type` (optional), `surface` (substring, optional), `min_length_ft`/`min_width_ft` (optional), `lighted` (bool, optional), `include_closed_airports`/`include_closed_runways` (bool, default false), `limit` (1–100, default 20) | `readOnlyHint: true`, `openWorldHint: false` |
| `ourairports_get_airport` | Full record for one airport resolved by any code (IATA / ICAO / GPS / local / OurAirports ident), with its runways and radio frequencies inline. The detail tool — one call returns everything the common case needs. | `code` (string, required), `include` (array of `runways`/`frequencies`, default both) | `readOnlyHint: true`, `openWorldHint: false` |
| `ourairports_find_airports` | Airports within a radius of a coordinate, ranked nearest-first by great-circle distance. The grounding tool the live aviation servers call to turn a lat/lon into the nearest airport(s) before fetching weather or flight positions. Coordinate in, ranked airports out — no geocoding (resolve place names upstream first). Reports the filtered in-radius count before `limit` and discloses truncation. | `latitude` (−90…90, required), `longitude` (−180…180, required), `radius_km` (1–500, default 100), `type` (enum, optional), `include_closed` (bool, default false), `limit` (1–50, default 20) | `readOnlyHint: true`, `openWorldHint: false` |
| `ourairports_find_navaids` | Navigation aids (VOR / VOR-DME / DME / NDB / NDB-DME / TACAN / VORTAC) near a coordinate or serving a specific airport. Returns identifier, type, frequency (in kHz for all types — VOR 114.5 MHz is stored as 114500 kHz — plus MHz only for types with a VHF or paired-VHF frequency, null for NDB/NDB-DME), DME paired frequency, usage class, power, actual and slaved magnetic variation, position, and bearing/distance from the query point. Reports the match count before `limit` in both modes and discloses truncation. | `latitude` + `longitude` (+ `radius_km`, 1–500, default 100) **or** `airport_code` (string); one mode required. `type` (enum, optional), `limit` (1–50, default 20) | `readOnlyHint: true`, `openWorldHint: false` |
| `ourairports_list_countries` | List the countries (and optionally their regions) present in the dataset with ISO codes and airport counts. The lookup table for valid `country`/`region` filter values used by `ourairports_search_airports`. | `continent` (enum, optional), `include_regions` (bool, default false) | `readOnlyHint: true`, `openWorldHint: false` |

**Tool count: 6.** All read-only, all local queries against the bundled index. No write tools, no destructive operations, no auth.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `airport://{code}` | Single airport record by any code (IATA / ICAO / GPS / local / ident), runways and frequencies inline. Stable-URI twin of `ourairports_get_airport` for clients that inject resource context. | None (single record) |

The resource is a convenience mirror of `ourairports_get_airport`; the full surface is reachable from tools alone (tool-only clients lose nothing). No `list()` — enumerating 85k airports as a resource list is an exhaustive dump, not a discovery aid; discovery is `ourairports_search_airports`.

### Prompts

None. This is a data/lookup server with no recurring multi-step interaction pattern worth templating.

## Overview

ourairports-mcp-server is the **static aviation reference layer** for the fleet's aviation cluster. The live servers — `aviation-weather-mcp-server` (METAR/TAF by ICAO), and prospective `opensky` (live positions) — answer *what is happening*; they don't carry *what exists*: the catalog of airports, their codes, runways, and radio frequencies. This server is that catalog, and the resolver the live servers ground against ("what's the ICAO for SEA?", "nearest airport to 47.6,-122.3?", "runway length at KJFK?").

It wraps no live API. The entire OurAirports dataset — every airport, runway, navaid, and frequency worldwide — is dedicated to the **public domain** and published as flat CSVs. Those CSVs are built into a bundled on-disk index at image-build time; at request time every tool is a local query. The result is the cleanest possible hostable server: no API key, no rate limit, no upstream dependency to inherit an outage from.

**Audience:** pilots and flight-sim users; aviation, logistics, and travel tooling; and agents resolving airport codes or grounding a coordinate in the nearest airport.

## Requirements

- **Offline / zero runtime API.** All data ships in the deployed artifact. No network calls on any tool path.
- **Code resolution across five identifier spaces.** Airports carry IATA (3-letter, ~9.1k of 85.5k have one), ICAO (4-letter, ~10.2k), GPS code (~44k), local code (~36k), and the OurAirports `ident` (universal PK-like string, often == ICAO or GPS). `ourairports_get_airport` accepts any and disambiguates; absence of a code (e.g. no IATA for a small field) is surfaced explicitly, never a 404.
- **Geospatial nearest-neighbour.** `ourairports_find_airports` and the coordinate mode of `ourairports_find_navaids` rank by great-circle (haversine) distance over bundled coordinates.
- **Data hygiene.** OurAirports is community-edited and includes `closed` airports (13.2k of 85.5k) and fine-grained `type` values (`large_airport` → `seaplane_base` → `balloonport`). Closed airports are filtered by default and opt-in via `include_closed`; `type` is an exposed filter.
- **Honest sparsity.** Missing upstream fields (no IATA, no elevation, null runway dimensions) are reported as unknown, never fabricated. Capped lists disclose truncation.
- **No auth, no rate limit, no secrets.** Single-tenant; `STORAGE_PROVIDER_TYPE` defaults to in-memory and is unused on the data path.
- **License.** Public domain (verified 2026-06-02 at ourairports.com/data: "All data is released to the Public Domain"). Bundling and redistribution unrestricted; attribution requested but not required. A `## Attribution` README line credits OurAirports as a courtesy.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `airport-data` | The bundled on-disk index built from the six OurAirports CSVs (airports, runways, navaids, airport-frequencies, countries, regions). Owns load-on-`setup()`, the in-memory indices, code resolution, full-text search, runway search, and the haversine nearest-neighbour scan. | All six tools + the `airport://` resource |

Single service — this is a server-as-source-of-truth, not an external-API wrapper, so the resilience table (retry/backoff/parse-classification) does not apply. There is no upstream to retry at request time. The design questions are state-shape and load, covered in Design Decisions.

**Service internals (indices built once at `setup()`):**

| Index | Shape | Backs |
|:------|:------|:------|
| `airportsById` | `Map<number, Airport>` keyed on `id` | runway/frequency/navaid joins |
| `codeIndex` | `Map<string, number>` — uppercased IATA, ICAO, GPS, local, and ident → `id` (multiple keys per airport). Built in global priority passes: ident → icao_code → iata_code → gps_code → local_code; higher-priority codes are never overwritten. A parallel `sharedCodeHolders` map lists, for each code string carried by more than one airport, every other airport and the spaces it carries it in. See collision analysis in Design Decisions. | `ourairports_get_airport`, `airport://{code}`, `ourairports_find_navaids` airport mode |
| `runwaysByAirportRef` | `Map<number, Runway[]>` keyed on `airport_ref` (int, joins to airports.`id`) | inline runways |
| `frequenciesByAirportRef` | `Map<number, Frequency[]>` keyed on `airport_ref` (int, joins to airports.`id`). Note: frequency field is `frequency_mhz` (e.g., 122.9). | inline frequencies |
| `navaidsByAirportIdent` | `Map<string, Navaid[]>` keyed on `associated_airport` (string, joins to airports.`ident`). Only populated for navaids where `associated_airport` is non-empty — roughly 67% of records. | navaids-by-airport mode |
| `airportCoords` | flat `Float64Array` (lat/lon) + parallel `id` array | haversine scan for both `find_*` tools |
| `countriesByCode` / `regionsByCode` | `Map<string, …>`. countries.csv has no `iso_country` column — its PK `code` is the alpha-2 itself. regions.csv has an additional `local_code` column (short regional code, e.g. `WA` for `US-WA`) — index but don't surface in output. | `ourairports_list_countries`, region/country name enrichment |
| text search | tokenized name+municipality+keywords index (lowercased, punctuation-stripped) over airports | `ourairports_search_airports` `query` |

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `OURAIRPORTS_DATA_DIR` | No | Directory holding the six CSV files. Defaults to a bundled `data/` path inside the package. Overridable for a custom/newer data drop. |
| `OURAIRPORTS_DEFAULT_SEARCH_LIMIT` | No | Default result cap for `search`/`find` tools when the caller omits `limit`. Default 20. |

No API keys, base URLs, or auth config. The data path needs no runtime configuration in the common case.

## Implementation Order

1. **Config + server setup** — `src/config/server-config.ts` (the two env vars above), `createApp({ name: 'ourairports-mcp-server', title: 'ourairports-mcp-server', … })`, ingest pipeline wired so `data/` exists before `setup()` (see Design Decisions: ingest).
2. **`airport-data` service** — CSV parse on `setup()`, build the indices table above, expose typed accessors: `resolveByCode`, `search`, `nearbyAirports`, `nearbyNavaids`, `navaidsForAirport`, `listCountries`. Types in `services/airport-data/types.ts`.
3. **Read-only tools** — `ourairports_list_countries` (no joins, simplest) → `ourairports_get_airport` (code resolution + joins) → `ourairports_search_airports` (text + facets) → `ourairports_find_airports` (haversine) → `ourairports_find_navaids` (two modes).
4. **Resource** — `airport://{code}`, delegating to the same service accessor as `ourairports_get_airport`.
5. **Prompts** — none.

Each step is independently testable: the service has unit tests over a fixture CSV slice; each tool tests against `createMockContext()` with the service initialized from the fixture.

## Domain Mapping

Six CSVs, verified live 2026-06-13 (`davidmegginson.github.io/ourairports-data/`). All six URLs return HTTP 200 with `Content-Type: text/csv`. Row counts and file sizes match the table below exactly (decimal MB). The join graph is the design's backbone.

| File | Data rows | Size | Primary key | Joins out |
|:-----|----------:|-----:|:------------|:----------|
| `airports.csv` | 85,572 | 12.6 MB | `id` (int) | — (the hub) |
| `runways.csv` | 48,011 | 3.95 MB | `id` | `airport_ref` → airports.`id`; `airport_ident` → airports.`ident` |
| `navaids.csv` | 11,009 | 1.5 MB | `id` | `associated_airport` → airports.`ident` (nullable) |
| `airport-frequencies.csv` | 30,288 | 1.3 MB | `id` | `airport_ref` → airports.`id`; `airport_ident` → airports.`ident` |
| `countries.csv` | 249 | 24.6 KB | `code` (alpha-2) | airports.`iso_country` → countries.`code` |
| `regions.csv` | 3,982 | 485 KB | `code` (e.g. `US-WA`) | airports.`iso_region` → regions.`code`; regions.`iso_country` → countries.`code` |

**Total: ~178k rows, ~19.9 MB raw CSV.** Built artifact (parsed objects + indices) is held in memory; estimated 60–120 MB resident, trivially within a container's footprint.

**airports.csv columns (verified against live CSV — column order matters for CSV parsers):** `id, ident, type, name, latitude_deg, longitude_deg, elevation_ft, continent, iso_country, iso_region, municipality, scheduled_service, icao_code, iata_code, gps_code, local_code, home_link, wikipedia_link, keywords`.

Note: the OurAirports data dictionary page lists gps_code before icao_code/iata_code, but the actual live CSV reverses that order (icao_code col 13, iata_code col 14, gps_code col 15). Always parse by column name (header row), not position.

**runways.csv columns:** `id, airport_ref, airport_ident, length_ft, width_ft, surface, lighted, closed, le_ident, le_latitude_deg, le_longitude_deg, le_elevation_ft, le_heading_degT, le_displaced_threshold_ft, he_ident, he_latitude_deg, he_longitude_deg, he_elevation_ft, he_heading_degT, he_displaced_threshold_ft`.

**navaids.csv columns:** `id, filename, ident, name, type, frequency_khz, latitude_deg, longitude_deg, elevation_ft, iso_country, dme_frequency_khz, dme_channel, dme_latitude_deg, dme_longitude_deg, dme_elevation_ft, slaved_variation_deg, magnetic_variation_deg, usageType, power, associated_airport`. Note `usageType` and `power` are camelCase (not snake_case). The `filename` column is an OurAirports internal slug — ignore in output.

**airport-frequencies.csv columns:** `id, airport_ref, airport_ident, type, description, frequency_mhz`. Frequency is in MHz (e.g., 122.9), not kHz.

**countries.csv columns:** `id, code, name, continent, wikipedia_link, keywords`. No `iso_country` column — the `code` field IS the alpha-2 country code (the PK). The `continent` column uses 2-letter codes (AF, AN, AS, EU, NA, OC, SA).

**regions.csv columns:** `id, code, local_code, name, continent, iso_country, wikipedia_link, keywords`. The `local_code` is a short regional identifier without country prefix (e.g., `WA` for `US-WA`). Index `local_code` only if needed for lookup; don't surface it in output where `code` (the ISO 3166-2 form) is unambiguous.

**Code-field population (drives resolution design):**

| Field | Populated | Note |
|:------|----------:|:-----|
| `ident` | 85,572 (all) | OurAirports internal id-string; the only universal key. Often == `icao_code` or `gps_code`. |
| `gps_code` | 44,340 | |
| `local_code` | 36,060 | National code (e.g. FAA `LID`). |
| `icao_code` | 10,209 | True 4-letter ICAO; many small fields lack one. |
| `iata_code` | 9,055 | 3-letter; rarest. Small fields/heliports usually have none. |

For a US small airport the row is `ident == gps_code == local_code` with empty ICAO and IATA (verified: `00AA`, `00AK`). This is why resolution must try all five fields and why "no IATA" is a reported attribute, not an error.

**Airport type enum (verified, all 7 values):** `small_airport` (42,681), `heliport` (23,082), `closed` (13,209), `medium_airport` (4,097), `seaplane_base` (1,263), `large_airport` (1,179), `balloonport` (61). Note `closed` is a `type` value, not a separate boolean column — `include_closed: false` filters rows where `type == "closed"`.

**Navaid type enum (verified, all 7 values):** `NDB` (6,610), `VOR-DME` (2,601), `VORTAC` (744), `TACAN` (442), `VOR` (308), `DME` (167), `NDB-DME` (137). Both compound types (`VOR-DME`, `NDB-DME`) must be in the `type` filter enum — `VOR-DME` is the 2nd most common type.

**Nouns × operations:**

| Noun | Operations | Exposure |
|:-----|:-----------|:---------|
| Airport | search, get-by-code, find-near-coordinate | `search_airports`, `get_airport`, `find_airports` |
| Runway | get (per airport), search (across airports) | inline in `get_airport`; `search_runways` for cross-airport attribute search (see Design Decisions) |
| Frequency | get (per airport) | inline in `get_airport` |
| Navaid | find-near-coordinate, find-by-airport | `find_navaids` (two modes) |
| Country / Region | list | `list_countries` |

## Workflow Analysis

No tool makes upstream calls (zero runtime API), so the canonical upstream-call table does not apply. The analysis worth recording is the **internal data flow** for the two non-trivial tools.

`ourairports_get_airport` (code → full record):

| # | Step | Source |
|:--|:-----|:-------|
| 1 | Uppercase `code`, look up in `codeIndex` → `id` | in-memory map |
| 2 | Fetch `Airport` from `airportsById` | in-memory map |
| 3 | If `include` ⊇ runways: `runwaysByAirportRef.get(id)` | in-memory map |
| 4 | If `include` ⊇ frequencies: `frequenciesByAirportRef.get(id)` | in-memory map |
| 5 | Enrich `iso_country`/`iso_region` with country/region names | in-memory maps |
| — | No match in `codeIndex` → `unknown_code` error, recovery hint: "Try `ourairports_search_airports` with a partial name or municipality" | — |
| — | Runways/frequencies absent (small fields often have none) → return empty array, not an error. Never omit the field. | — |
| — | `include` omits a relation from the request → its array is still present but empty (per the row above); the response's `included` field lists which relations were actually requested, so callers can tell an omitted relation (not in `included`) from a genuinely empty one (in `included` with an empty array) | — |
| — | Code carried by more than one airport → `resolutionNote` names every other holder (ident, country, code space) and whether priority or dataset row order picked the result; the caller passes the intended airport's `ident`, which always resolves to itself | `sharedCodeHolders` |

`ourairports_find_airports` (coordinate → ranked airports):

| # | Step | Source |
|:--|:-----|:-------|
| 1 | Validate lat/lon ranges | input schema |
| 2 | Linear haversine scan over `airportCoords`, filter by `type`/`include_closed`, keep within `radius_km` | `Float64Array` |
| 3 | Sort the in-radius hits by distance, take their count as `totalCount`, truncate the same array in place to `limit` (no second pass, no per-row allocation beyond the in-radius hits) | — |
| 4 | Hydrate the top-N `id`s to summary records, attach `distance_km` and `bearing_deg` | `airportsById` |
| — | More in-radius matches than `limit` → `truncated`/`shown`/`cap` + guidance to narrow `radius_km`, add `type`, or raise `limit` (no offset: results are nearest-first, so narrowing the radius is the precise recovery) | — |
| — | Empty within radius → empty result + `enrichment` notice suggesting a larger `radius_km` | — |

Step 2's linear scan over 85k coordinate pairs takes a few milliseconds on a `Float64Array`; no spatial index needed (see Design Decisions: geospatial).

## Design Decisions

**Data source — the GitHub-published CSV mirror, not the live ourairports.com API.** OurAirports has no query API; the canonical distribution *is* the CSV set, published daily at `davidmegginson.github.io/ourairports-data/` (confirmed in the mirror README, "updated daily"). Six files, ~19.9 MB total (verified 2026-06-13). The data README explicitly asks for no PRs — edits flow through ourairports.com accounts into the daily dump — so the GitHub artifact is the authoritative download.

**License — public domain, bundling is clean.** Verified 2026-06-02 at ourairports.com/data: "All data is released to the Public Domain." No redistribution limit, no attribution obligation, no anti-AI/anti-redistribution clause (the page explicitly OKs building a competing site). Factual data (codes, coordinates) is largely uncopyrightable regardless. A README attribution line is a courtesy, not a requirement. This clears the trap that blocks bundling some other community datasets.

**Ingest — fetch-and-build at image-build time, bundled into the artifact; not fetched at runtime.** A build script (`scripts/build-data.ts`, run before `bun run build` / in the Docker build stage) downloads the six CSVs from the GitHub mirror, parses and validates them, and writes a normalized `data/` payload into the package. The server loads that bundled payload on `setup()` — never the network. This keeps "zero runtime API" literally true and makes the image self-contained and reproducible. A weekly image rebuild (CI + Watchtower redeploy) refreshes the data; staleness between rebuilds is acceptable for reference data that changes slowly. `OURAIRPORTS_DATA_DIR` lets an operator point at a fresher local drop without rebuilding.

**Backend — in-memory indices, NOT MirrorService/SQLite, NOT DataCanvas.** Three options weighed against the skill's "Mirror a bulk upstream" tiering:
- *DataCanvas* — rejected. This is a discovery/lookup surface (resolve a code → drill into one record, or rank by distance), not analytical rows an agent runs `GROUP BY`/`JOIN` SQL over. The skill gates canvas on *analytical shape, not size*; a categorical search/lookup surface doesn't qualify regardless of row count. Emitting a `canvas_id` would also require a paired `dataframe_query` tool that has no purpose here.
- *MirrorService (embedded SQLite + FTS5)* — rejected for this corpus. The skill's tiering puts ≲ tens of thousands of rows in the in-memory tier and 10⁴–10⁷ in the SQLite tier; airports (85.5k) sits just over that boundary, but MirrorService's reason for existing is a *large or slow upstream API queried far more than it changes, synced incrementally on a schedule* (cursor/checkpoint state machine, init-vs-refresh, live fallback while cold). None of that applies: there is no per-request API, the whole corpus is a 20 MB static download already rebuilt wholesale at image time, and SQLite on the data path is unavailable on Cloudflare Workers (which this server is otherwise portable to). The cursor/checkpoint machinery would be dead weight against a bulk file replace.
- *In-memory indices built once on `setup()`* — chosen. ~178k parsed rows fit comfortably in memory (~60–120 MB). Every access pattern is an O(1) map lookup or a single O(n) scan over 85k coordinates (a few milliseconds). It is the simplest backend that serves the surface, has zero extra dependency, and is the only one that stays Workers-portable. The dataset is replaced wholesale at build time, so there is nothing to sync incrementally — the entire premise of a mirror's state machine is absent.

**Geospatial — brute-force haversine over a `Float64Array`, no spatial index.** Nearest-neighbour is a full scan of 85k coordinate pairs with a haversine distance, then a sort of the in-radius hits truncated to `limit`. At this scale the scan takes a few milliseconds; a k-d tree or geohash grid would add code and a dependency to optimize an operation that is already negligible. Coordinates live in a flat `Float64Array` (cache-friendly, no per-airport object deref in the hot loop) with a parallel `id` array; only the surviving top-N `id`s are hydrated to full records. Revisit only if profiling ever shows the scan as a bottleneck (it won't at 85k rows).

**Code resolution — single `code` param, uppercased, tried across all five identifier spaces.** Rather than separate `iata`/`icao`/`gps` params, `ourairports_get_airport` and `airport://{code}` take one `code` and resolve it against a unified `codeIndex` (IATA ∪ ICAO ∪ GPS ∪ local ∪ ident, all uppercased). Agents rarely know *which kind* of code they hold ("SEA" vs "KSEA" vs "47A"); one param matches how the data is actually queried. Surrounding whitespace is trimmed at the schema boundary (`z.string().trim()`) before the length/presence check, so a padded code normalizes instead of resolving as an unrelated string and a whitespace-only code fails validation rather than falling through to `unknown_code`. The same trim-then-reject pattern applies to the `country`/`region` search facets on `ourairports_search_airports`.

**Collision analysis (verified against the bundled 2026-06-13 data):** within its own space, each of `ident`, `icao_code`, `iata_code`, and `gps_code` is unique (0 duplicate strings); `local_code` is a national namespace that repeats (1,280 strings carried by more than one airport). Across spaces, 3,897 code strings belong to 2–6 airports (2,776 of them cross-country). 3,713 are decided by priority — the winner holds the string in a higher space than every other holder (e.g. `HBE` is Alexandria's IATA code and a local code in the US and Argentina) — and 184 by dataset row order, all ties within `local_code` (e.g. `HBI`). Priority also lets an ident shadow another airport's code: 27 IATA codes (`GIG`, `NCL`, …) and 43 ICAO codes resolve to a different airport whose ident is that string.

**codeIndex build order and collision handling:** The index is built after all airports load, in global priority passes — every `ident`, then every `icao_code`, `iata_code`, `gps_code`, and `local_code` — each pass insert-if-absent in CSV row order. Idents are unique, so an ident always resolves to its own airport and can never be pre-empted by an earlier row's national code (#2). When a later pass meets a string another airport already claimed, that airport and the space are recorded in `sharedCodeHolders`. The response's `resolutionNote` is built from those holders by one shared builder (`get_airport`, `airport://{code}`, and `find_navaids` airport mode): a code on one airport reads `Resolved via <space>.`; a shared code names every other airport (ident, country, code space), says whether priority or row order within the matched space picked this one, and tells the caller to pass the other airport's ident. The output always echoes the full code set, with absent codes as `null`, so "this field has no IATA" is first-class signal, not a 404.

Decision: keep ident-first priority even where an ident shadows a major airport's IATA code (`GIG` → a Canadian ranch strip, not Rio Galeão). 47 of the 70 shadowing airports have no other code that resolves to them (27 carry no other code at all), so ident-first is what keeps every airport reachable; the note names the IATA/ICAO owner instead of reordering resolution.

**Surface split by query shape — get-by-code rides inline in `get_airport`, cross-airport search is its own tool.** Per the skill's "cut the surface": the overwhelmingly common need is "give me this airport with its runways and frequencies," served in one `get_airport` call — separate `get_runways`/`get_frequencies` tools would split a single agent action for no benefit, so runways and frequencies stay inline there. A *different* query shape — runway-attribute **search** ("airports in US-WA with a paved runway ≥ 5,000 ft") — is not get-by-code and earns its own tool, `ourairports_search_runways`. Four decisions shape it: (1) **flat `{ airport, runway }` rows, not grouped-by-airport** — mirrors `find_airports`'s `{ airport, distanceKm, bearingDeg }` shape and keeps `limit`/truncation unambiguous (one `limit` caps total rows; an airport with 3 matching runways contributes 3 rows), where a grouped shape would split `limit` between airports and runways and need its own per-airport truncation; (2) **`surface` is a case-insensitive substring match, not an enum** — the corpus has 654 distinct raw surface strings with no controlled vocabulary (`ASP`/`ASPH`/`Asphalt`/`ASPH-G` all mean asphalt), so an exact/enum filter would silently miss most real queries; (3) **unknown length/width is excluded, never assumed to pass** when `min_length_ft`/`min_width_ft` is set — the server can't claim a runway meets a threshold it has no data for; (4) **length is the full runway surface, reported with its displaced thresholds** — OurAirports defines `length_ft` as the whole surface including displaced thresholds and overruns, so `lengthFt` and `min_length_ft` are described that way and every runway carries `leDisplacedThresholdFt`/`heDisplacedThresholdFt` (`null` when the cell is empty, never `0`); no usable takeoff/landing distance is derived, since that needs declared-distance data (TORA/LDA) the dataset lacks. Navaids get their own tool only because their primary access is *near a coordinate* (independent of any airport), which `get_airport` can't express.

**`find_navaids` two-mode input (coordinate OR airport), validated to exactly one.** Navaids are queried two ways — spatially (near a position) and relationally (serving a named airport via `associated_airport`). Rather than two tools, one tool with a validated "exactly one mode" input. Coordinate mode reuses the haversine scan (over the 11k navaid coordinates); airport mode is a map lookup on `navaidsByAirportIdent`. The mode is inferred from which inputs are present; supplying both or neither is a `validationError`.

**`associated_airport` is nullable — ~33% of navaids have no airport link.** The `associated_airport` column in navaids.csv is empty for a non-trivial fraction of records (e.g., standalone ocean/enroute VORs). These navaids appear only in coordinate-mode searches, never in airport-mode lookups. The tool's airport mode returns an empty list (not an error) when the airport exists but has no associated navaids — the response must distinguish "airport not found" (`unknown_code` error) from "airport found but has no navaids" (empty list with an explanatory note). The note names the airport by ident only: notices ride in `structuredContent` as well as the text trailer, where an interpolated upstream name would reach Markdown unescaped, and `get_airport` already returns the name.

**Navaid type enum includes compound types.** The actual type values in the dataset are: `NDB` (6,610), `VOR-DME` (2,601), `VORTAC` (744), `TACAN` (442), `VOR` (308), `DME` (167), `NDB-DME` (137). The `type` filter enum must include `VOR-DME` and `NDB-DME` — omitting them would make those 2,738 records unfilterable. All frequencies are stored in `frequency_khz` regardless of navaid type (VOR 114.5 MHz → 114500 kHz); format output accordingly.

**Navaid MHz is keyed on type, not value range.** The OurAirports data dictionary defines `frequency_khz ÷ 1000` as a VHF frequency for VOR and VOR-DME and a paired VHF frequency for DME, TACAN, and VORTAC; NDB and NDB-DME are tuned in kHz directly. `frequencyMhz` follows that split and is `null` for NDB/NDB-DME. Decision: type, not a 108–118 MHz window — 26 TACANs on channels 1X–16X and 60X–69X carry paired frequencies of 133.3–135.5 MHz that a range check would wrongly drop. Four closed navaids store `-1` as an unknown frequency; the parser drops non-positive values, so both fields read `null`. `dmeFrequencyKhz` is the DME component's paired VHF frequency on every type (on NDB-DME it differs from `frequency_khz`), so the NDB rule never applies to it.

**Service-volume fields pass through verbatim.** `usageType`, `power`, `magneticVariationDeg`, `slavedVariationDeg`, and `dmeFrequencyKhz` are exposed as recorded, with empty cells as `null` and a stored `0` kept as `0`. Decision: no remapping or suitability score — `TERMINAL` is kept although the data dictionary spells it `TERM`, and `UNKNOWN` power stays distinct from an empty cell. `slavedVariationDeg` ships beside `magneticVariationDeg` because VOR radials are referenced to the slaved value, which differs from the actual variation by 1.7° on average; DME position and elevation (≈2% populated) are left out.

**`content[]` text matches `structuredContent`.** Coordinates render as the exact stored numbers (default number-to-string, no fixed decimals), so text-only clients see the same values as structured ones. Upstream text is Markdown-escaped at the render boundary only, by one shared `escapeMarkdown` helper in `_schemas.ts`; `structuredContent` keeps the raw value. The helper escapes only characters that can open or close a construct where the value lands (backslash, backtick, `*`, `~`, non-intraword `_`, `<` before a tag-like character or ending the value (template text such as the `/` between runway ends follows it), `]` before `(`/`[`, `&` starting an entity, a trailing `#` run) plus leading block markers for the one value that opens a list item (the region code in `list_countries`). Decision: minimal over blanket escaping — `content` usually reaches a model unrendered, where every backslash is noise; blanket escaping of `[ ] & #` would also alter some 500 distinct values that render correctly today (`Sahabat [Sahabat 16] Airport`, `AT&T`), while the minimal rule changes 23 of ~251k and a CommonMark and GFM parse of every rendered record shows no mis-render. Known limit: GFM autolinks a bare `http://`/`www.` URL and ignores escapes inside it; no rendered value contains one.

**Closed airports filtered by default.** 13.2k of 85.5k airports are `type: "closed"`. They pollute search and nearest-neighbour results for the live-flight grounding use case. All search/find tools default `include_closed: false` and accept opt-in; `get_airport`/`airport://` never filter (an explicit code lookup should always resolve, closed or not).

**Repo keeps the OurAirports brand; tools use the `ourairports_` prefix.** Per the task constraint, display identity is the hyphenated machine name `ourairports-mcp-server` everywhere (`createApp` `name` and `title`, manifest, docs). Tool prefix is `ourairports_` to match the repo name exactly — the prefix every agent sees should be the server's identity. (The idea sketch floated a shorter `airports_` prefix to avoid `ourairports_search_airports` stutter; rejected here in favor of identity consistency — the stutter is cosmetic and the brand-matching prefix gives agents correct provenance.)

## Known Limitations

- **Community-edited, not authoritative for flight ops.** OurAirports is crowd-sourced; codes, coordinates, and especially runway/frequency details can be stale or wrong. The server surfaces the data as-is and must not be a sole source for real flight operations — the same caveat the live aviation-weather server carries. Worth a one-line note in the server `instructions` and tool descriptions where relevant.
- **No scheduled-service / route data.** OurAirports has `scheduled_service` (yes/no) but no routes, airlines, schedules, or live status. Those belong to other servers (the live aviation cluster) — out of scope here.
- **Data freshness is build-time, not live.** The bundled snapshot is as fresh as the last image build (target: weekly). For a brand-new airport added to OurAirports yesterday, the server lags until the next rebuild. `OURAIRPORTS_DATA_DIR` is the escape hatch for a fresher manual drop.
- **No geocoding.** `find_airports` takes a coordinate, not a place name. Resolving "Seattle" → lat/lon is an upstream concern (e.g. `openstreetmap`/`open-meteo` geocode) — keeps this server single-purpose and dependency-free.

## Future Additions (deferred)

- A "flight context" workflow tool — given two airport codes, return both records plus great-circle distance and bearing in one call (the moonshot from the idea sketch). Pure local computation; a clean addition once the core surface is field-tested.
