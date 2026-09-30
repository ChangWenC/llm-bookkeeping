# Archive, monthly and index consumers

All factories accept the same Store port and explicit BookkeepingConfig. They never read old implementation, issue SQL, invoke an LLM, or infer Wiki root from cwd. Default monthly/archive options are sufficient; production roots are operated only by coordinator.

## Runtime wiring

```ts
import { createMonthlyConsumer } from '../consumers/monthly/index.ts';
import { createArchiveService } from '../consumers/archive/index.ts';
import { createIndexConsumer } from '../consumers/index/index.ts';

const monthly = createMonthlyConsumer(store, config);
const indexing = createIndexConsumer(store, config, indexOptions);
const archive = createArchiveService(store, config);
services.consumers = [analytics, monthly, indexing];
services.archive = request => archive.run(request);
```

Integration owns the aggregate `src/consumers/index.ts`, Runtime, CLI and configurable command transport. No aggregate is written by this owner.

## Monthly APIs and actual automatic refresh

`createMonthlyConsumer(store, config, options?: WriterOptions): MonthlyConsumer` exports:

- `consume(): Promise<ConsumerOutcome>`: ready monthly batches queue stable `prepare_monthly` work (month, batch identity). Monthly/supplement input work queues bounded preparation, then the original batch's monthly acknowledgement records successful durable queue output. This does not create Markdown or invoke a model. Accepted monthly output does not requeue itself as fresh semantic work.
- `prepareMonthlyContext(month): Promise<MonthlyReviewInput>`: Europe/Amsterdam calendar range, effective facts with original journal dates, independently classified coverage and exact existing monthly page baseline. Reviewer must enforce final bundle byte bounds and mark any omitted context explicitly.
- `publishMonthlyReview(batch: FactArtifact): Promise<ConsumerOutcome>`: consumes a persisted `batch.monthly_review` typed result, writes a protected derived monthly summary, saves immutable `monthly_review_record` history, refreshes the current effective supplement, and only then acknowledges `monthly-publish`. A newer published monthly result prevents an older accepted result from overwriting it.
- `refreshMonthlySupplements(month): Promise<ConsumerOutcome>`: deterministically rebuilds the supplement from Store.readEffectiveFacts. It has no semantic/model work.

These helpers are wired to real publication: after independent fact export and journal recovery, **Publisher.publish/resume** discovers `listReadyBatches('monthly-publish')` for typed accepted monthly results, and `listReadyBatches('monthly-display')` for every batch's affected dates/weeks/explicit affected_months. It calls those APIs directly. `monthly_display:<batch>:<month>` stays pending until the display succeeds; only all successful affected displays acknowledge that batch's independent `monthly-display` consumer. A missing review queues preparation and remains pending. A conflict/lock/display failure appears separately in PublishResult consumers/pending; committed facts remain ready. Revisions/retractions therefore update an existing historical monthly page without another whole-month LLM run. `consume monthly` remains only preparation queueing.

Managed monthly sections use start/end comments carrying a digest of their prior generated body. Refresh replaces only one matching, unedited section; everything outside it is preserved. Missing/duplicated/malformed markers or manual changes inside the section defer regeneration. Non-lossless UTF-8 manual pages are preserved and deferred. Labels distinguish facts, inference, recommendation and unverified legacy narrative. Effective replace/retract removes inactive revisions rather than appending contradictions. Facts already mapped to a successful non-supplement monthly FileIntent are excluded from the supplement; new revisions are distinct refs and can appear. Original archived Markdown is never copied into fact totals. Unstructured originals remain extraction context.

Canonical monthly page: `wiki/personal/journals/reviews/回顾_YYYY_MM.md`. New typed summaries can create this page; standalone supplement refresh requires an existing review and cannot manufacture its semantic body.

## One-month archive

`createArchiveService(store, config, options?: ArchiveOptions)` returns `{run(request): Promise<ArchiveResult>, report(month)}`. Runtime passes `archive --month YYYY-MM --report|--apply` to `.run`.

Report is read-only and reports each canonical daily as eligible/retained/pending. Apply accepts one month only, older than the current local month and preceding full month. Canonical daily recognition is shared with publisher: an exact daily filename under journals, or an explicitly typed dated daily; review/month/year/topic pages are not inferred from a date. Canonical `journal_class:pinned-daily|intentional-journal`, boolean pinned/intentional frontmatter and tags `pinned-daily`/`intentional-journal` retain daily originals.

