# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-18

Adds `ourairports_search_runways` — cross-airport runway-attribute search over the bundled corpus by airport facets (country/region/type) and runway facets (surface, min length/width, lighting), one flat airport-plus-runway row per match (#8).

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-07-18

Definition fixes: get_airport gains an `included` field to disambiguate omitted vs empty relations (#5), find_navaids resolves unknown_code at the tool boundary with its recovery hint (#6), and code/facet inputs trim whitespace at the schema boundary (#7). Adopts mcp-ts-core ^0.10.14 with supply-chain install guards.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-30 · 🛡️ Security

Search and lookup fixes: forward-only token-prefix matching, an ident-priority code index, and a distinct no-searchable-terms notice; find_airports and find_navaids now honor OURAIRPORTS_DEFAULT_SEARCH_LIMIT clamped to 50. Clears a medium-severity transitive js-yaml DoS advisory and refreshes framework + dev-deps.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-20

mcp-ts-core ^0.10.6 → ^0.10.9 maintenance — adopts the check-dependency-specifiers and plugin-manifest devcheck guards, re-syncs framework skills + scripts, refreshes dev-deps. No server behavior change.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-15

Add public hosted endpoint at https://ourairports.caseyjhand.com/mcp.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-14

Metadata fixes: scope the README title to the published npm name and add the MCPB manifest repository link.

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Initial release: offline OurAirports reference — 5 tools, airport:// resource, bundled on-disk index with code resolution and haversine nearest-airport geo.
