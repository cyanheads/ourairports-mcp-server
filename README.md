<div align="center">
  <h1>@cyanheads/ourairports-mcp-server</h1>
  <p><b>Resolve airport codes (IATA/ICAO/GPS/local), search airports, find the nearest by coordinate, and look up runways, navaids, and radio frequencies from the bundled public-domain OurAirports dataset via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ourairports-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ourairports-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ourairports-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ourairports-mcp-server/releases/latest/download/ourairports-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ourairports-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvb3VyYWlycG9ydHMtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ourairports-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fourairports-mcp-server%22%5D%7D)

</div>

<div align="center">

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://ourairports.caseyjhand.com/mcp](https://ourairports.caseyjhand.com/mcp)

</div>

---

## Overview

`ourairports-mcp-server` is the static aviation reference layer for resolving airport identifiers and grounding coordinates. It answers *what exists* — the catalog of airports, their codes, runways, navaids, and radio frequencies — to complement live aviation services that answer *what is happening* (weather, positions).

The entire [OurAirports](https://ourairports.com/) dataset is dedicated to the public domain and published as flat CSVs. Those six CSV files — airports, runways, navaids, airport frequencies, countries, and regions (~178k rows, ~20 MB) — are **bundled into the package** and baked into the Docker image at build time. At startup the server parses them into in-memory indices; every tool is then a local query. The result has no API key, no rate limit, and no upstream dependency to inherit an outage from.

How the working model fits together:

- **Code resolution across five identifier spaces.** Airports carry IATA, ICAO, GPS, local, and the OurAirports `ident`. A single `code` parameter resolves against a unified index (priority: ident → ICAO → IATA → GPS → local), and the response echoes the full code set so an ambiguous national code is self-correcting. A missing code (no IATA for a small field) is reported as `null`, never a 404.
- **Nearest-neighbour by great-circle distance.** Coordinate lookups run a haversine scan over a flat `Float64Array` of every airport (or navaid) position and return the nearest results ranked by distance, each with its bearing — sub-millisecond at this scale, no spatial index needed.
- **Honest sparsity.** Absent upstream fields (no elevation, null runway dimensions) surface as unknown. Capped result lists disclose truncation.

OurAirports is community-edited. The data is surfaced as-is and is **not authoritative for real flight operations** — treat it the way you would any crowd-sourced reference.

## Tools

Six read-only tools, all local queries against the bundled index — code resolution and detail, airport and runway search, coordinate grounding, navaids, and the country/region lookup table:

| Tool | Description |
|:---|:---|
| `ourairports_search_airports` | Full-text and faceted search over the airport corpus by name, municipality, country, region, or type. Ranked summaries, closed airports excluded by default. |
| `ourairports_search_runways` | Search runways across all airports by surface, length, width, and lighting, joined back to their airports and filtered by country, region, or airport type. One flat `{ airport, runway }` row per matching runway. |
| `ourairports_get_airport` | Full record for one airport resolved by any code (IATA/ICAO/GPS/local/ident), with its runways and radio frequencies inline. |
| `ourairports_find_airports` | Airports within a radius of a coordinate, ranked nearest-first by great-circle distance, with distance and bearing. |
| `ourairports_find_navaids` | Navigation aids (VOR, VOR-DME, DME, NDB, NDB-DME, TACAN, VORTAC) near a coordinate or serving a specific airport. |
| `ourairports_list_countries` | Countries present in the dataset with ISO codes and airport counts; optional continent filter and nested regions. The lookup table for valid `country`/`region` filter values. |

### `ourairports_search_airports`

The common entry point — search by free text, facets, or both.

- Free-text search over name, municipality, and keywords; tokens are AND-matched (word order and partial words handled)
- Faceted filters: `country` (ISO 3166-1 alpha-2), `region` (ISO 3166-2), and `type` — `country`/`region` are exact match, case-insensitive, with surrounding whitespace ignored
- Closed airports excluded by default; opt in with `include_closed`
- Results ranked operational/larger-airports-first, each with its full code set and coordinates for chaining into `ourairports_get_airport`
- Truncation disclosure — total matched count, applied cap, and guidance to broaden or narrow

---

### `ourairports_search_runways`

Cross-airport runway search — the counterpart to `ourairports_get_airport`, which lists runways for one already-known airport.

- Airport facets (`country`, `region`, `type`) narrow the airports first; runway facets (`surface`, `min_length_ft`, `min_width_ft`, `lighted`) then filter their runways
- `surface` is a case-insensitive substring match against the raw upstream surface string (no controlled vocabulary — a shorter fragment like `asp` matches ASP, ASPH, and Asphalt), not an exact code
- Returns one flat `{ airport, runway }` row per matching runway — an airport with three matching runways contributes three rows
- A runway whose length or width is unknown is excluded when the matching `min_*_ft` filter is set — never assumed to meet a threshold the data can't confirm
- Closed airports and closed runways are both excluded unless `include_closed_airports` / `include_closed_runways` is set
- Truncation disclosure — total matched count, applied cap, and guidance to broaden or narrow

---

### `ourairports_get_airport`

The detail tool — one call returns everything the common case needs.

- Resolves a single `code` case-insensitively across all five identifier spaces (priority: ident → ICAO → IATA → GPS → local); surrounding whitespace is ignored
- Runways and radio frequencies inline; `include` trims the response to a subset, and the output's `included` field distinguishes a relation omitted by `include` from one that genuinely has no records
- Echoes the airport's complete code set plus a `resolvedVia` / `resolutionNote`, with an ambiguity warning for shared national codes so a wrong resolution is self-correcting
- Absent codes reported as `null`; closed airports always resolve
- `unknown_code` error with a recovery hint when no identifier space matches

---

### `ourairports_find_airports`

The grounding tool — turn a latitude/longitude into the nearest airport(s).

- Great-circle (haversine) ranking, nearest-first, each result with `distanceKm` and `bearingDeg` (degrees true) from the query point
- `radius_km` (1–500, default 100), optional `type` filter, `include_closed` opt-in
- Coordinate in, ranked airports out — no geocoding; resolve place names to lat/lon upstream first
- Empty-radius guidance suggesting a wider `radius_km`

---

### `ourairports_find_navaids`

Navigation aids two ways — spatially or by airport.

- **Coordinate mode:** `latitude` + `longitude` (+ optional `radius_km`) ranks navaids nearest-first with distance and bearing
- **Airport mode:** `airport_code` returns the navaids serving that airport
- Exactly one mode required — supplying both or neither is a validation error
- Frequencies surfaced in both kHz (the stored value — a VOR on 114.5 MHz reads `frequencyKhz` 114500) and MHz
- Airport mode distinguishes "airport not found" (`unknown_code` error) from "airport found but has no associated navaids" (empty list with a note)

---

## Resource and prompt

| Type | Name | Description |
|:---|:---|:---|
| Resource | `airport://{code}` | Single airport record by any code (IATA/ICAO/GPS/local/ident), with runways and frequencies inline. |

The `airport://{code}` resource is a stable-URI twin of `ourairports_get_airport` for clients that inject resource context. All data is reachable from the tools alone — tool-only clients lose nothing. The corpus is not exposed as a resource list (enumerating 85k airports is a dump, not a discovery aid); discovery is `ourairports_search_airports`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- Runs locally (stdio/HTTP) or on Cloudflare Workers from the same codebase

OurAirports-specific:

- Bundled, public-domain dataset baked into the package and Docker image — zero runtime API, no key, no rate limit, no upstream outage
- In-memory indices built once at startup: id maps, a priority-ordered unified code index, airport-ref joins for runways and frequencies, an ident-keyed navaid join, a flat `Float64Array` of coordinates, country/region maps, and a tokenized text-search index
- Brute-force haversine nearest-neighbour over the coordinate array — sub-millisecond across 85k airports, no spatial-index dependency
- CSVs parsed by header name, not column position, so an upstream column reorder can't silently misalign fields

Agent-friendly output:

- Honest sparsity — absent upstream fields (no IATA, no elevation, null runway dimensions) surface as `null`, never fabricated
- Self-correcting resolution — every airport record echoes its full code set and a `resolvedVia` / `resolutionNote`, with an ambiguity warning for shared national codes
- Truncation and empty-result disclosure — total counts, applied caps, and recovery guidance so callers can broaden, narrow, or re-query without parsing prose

## Getting started

### Public Hosted Instance

A public instance is available at `https://ourairports.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP, with this client config:

```json
{
  "mcpServers": {
    "ourairports-mcp-server": {
      "type": "streamable-http",
      "url": "https://ourairports.caseyjhand.com/mcp"
    }
  }
}
```

### Local / self-hosted

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "ourairports-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/ourairports-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "ourairports-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/ourairports-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "ourairports-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/ourairports-mcp-server:latest"
      ]
    }
  }
}
```

No API key is required — the dataset ships with the package and the image.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key, account, or external service — all data is bundled.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/ourairports-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd ourairports-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Fetch and bundle the dataset** (writes the six CSVs into `data/`):

```sh
bun run build:data
```

### Refreshing the data

The bundled snapshot is as fresh as the last `build:data` run (or, for the Docker image, the last build). To pull the latest daily drop from the OurAirports mirror, re-run `bun run build:data` and rebuild. To point at an existing local data drop without rebuilding, set `OURAIRPORTS_DATA_DIR`.

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `OURAIRPORTS_DATA_DIR` | Directory holding the six OurAirports CSV files. Overridable to point at a fresher local data drop. | Bundled `data/` |
| `OURAIRPORTS_DEFAULT_SEARCH_LIMIT` | Default result cap for the search/find tools when the caller omits `limit` (1–100). | `20` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the server is mounted. | `/mcp` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend (unused on the data path — the index is in-memory). | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time data fetch + build
  bun run build:data
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t ourairports-mcp-server .
docker run --rm -e MCP_TRANSPORT_TYPE=stdio ourairports-mcp-server
```

The build stage runs `bun run build:data` so the dataset is fetched and baked into the image — the resulting container is fully self-contained and makes no network calls at runtime. The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/ourairports-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and loads the bundled index at `setup()`. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Six read-only airport/runway/navaid tools. |
| `src/mcp-server/resources` | Resource definitions. The `airport://{code}` record. |
| `src/services/airport-data` | The bundled-data service — CSV parsing, in-memory indices, code resolution, search, and the haversine geo scan. |
| `scripts/build-data.ts` | Build-time fetcher that bundles the six OurAirports CSVs into `data/`. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Surface upstream data as-is: report absent fields as `null`, never fabricate missing values

## Attribution

Airport, runway, navaid, and frequency data from [OurAirports](https://ourairports.com/), dedicated to the public domain. Attribution is a courtesy, not a requirement. Source CSVs are published daily at [davidmegginson.github.io/ourairports-data](https://davidmegginson.github.io/ourairports-data/).

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