Each eligible page gets a durable `archive_plan` containing full original bytes/digest, desired version archive bytes, fact refs and exact backlink operations before file mutation. A new immutable file is written via SafeWikiWriter at `_evidence/daily_journals/v2/<month>/<sha256(source path + original digest)>.json`. Its format is `daily-journal-archive-v2`, with schema_version 1, archive_id, calendar date, original stem/source path, original digest, **complete original_bytes_base64**, readable original_markdown, stable locator, fact refs and creation time. Base64 is the lossless authority; the readable copy is context. Existing annual JSONL and saved archive originals are never rewritten.

After actual archive output succeeds, completed `kind:archive` Store work is the canonical/date index (date/archived_dates, archive_path, source_path/digest, fact_refs). It is reconstructible together with immutable archive files; retention/state.json is an optional projection, not a sole authority. An `archive_context` work item preserves the raw original as pending bounded extraction context without creating duplicate assertions for its fact refs.

Before deleting daily source, all of these must succeed in the same shared Wiki lock interval: complete preserved version output; usable substantive monthly review; each exact backlink migration; no remaining daily links; final source digest/retention check; unchanged current-attempt monthly-review digest (or this plan’s authorized backlink desired digest); final archive digest; final migrated backlink page digests and re-enumeration. Bare headings, missing/draft review, changed source/body/links or changed preserved archive defer the affected page. Other eligible pages continue. Daily links become `[[回顾_YYYY_MM|YYYY-MM-DD 日记]]`; existing descriptions are kept exactly, and similar stems are left untouched.

Restart resumes saved plan/intents, including a crash before archive FileIntent or after daily deletion but before plan completion. Source absence only completes through the original deletion intent/new-state comparison, not a new guessed intent. Full bytes remain preserved before any deletion. Report/apply do not depend on old marker/receipt/controller state. General lint/index/qmd are separate pending work and cannot retroactively revoke saved facts or delete preconditions.

`readArchiveRecords(config): Promise<ArchiveRecords>` is a **data-only reader**, returning known v1/v2 records plus `.issues` for individual malformed data. Schema files and unknown JSON families are excluded; a bad line does not stop other records. Known-date issues delay only that date and queue `archive_record` work on apply/publication. Unknown-date issues remain visible as their own pending records. This owner does not allocate/import old legacy fact IDs: the migration owner is the single old-v1 conversion authority and uses Store.importLegacy. Monthly effective view reads that imported history through Store only.

## Public index black boxes

`createIndexConsumer(store, config, options?: IndexOptions): Consumer` coalesces pending successful-file index work by current path, validates those paths, runs lint/build_index/qmd once per captured job, and completes only captured work after every output succeeds. New work arriving during qmd remains pending. Stage completion and diagnostics are durable `index_stage`/`index_failure` work; retry can skip successful lint/build and retry qmd alone. Successful newer combined work can satisfy older failed jobs whose captured IDs it covers.

`IndexOptions.commands` supplies explicit `{executable,args,timeout_ms?}` for each public stage. No shell or source-text commands are used. Defaults are Node `scripts/lint.mjs`, `node scripts/build_index.mjs`, `qmd update`, all cwd=wiki_root. Coordinator must configure actual public CLI arguments when its environment differs; missing executables/failure are visible pending. The runner receives BOOKKEEPING_WIKI_ROOT and BOOKKEEPING_CHANGED_PATHS_JSON; custom synthetic runner injection is supported.

Only build_index holds the Wiki writer lock; lint is read-only and qmd refresh does not hold it. The native runner starts a small new Node lock-command, acquires the canonical lock, then **execve** replaces itself with the public build command, preserving the lock-owning PID. Thus a dying coordinator cannot make a still-active index process look like a dead lock. After the command exits, dead-owner recovery permits the next writer. Node 25.8.0 and synchronous public CLI completion are required; a caller must not configure a daemonizing writer. Output is bounded to 64KiB per stream, timeout sends TERM then KILL, and stage completion waits for exit. Injected synthetic runners run within the caller's lock and must await their own writes.

## Verification

`npm run check` includes strict TypeScript and full synthetic tests. `tests/consumers/archive-monthly-index.test.ts` uses actual node:sqlite, isolated temporary Wiki roots, fault callbacks and killed processes. It covers full preservation/backlinks, pinned retention, per-page manual conflicts, unusable review, delete/intent crash recovery, schema/bad-line filtering, monthly typed output and replace/retract/manual protection, actual publisher-driven old-month refresh, merged index jobs, qmd retry/new work and coordinator death while an actual index writer remains alive. This evidence does not constitute production archive/index/automation acceptance.
