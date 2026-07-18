# Developer Protocol

**Server:** ourairports-mcp-server
**Version:** 0.2.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.14`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What This Server Does

Static, offline aviation reference data from the public-domain [OurAirports](https://ourairports.com/) dataset — airports, runways, navaids, radio frequencies. The six source CSVs are bundled into the package (and baked into the Docker image at build time via `scripts/build-data.ts`); the `airport-data` service parses them into in-memory indices once at `setup()`, and every tool is a local query. Zero runtime API: no key, no rate limit, no upstream to retry. The surface is six read-only tools plus the `airport://{code}` resource; no prompts. The architecture rationale (why in-memory indices over MirrorService/DataCanvas, the five-space code resolution, the haversine geo scan) lives in `docs/design.md` — read it before changing the service or adding a tool.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

Real example — `ourairports_get_airport`. Handlers are synchronous here (every query hits the in-memory index, no `await`), pull the service via its accessor, throw a typed contract error on no match, and `format()` renders every output field for content/structuredContent parity.

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';

export const getAirportTool = tool('ourairports_get_airport', {
  title: 'ourairports-mcp-server',
  description: 'Fetch the full record for one airport resolved by ANY code …',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  errors: [
    {
      reason: 'unknown_code',
      code: JsonRpcErrorCode.NotFound,
      when: 'No airport matched the supplied code in any identifier space.',
      recovery: 'Try ourairports_search_airports with a partial name or municipality.',
    },
  ],
  input: z.object({
    code: z.string().min(1).describe('Any airport code: IATA/ICAO/GPS/local/ident. Case-insensitive.'),
  }),
  output: z.object({ /* AirportSummarySchema + resolvedVia + runways + frequencies */ }),

  handler(input, ctx) {
    const svc = getAirportDataService();
    const resolution = svc.resolveByCode(input.code);
    if (!resolution) {
      throw ctx.fail('unknown_code', `No airport found for code "${input.code}".`, {
        code: input.code,
        ...ctx.recoveryFor('unknown_code'),
      });
    }
    // … hydrate runways/frequencies, enrich country/region names …
  },

  format: (result) => [{ type: 'text', text: /* every output field rendered */ '' }],
});
```

Shared output schemas and domain→output mappers live in `src/mcp-server/tools/definitions/_schemas.ts` so `get_airport`, the `airport://` resource, and the search/find tools render the same fields the same way. `format()` parity is lint-enforced — every field in `output` must appear in the rendered text.

### Resource

The `airport://{code}` resource is a stable-URI twin of `ourairports_get_airport`, delegating to the same service accessor. No `list()` — discovery is `ourairports_search_airports`.

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';

export const airportResource = resource('airport://{code}', {
  name: 'airport-record',
  title: 'ourairports-mcp-server',
  description: 'A single airport record by any code (IATA/ICAO/GPS/local/ident) …',
  mimeType: 'application/json',
  params: z.object({ code: z.string().min(1).describe('Any airport code. Case-insensitive.') }),
  output: z.object({ /* same shape as ourairports_get_airport */ }),
  handler(params, ctx) {
    const resolution = getAirportDataService().resolveByCode(params.code);
    if (!resolution) throw ctx.fail('unknown_code', `No airport found for code "${params.code}".`);
    // … same hydration as the tool …
  },
});
```

### Prompts

None. This is a data/lookup server with no recurring multi-step interaction pattern worth templating. `createApp()` is called with `prompts: []`.

### Server config

The real schema — two optional knobs, no API key. `OURAIRPORTS_DATA_DIR` defaults to the bundled `data/` (resolved by `resolveBundledDataDir()` when unset); a `preprocess` treats unset, empty, and unsubstituted MCPB placeholders identically as "not set" so an optional override left blank in a host UI falls back to the default.

```ts
// src/config/server-config.ts — lazy-parsed, separate from framework config
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const PLACEHOLDER_PATTERN = /^\$\{[^}]+\}$/;
const emptyAsUndefined = (v: unknown) => {
  if (v === '') return;
  if (typeof v === 'string' && PLACEHOLDER_PATTERN.test(v)) return;
  return v;
};

