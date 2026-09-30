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
