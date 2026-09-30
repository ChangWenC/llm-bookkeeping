# Operations and verification

Read SPEC before operating. All paths are supplied explicitly through an absolute config path; cwd does not establish Wiki identity. Never run against production from a development agent. The coordinator alone authorizes and performs production writes.

## Synthetic development

Use Node 25.8.0, `npm ci --ignore-scripts`, then `npm test`. Use an isolated temporary Wiki and local data directory. Generate synthetic input, never copy private chats to fixtures. `node src/cli.ts --help` lists commands. See `test/fixtures/basic.ts` for a synthetic configuration with explicit journal timeline and bounded defaults.

## Current daily flow

1. `node src/cli.ts collect --lane live --config /absolute/config.json` freezes cutoff and persists bounded source batches. Capture status is taken from coverage, independently of successful command execution.
2. `node src/cli.ts prepare --kind daily --lane live --output /absolute/review-dir --config /absolute/config.json` writes bounded bundle JSON files and a manifest. A reviewer writes a versioned ReviewResult using local candidate IDs, explicit chunk progress and zero-fact completion; this CLI never calls an LLM.
3. `node src/cli.ts publish --input /absolute/ReviewResult.json --config /absolute/config.json` persists the semantic transaction once and independently exports/applies/queues. If interrupted, use `publish --resume`. File conflicts remain drafts and do not revoke committed facts.
4. `node src/cli.ts consume --target all --config /absolute/config.json` delivers ready exported batches. Monthly queues preparation work. `status` reports durable remaining work. Partial history does not block live.

## Other commands

All commands accept `--config /absolute/config.json`.

- `collect --lane history`
- `prepare --kind weekly|monthly --lane live|history [--period YYYY-MM-DD|YYYY-MM] --output DIR`
- `consume --target analytics|monthly|index|all`
- `archive --month YYYY-MM --report|--apply`
- `import --manifest FILE` / `migrate --manifest FILE`
- `replay --source PROVIDER --from UTC --to UTC`
- `facts --from UTC --to UTC`
- `analytics-review --input FILE`
- `backup --output DIR`
- `restore --input BACKUP --data-dir NEW_ABSOLUTE_DIR`
- `validate --scope changed|all`

Backup must use SQLite consistency API/VACUUM INTO, not copy a live DB. Restore always targets a new directory and must not overwrite production. Archive starts with one-month report and applies only after complete preserved originals, usable review, exact backlink transition and lock-held digest checks. Recovery compares complete desired/old bytes; it never resets the whole Wiki or database over later manual edits.

## Acceptance and cutover

Report code, synthetic and real acceptance independently. Use SPEC's complete matrix, including bounded 2GB tails, source identity variants, timezone/DST, zero facts/partial review, transaction/export/file interruption, writer conflicts, old archive effective folding, Analytics revision privacy, migration, real WeChat and consistent backup.

Production cutover belongs to the coordinator: isolated Wiki acceptance; pause monthly; await old writer exit; consistent snapshot + restore sample; minimal explicit config/T0/S; real manual daily; update existing daily automation preserving schedule/model/effort; update prompts/schema/memory; safe monthly resume; observe two real scheduled runs; retire old dedicated entry points while preserving recoverable snapshots. Do not declare full completion after only M1.
