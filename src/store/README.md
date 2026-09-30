# Transactional store

`createStore(config)` opens the local `bookkeeping.sqlite` with WAL, FULL synchronous writes and a 10-second writer wait. `BEGIN IMMEDIATE` covers complete collection batches and complete semantic acceptance. Immutable identity collisions raise a conflict; accepted bundle content reuses the original IDs even if a model changes `result_id` or `created_at` on retry.

`StoreOptions.onTransactionStep` is a synchronous instrumentation hook. Tests inject exceptions and terminate a subprocess at these boundaries; the SQLite transaction remains the recovery authority.

Review completion stores exact UTF-8 byte intervals for source events. Changing chunk limits cannot swallow or revisit already reviewed intervals. Daily source review is shared across live/history transport lanes; provider checkpoints remain separate. Weekly/monthly preparation exposes professional projections of effective facts and explicit gaps for the still unsupported semantic analysis payload. It does not allocate duplicate direct facts from the original chats.

Unknown time/role/classification fields can be enriched monotonically. Original content, provider/account/conversation and native IDs remain immutable; disputed recapture is retained in a local `event_conflict` work item with original raw fragments, allowing the rest of a provider batch to advance. Existing unknown fields are never erased by a later incomplete capture.

Patch persistence is independent of file intent creation. `listPendingPatches()` recovers the interval after semantic commit and before any file intent exists. Export readiness is independent of per-consumer acknowledgement. A journal conflict does not cancel an outbox artifact.

`backup()` uses `VACUUM INTO`, returns a consistent SQLite snapshot and applies mode 0600. It includes embedded raw fragments, full accepted results, facts, durable patches, complete intent/backup bytes and outbox artifact bytes. `restoreStore(input, newDirectory)` verifies integrity and schema, requires a previously nonexistent destination and preserves this state. Export paths and consumer acknowledgements are historical state; publishers can recover immutable artifact bytes from the database if an external export disappears. Restore does not roll back or overwrite existing Wiki files.

Independent synthetic checks live in `tests/store` and `tests/review`. No private data or old implementation is used as an oracle.
