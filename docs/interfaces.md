# Public interfaces — schema version 1

Authoritative contracts are `src/contracts/types.ts`; no business implementation lives in contracts. UTC ISO timestamps end in `Z`, IANA zones are explicit, identities are opaque strings. Unknown values use `{schema_version:1,value:null,reason:"..."}`. `TimeRange` is half open `[from,to)`. Body size counts UTF-8 bytes. `physical_order` is an opaque stable sortable source locator, never a lossy numeric ID. The absent-file digest is `absent`.

## Ownership and entry points

- Integration: contracts, config, CLI, package/lock, integration tests and docs.
- A: `src/adapters/**`; export `createAdapters(config): SourceAdapter[]` from `src/adapters/index.ts`.
- B: `src/store/**`, `src/review/**`; export `createStore(config): Promise<Store>` and `createReviewer(store, config): Reviewer` from respective `index.ts`. Only B writes SQLite schema.
- C: `src/publish/**`; export `createPublisher(store, config): Publisher` from `src/publish/index.ts`.
- Consumers/migration are second-wave ports; absent services report explicit unavailable, never success.

## Collection

`adapter.collect({lane, cutoff, range, budget}, {checkpoints,config}): AsyncIterable<CollectionBatch>` yields bounded batches. `store.saveCollection(batch): Promise<void>` writes events, fragments, coverage and checkpoints in one transaction. Checkpoints describe bytes saved, never semantic review. Live and history checkpoints are separate. Duplicate physical messages retain distinct event IDs; relocations must reuse source identities. No model receives permanent identity allocation privileges.

## Review and semantic transaction

`reviewer.prepare({kind,lane,period?,cutoff,output_dir?}): Promise<ReviewBundle[]>` yields at most the configured four bounded bundles. Context events are marked separately. `reviewer.accept(result): Promise<ReviewCommit>` validates and commits without any LLM invocation.

`store.commitReview(result): Promise<ReviewCommit>` is one SQLite transaction: accepted result, application-allocated fact revisions/operation IDs, precisely completed chunks, patches and outbox. Validate candidate IDs and target refs against the persisted bundle. A complete zero-fact chunk explicitly says `zero_facts:true`. Partial/deferred chunks remain resumable. Repeated acceptance of the same stored result/bundle reuses IDs and bytes; changed content for the same identity conflicts. Keep candidates create no new fact revision. Replays expose existing facts and explicit keep/add/replace/retract.

`readEffectiveFacts({range,scope?,as_of?}): Promise<FactRevision[]>` folds replace/retract over live, archived and legacy records while retaining immutable history. Unresolvable targets defer only the affected candidate. Unknown legacy assertions remain `legacy_record`.

## Outbox and publication

`publisher.publish(result): Promise<PublishResult>` accepts the result once, independently exports facts, applies files and queues consumers. `publisher.resume()` resumes durable pending exports/intents without repeating model review.

`listOutbox(status?)`, `markExportReady(batch_id,path)`, `listReadyBatches(consumer)` and `acknowledgeConsumer(ack)` implement export and consumer separation. Only immutable ready batches reach consumers. Export uses temporary file plus rename and ID/content verification; consumer output completes before ack. Wiki lock conflicts never block export.

`publisher.applyPatches(patches): Promise<FileOutcome[]>` applies append/exact replacement, protecting manual edits. Before target mutation, `saveFileIntent(intent)` persists complete desired bytes or deletion plus complete old backup, old/new digest and stable operation ID. `desired_bytes_base64:null` means deletion; `backup_bytes_base64:null` means old target absent. New/deleted files use explicit `absent` digest. Recovery compares target to desired and baseline: desired registers applied/noop, baseline retries, otherwise conflict. Pending is never swallowed by deduplication. All Wiki writers share one live-process-aware lock.

`PublishResult` reports fact commit, export, per-file status, consumers and pending independently. No single success boolean can hide partial state.

## CLI and configuration

`BookkeepingConfig` uses required absolute `wiki_root` and `data_dir`, fixed `analysis_timezone: Europe/Amsterdam`, fixed UTC cutover/live-start, explicit providers/whitelists and bounded review limits. CLI consumes the above ports, never invokes an LLM, and outputs one JSON value to stdout with diagnostics on stderr. Exit 0 means command executed, including ordinary pending/partial; exit 1 means unavailable/execution failure; exit 2 means invalid args/input.

