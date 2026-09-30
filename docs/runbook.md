# Operations and verification

Read SPEC before operating. All paths are supplied explicitly through an absolute config path; cwd does not establish Wiki identity. Never run against production from a development agent. The coordinator alone authorizes and performs production writes.

## Synthetic development

Use Node 25.8.0, `npm ci --ignore-scripts`, then `npm test`. Use an isolated temporary Wiki and local data directory. Generate synthetic input, never copy private chats to fixtures. `node src/cli.ts --help` lists commands. See `test/fixtures/basic.ts` for a synthetic configuration with explicit journal timeline and bounded defaults.

## Current daily flow

1. `node src/cli.ts collect --lane live --config /absolute/config.json` freezes cutoff and persists bounded source batches. Capture status is taken from coverage, independently of successful command execution.
2. `node src/cli.ts prepare --kind daily --lane live --cutoff <collect-returned-UTC> --output /absolute/review-dir --config /absolute/config.json` writes bounded bundle JSON files and a manifest. Use the exact UTC cutoff returned by step 1 so collection and review share one frozen window; otherwise each CLI invocation chooses a new current time. A reviewer writes a versioned ReviewResult using local candidate IDs, explicit chunk progress and zero-fact completion; this CLI never calls an LLM.
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

## Integration verification (synthetic only)

`npm run check` performs strict TypeScript checking with pinned TypeScript 5.9.3 / @types/node 25.8.0, then recursively discovers only `.test.ts` tests. Fixtures are not counted as test cases. `tests/integration/end-to-end.test.ts` uses actual adapters, SQLite Store, Reviewer, Publisher and CLI orchestration against isolated synthetic roots; only clock/stdout/stderr are injected.

Its seven scenarios cover native mirror versus true repeated text, stable recapture/replay, source disappearance and consistent backup/new-directory restore, bounded 2GB sparse tail plus malformed peer source with partial coverage, partial semantic progress and crash before FileIntent, Wiki lock/conflict with independent ready facts, old-month monthly page outside daily retention, and actual compact bundle bytes/0700 directory/0600 files. Initially failing relocated fragment/monthly retention counterexamples were fixed by A/C and rerun successfully.

Capture exceptions persist unavailable/partial coverage and collection_retry work. Material/backup/state paths cannot overlap Wiki, raw source roots or iCloud, including canonical existing ancestors. prepare writes compact immutable bundles and an atomic manifest; final file bytes cannot exceed configured bundle_bytes. Explicit finite review and collection budgets can exceed defaults.

Daily capture/review/export/publication and source-independent facts/status/backup/restore are integrated. Monthly/archive/index and manifest import/migration now invoke concrete services. Typed weekly/monthly semantic acceptance, all three consumers, Analytics review and changed/all health validation now call the delivered implementations. Synthetic integration evidence is separate from production and scheduled-run acceptance.

## M2 service composition

`consume --target monthly|index` and `archive --month YYYY-MM --report|--apply` now call the actual consumer/archive factories in `docs/archive-monthly-index-interface.md`. Index commands are configured in `index_commands:{schema_version:1,lint,build_index,qmd}`, each command `{schema_version:1,executable,args,timeout_ms?}`. Defaults use the current pinned Node for `scripts/lint.mjs` and `scripts/build_index.mjs`, then `qmd update`; no shell and no pull. Explicit executable paths are supported. An index stage failure retains durable work and reports pending/partial independently of facts.

`prepare --pages /absolute/page-targets.json` accepts `{schema_version:1,paths:["wiki/projects/项目_example.md","log.md"]}`. These are explicit Wiki targets, not implicit cwd ownership. Raw, traversal, symlink and outside paths are rejected; bounded/excerpt baselines are owned by Reviewer. Every accepted page patch still goes through the common Publisher/SafeWikiWriter lock, backups and recovery.

Analytics, migration and health validation invoke concrete factories. SPEC7 exact pair folds, catalogue promotion, as-of contract expiry, bounded goal material and four-week pilot now have actual SQLite/CLI synthetic acceptance. Real production and scheduled-run acceptance remain separate.