const ServerConfigSchema = z.object({
  dataDir: z
    .preprocess(emptyAsUndefined, z.string().optional())
    .describe('Directory holding the six OurAirports CSV files. Defaults to the bundled `data/`.'),
  defaultSearchLimit: z.coerce
    .number().int().min(1).max(100).default(20)
    .describe('Default result cap for search/find tools when the caller omits `limit`.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    dataDir: 'OURAIRPORTS_DATA_DIR',
    defaultSearchLimit: 'OURAIRPORTS_DEFAULT_SEARCH_LIMIT',
  });
  return _config;
}
```

`parseEnvConfig` maps Zod schema paths → env var names so errors name the variable (`OURAIRPORTS_DATA_DIR`) not the path (`dataDir`). Throws `ConfigurationError`, which the framework prints as a clean startup banner. For env booleans use `z.stringbool()`, never `z.coerce.boolean()` — `Boolean("false")` is `true`, so a coerced flag can't be disabled through the environment.

### Server identity and instructions

`createApp()` accepts optional identity fields forwarded to the SDK's `initialize` response and the server manifest (`/.well-known/mcp.json`):

```ts
await createApp({
  name: 'my-mcp-server',
  title: 'My Server',                         // human-readable display name
  websiteUrl: 'https://github.com/owner/repo', // canonical homepage URL
  description: 'One-line description.',        // wins over MCP_SERVER_DESCRIPTION
  icons: [{ src: 'https://example.com/icon.png', sizes: ['48x48'], mimeType: 'image/png' }],
  instructions: 'Use shortcut alpha for the most common case.', // session-level context
});
```

`instructions` is optional server-level orientation, sent on every `initialize` as session-level context. Use it for deployment guidance (connection aliases, regional notes, scope hints) instead of repeating the same context across tool descriptions. Client adoption is uneven, but there's no downside when set.

---

## Context

Handlers receive a unified `ctx` object. This server is read-only over an in-memory index — it uses the logging, enrichment, and error sub-APIs and nothing stateful. The properties actually used here:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.enrich` | Out-of-band result metadata declared via the tool's `enrichment` schema — `.total(n)`, `.truncated({ shown, cap, guidance })`, `.notice(text)`. Used by the search/find/list tools to disclose match counts, truncation, and empty-result guidance. |
| `ctx.fail` | Throw a typed contract error — `ctx.fail(reason, message?, data?)`, typed against the tool's `errors[]` reason union. |
| `ctx.recoveryFor` | Pull the declared `recovery` hint for a contract reason to attach to the thrown error's `data`. |

The framework also exposes `ctx.state` (tenant KV), `ctx.elicit`, `ctx.progress`, and `ctx.signal` — unused here (no persistence, no user prompts, no long-running tasks, no upstream I/O to cancel). See the framework CLAUDE.md / `api-context` skill for the full interface.

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. Spread `ctx.recoveryFor('reason')` into the throw's data to put it on the wire (`data.recovery.hint`, mirrored into `content[]` text); override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.DatabaseError, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() — registers tools/resources, loads index at setup()
  config/
    server-config.ts                    # OURAIRPORTS_DATA_DIR + OURAIRPORTS_DEFAULT_SEARCH_LIMIT (Zod)
  services/
    airport-data/
      airport-data-service.ts           # Load-on-setup() index, code resolution, search, geo accessors
      csv.ts                            # Header-keyed CSV parser
      data-dir.ts                       # Resolves the bundled data/ directory (override-aware)
      geo.ts                            # Haversine distance + bearing
      types.ts                          # Airport/Runway/Navaid/Frequency domain types + enums
  mcp-server/
    tools/definitions/
      _schemas.ts                       # Shared output schemas + domain→output mappers + renderers
      search-airports.tool.ts           # ourairports_search_airports
      search-runways.tool.ts            # ourairports_search_runways
      get-airport.tool.ts               # ourairports_get_airport
      find-airports.tool.ts             # ourairports_find_airports
      find-navaids.tool.ts              # ourairports_find_navaids
      list-countries.tool.ts            # ourairports_list_countries
      index.ts                          # allToolDefinitions barrel
    resources/definitions/
      airport.resource.ts               # airport://{code}
      index.ts                          # allResourceDefinitions barrel

scripts/
  build-data.ts                         # Build-time fetch + bundle of the six OurAirports CSVs into data/
data/                                   # Bundled CSVs (gitignored locally; baked into the package + image)
docs/design.md                          # Architecture rationale — read before changing the service
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `get-airport.tool.ts` |
| Tool names | snake_case, `ourairports_` prefix (matches the repo/display name) | `ourairports_get_airport` |
| Directories | kebab-case | `src/services/airport-data/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Fetch the full record for one airport resolved by ANY code …'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run build:data` | Fetch the six OurAirports CSVs from the daily GitHub mirror and bundle them into `data/`. Run before `build` and in the Docker build stage; `--check` verifies already-bundled files without downloading. |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory — Bun's `update` is sticky on transitive resolutions, so the advisory may be a stale-lockfile false positive. If it survives the refresh, it's real. |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips dependency-shipped agent docs (`node_modules/**` `skills/`, `.claude/`, `.agents/`, `SKILL.md`) that root-anchored `.mcpbignore` patterns cannot reach. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order** (Keep a Changelog): Added, Changed, Deprecated, Removed, Fixed, Security. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getAirportDataService } from '@/services/airport-data/airport-data-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = package name; `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key matches `package.json` name; env vars added for any required API keys
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; inline `mcpServers` entry with server name key, env vars for any required API keys
- [ ] `npm run devcheck` passes