## Durable patches and migration

`listPendingPatches()` returns accepted journal operations that have not reached applied/noop, including conflicts. `markPatchStatus(operation_id,status,reason?)` durably marks their publication independently of fact/chunk review. Thus a crash between `commitReview` and `saveFileIntent` still resumes from the original stable operation.

`importLegacy(LegacyImportBatch): Promise<LegacyImportResult>` is the sole migration write port: stable `migration_key`, immutable legacy facts, explicit verified/unresolved ID mappings, and typed pending work. It is transactional and idempotent; identical key with different content conflicts. Unresolved mappings never transfer confirmations or silently merge facts. Migration modules do not access SQL directly.

## Analytics privacy projection

Every fact candidate/revision carries `analytics_projection: UnknownValue<AnalyticsProjection>`. A non-null projection contains only its professional summary, cropped scopes, subject, evidence refs and attribution; consumers never derive Analytics text from the original mixed fact content. Null projection with reason is pending/excluded, including historical missing projections. Source adapters do not construct this semantic projection. Reviewer authors the projection; store copies it immutably to the application-allocated revision. A replacement never inherits the prior projection or prior confirmation.

## Weekly/monthly semantic records (second-wave contracts)

`WeeklyAnalysisInput` contains professional projections with explicit FactRef revisions, analysis range/zone, independent coverage_status, at most four prior snapshots, prior action and confirmed goal revision refs. It never contains original mixed-life fact content. `WeeklyAnalysisResult` contains a stable `logical_id+revision` snapshot, observation revision/evidence/attribution pairs, capability trends, goal gaps, direction/patterns, at most three proposed confirmations and one validation action. The preceding action is explicitly continued/narrowed/abandoned by stable revision ref. `AnalyticsReviewEvent` binds append-only confirm/reject/correct/retract to the target revision; stale revision operations are local stale events.

`ReviewBundle.analysis_context` and `ReviewResult`/`FactArtifact.analysis` carry these records. Monthly context/results have separate typed month/range/effective-facts/coverage/manual-baselines and summary/factrefs/supplement fields. These are optional additive transport fields; M1 does not yet implement Analytics/weekly/monthly semantic persistence or consumers. An unsupported gap must remain visible until second-wave implementations validate and persist these records. The new fields must not be silently accepted and dropped at publication.

Shared calendar utilities in `src/time.ts` provide explicit IANA local dates and Europe/Amsterdam Monday–Sunday ranges, including 167/169-hour DST weeks. Source precision includes `minute`; no-offset imports still require batch timezone and retain original precision.

`SourceAdapter.close()` releases open discovery handles; RuntimeServices.close() releases adapters then Store. Command-scoped runtime composition leaves sources uninitialized for status/facts/backup. Restore calls `restoreStore(input,newDirectory)` directly without opening the current database. Collection budgets may be explicitly configured via `collection_budgets`; defaults remain finite and resumable, not permanent maximum gates.

Goal and major-decision contracts use stable revision refs. New contract submissions have `confirmed:false`; only a user `confirm` event against that exact revision activates them. The goal retains subject/target_version/deadline. A decision retains subject, confirmed goal revision, UTC valid_from/to and exact trigger name/expected_value. Its trigger reads only an `AnalyticsProjection.verification` with explicit `user_explicit_verification` basis, matching subject/time and a kind=fact source revision. Inference, cwd or ordinary activity cannot trigger it. Persistently notify once per fact revision + decision revision. `AnalyticsReviewInput` distinguishes review events, goal-contract submissions and decision-contract submissions; `ReviewReceipt` makes stale or pending targets visible without revoking unrelated reviews.

Monthly queue acknowledgement: `MonthlyReviewInput.prepared_work_ids` lists only pending `prepare_monthly` work actually included in the bounded bundle for that month. Omitted IDs remain pending and are explicitly disclosed. `MonthlyReviewResult.completed_work_ids` may contain only a subset of those IDs. Store validates the subset and preserves it in the ready artifact; successful managed monthly publication completes precisely those IDs. Later/unread work must remain pending.