## Migration and monthly recovery

`import` and `migrate` load the actual Store AnalyticsHistory port. Raw legacy records remain sealed history/work; only explicit professional projection plus actual immutable target/weekly hashes can activate a current-revision confirmation. Missing or stale mappings remain needs_review. `migration_limits` can raise default budgets within documented hard maxima; a large state object is retained whole.

Legacy archive assertions are existing monthly base context. They are not replayed as newly added supplement prose. Effective replace/retract refreshes derived supplements, and a withdrawn summary reference produces a visible invalidation notice and durable recomputation work. Successful typed monthly publication completes only the explicit reviewed preparation IDs; unread, omitted and later work remains pending. New monthly pages use journal/private/stable/pinned metadata.

Group history first enumerates exact core windows, then independently bounded participation context windows. Dense surrounding context cannot poison core paging. Remaining context/irreducible second windows stay explicit partial/import debt. Pinned chats apply independently of discovery; ignored/service chats remain excluded. Display aliases require explicit verified configuration and never override native IDs.

Frozen weekly/monthly fact pages: first `prepare` returns typed `facts_page` with `snapshot_id`, original `cutoff`, and `next_offset`. Continue with `prepare --kind monthly --lane history --period YYYY-MM --fact-snapshot SNAPSHOT --fact-offset NEXT --cutoff ORIGINAL_UTC --output NEW_DIR`. Keep the snapshot and cutoff unchanged; a new first page creates a new ref snapshot. Facts pages do not certify complete coverage or clear unread task IDs.

New-page review contract: when a requested baseline has digest `absent`, `ReviewResult.pages[].new_text` supplies the complete current Wiki template, including all required frontmatter, H1, date and journal class. Publisher writes that accepted content; it does not manufacture a page template. Existing pages receive only reviewed local append or exact replacement. An existing-day acceptance does not cover first-page creation.

## Exact Analytics review and bounded original material

`analytics-review --input FILE` accepts a versioned `kind:review` payload with append-only events. Generic observation `confirm` confirms that observation only. `selected_pairs:[{schema_version:1,observation_ref,capability_ref}]` selects exact revisions; `correct` confirms those selected pairs and marks remaining pairs contested. A `retract` supplies `retracts_review_id` for the exact previous effect; retracting that retraction restores the prior fold. Unknown or stale refs remain local pending/stale. `kind:capability_candidate` registers a candidate definition; explicit user confirmation of that exact definition revision promotes it. Confirmation and correction/dispute effects bind the exact revisions present when reviewed; future observation or capability revisions inherit neither. Explicit current-week action closure also takes precedence over an older active action.

`consume --target analytics` returns `analytics_pilot` with four completed Amsterdam Mon–Sun periods, exact professional review/action/notice counters, current as-of active states and an explicit unknown review duration. Goal and decision expiry refresh current cockpit even without a new fact batch; generated notice history remains intact. The production CLI uses the real clock; tests inject only its existing clock/output dependencies.

Monthly original material: `prepare --kind monthly --lane history --period YYYY-MM --cutoff ORIGINAL_UTC --pages EXPLICIT_TARGETS --output DIR` reads only explicitly named old daily/project pages. Accepted zero-fact original pages accumulate distinct summaries without new fact allocation. For queued immutable v2 archives, use `--archive-context-offset NEXT` and the returned `--fact-snapshot SNAPSHOT` with that original cutoff. `archive_context_page` exposes continuation; a large original gives its required larger bundle budget so re-reading the same offset reaches the tail. Only fully included original IDs may enter `monthly_review.completed_archive_context_ids`; excerpt, unread and later work remains pending.

Configured `goal_whitelist` page paths supply bounded `goal_page_baselines` for weekly review. Full digests survive excerpts; absent, unsafe or oversized targets are local gaps. Page contents do not create confirmed goal contracts or expand professional permissions.
