# Contributing

Thanks for using `@cyanheads/ourairports-mcp-server`. Bugs, feature requests, and documentation gaps all belong in an issue — that's where they get read and picked up.

Open one from the **Issues** tab and pick the **Bug Report** or **Feature Request** form. Both are structured, and filling in the fields is what makes an issue actionable.

Pull requests are welcome. Open an issue first for anything larger than a typo so the intended scope is clear before implementation.

## Server bug or framework bug?

`@cyanheads/ourairports-mcp-server` is built on [@cyanheads/mcp-ts-core](https://github.com/cyanheads/mcp-ts-core), which handles transports, auth, config, logging, and telemetry. Sorting out which layer broke saves everyone a round-trip:

- **This repo** — a tool returns wrong data, a schema does not match the bundled OurAirports data, or a description misleads the model.
- **[mcp-ts-core](https://github.com/cyanheads/mcp-ts-core/issues)** — a builder rejects valid input, `createApp()` fails on a valid config, a `Context` method behaves contrary to its docs, or transport/auth fails regardless of which tool is called.

If you are not sure, file here and it will get routed.

## Before filing

1. **Check you are on the latest release.** Fixes land on the current version.
2. **Search existing issues** before opening a new one. Add to the matching thread instead of filing a duplicate.
3. **Redact anything sensitive.** Issues are public and permanent — no API keys, tokens, auth headers, internal URLs, or PII in code, logs, or stack traces.

## What makes an issue actionable

- Server version, `mcp-ts-core` version, runtime (Bun / Node), and transport (stdio / HTTP).
- The tool or resource involved, and the arguments used.
- Actual versus expected behavior, verbatim: error messages and stack traces as they appeared.
- For features: the use case first, then the API as you would want to call it.

## For agents

Do the triage first — an unverified report costs more to read than it saves to file.

Two workflows ship with this project:

- [`skills/report-issue-local/SKILL.md`](../skills/report-issue-local/SKILL.md) — filing against this repo.
- [`skills/report-issue-framework/SKILL.md`](../skills/report-issue-framework/SKILL.md) — filing against `mcp-ts-core` after isolating a framework bug.

Read the relevant one before filing on a user's behalf.

## Security

Do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting or email **security@caseyjhand.com**.
