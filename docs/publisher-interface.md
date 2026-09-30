# Publisher and shared Wiki writer — schema version 1

Implementation: `src/publish/index.ts`. Entry point `createPublisher(store, config): Publisher`. Native Node 25.8.0 runs the TypeScript directly. No model calls, subprocess LLM, old controller, marker, receipt or source recollection are used.

## Independent durable stages

`publish(result)` calls the Store's atomic `commitReview`, exports every outbox batch, then resumes pending accepted journal patches and file intents. `resume()` never accepts or reviews a result: it discovers `listPendingPatches()` first, including accepted patches whose crash happened before their first FileIntent. It also visits persisted intents, including applied intents, to repair the gap between file registration and index queueing. Patch statuses become applied/noop only after this repair succeeds. Pending/conflict patches remain discoverable.

Facts export to local `data_dir/facts/batches/<sha256(batch_id)>/artifact.json`. Canonical JSON preserves all FactArtifact facts and coverage, including a complete zero-fact result. A complete candidate directory containing the synced immutable JSON is atomically renamed to the final batch directory. A nonempty final directory cannot be overwritten by a competing exporter. Before registering ready, bytes must match the current outbox artifact exactly. Existing different content is pending with an export work reason. After rename-before-registration interruption, resume verifies the existing bytes and registers them ready. Export and consumer queueing require no Wiki lock or daily Markdown. Ready exports are exposed by Store consumer ports; no batch is acknowledged here.

## Shared lock

Exports: `acquireWikiLock(wikiRoot): Promise<WikiLock|null>`, `withWikiLock(wikiRoot, callback): Promise<T|null>`, `assertWikiLockHeld(lock)`, and `wikiLockLocation(wikiRoot)`.

Every daily/archival/monthly/cockpit/meta writer must use this lock, including writers whose `data_dir` differs. Its identity is the canonical Wiki realpath, and its local location is `<os.tmpdir>/llm-bookkeeping-writer-<uid>/<sha256(root)>/active`. Lock ownership is an opaque token and PID, published as a fully populated nonempty directory via atomic rename. Acquisition is nonblocking. A live PID or permission-denied PID is busy regardless of elapsed time; no TTL permits stealing it. Unknown/malformed ownership stays busy. PID reuse conservatively stays busy.

Only a definitely dead PID (`kill(pid,0)` yields ESRCH) permits reclaiming `active`. Reclamation renames to a permanent nonempty `dead-<old-token>` tombstone. Two reapers of the same old owner cannot move a subsequent live lock to that already nonempty destination. Do not delete these tombstones while writers might run. They contain ownership metadata, not private Wiki content. Candidate directories are cleaned after acquisition attempts. A held lock must be released in `finally`; release is idempotent. It cannot be reused for writes after release. Locks cover filesystem reads/intents/mutations, never LLM review or full semantic thinking.

## Safe write API for all consumers

`createSafeWikiWriter(store, config)` returns:

- `write({operation_id,path,baseline_digest,desired_bytes,fact_refs?})`: acquires/releases the shared lock; returns pending on a busy lock.
- `writeLocked(request, lock)`: reuses a caller's held lock for a file operation. This is useful for archival preconditions and exact backlink operations in one lock interval.
- `recoverLocked(intent, lock)`: resumes a saved intent under that same lock.

`desired_bytes` is a Uint8Array/Buffer, or null for deletion. `digestBytes(bytes)` produces SHA256, or `absent` for null. `readWikiTarget(wikiRoot,path)` supplies a checked current snapshot. Paths can be Wiki-relative or absolute inside the canonical root. Lexical `..`, outside absolute paths, backslashes, NUL, any symlink target/ancestor, directories as targets and `raw` components are rejected. Existing `_evidence/daily_journals` files and legacy `daily_YYYY.jsonl` are immutable: create a new version file for archived originals. A successful new immutable archive can be recovered/nooped through its original operation ID. New archive deletion is never inferred automatically.

Use an application-assigned stable operation ID; never allocate another ID just to bypass a conflict. The API requires an exact current baseline. It persists FileIntent containing full desired bytes or deletion, full old bytes or absence, old/new digests, target, fact refs and creation time before mutating the file. It writes a unique same-directory temp using exclusive/no-follow open, syncs bytes, rereads both target and path safety, renames atomically (or unlinks for deletion), syncs the directory, registers applied, and queues index. This API is a low-level byte operation: archive must independently prove preserved original, usable review, exact backlinks, pinned/intentional retention and digest preconditions before requesting deletion.

Recovery compares current content with the saved new and old digests. New means register/noop; old means retry; other means conflict, preserving full draft and backup. Creation/deletion have explicit absent sentinels. An applied intent remains a noop even if a person subsequently changes its file; index registration can be repaired without writing over the person. Unchanged old/new bytes create no index work. Pending is never converted to success just because its stable ID already exists. Changed request target/desired bytes for an existing operation conflicts.

Uncoordinated human/iCloud writers do not participate in the process lock. The last check prevents observed concurrent changes, but POSIX rename does not provide a cross-device compare-and-swap transaction; full intent backups remain available for reconciliation. Content conflicts never trigger a forced overwrite or LLM rerun.

## Journal semantics and retention evidence

JournalPatch append adds only the supplied text to the current bytes, preserving manual body/todos/links. Exact replacement requires one nonempty old_text occurrence; absent or repeated occurrences conflict. On a changed initial baseline, the publisher can compute this local append/unique replacement once using the new manual contents before saving intent. After intent persistence, a further changed target conflicts instead of silently rebasing the saved draft.

The retained calendar window is the current local month and preceding full month, using the configured journal timezone timeline at the current publication instant. Historical `patch.date` is never reassigned to today's timezone. Retention applies only to canonical daily targets under `wiki/personal/journals/`: exact `日记_YYYY_MM_DD.md`, or existing pages explicitly typed journal/daily-journal with a date. Monthly/review/project/weekly pages cannot become daily merely because their patch has an old date. Archived dates and missing dates before that window queue `journal_supplement`; they do not recreate daily Markdown. An archived but intentionally retained/pinned existing page permits local append/exact replacement. Supported frontmatter keys are `pinned: true`, `retention: pinned`, `intentional-journal: true` or `intentional_journal: true`; tags `pinned-daily` and `intentional-journal` also preserve the page.

Archive state is reconstructible from these sources (all are read-only in publisher):

- `data_dir/retention/state.json` with `{schema_version:1,archived_dates:["YYYY-MM-DD",...]}` is an optional local projection.
- Completed Store work with `kind:"archive"`, whose payload contains `archived_dates` or `entries`/`records`/`journals` with `date`. This is the canonical/date index written after actual new archive output succeeds.
- Wiki `wiki/personal/_evidence/daily_journals/**/*.json|jsonl`: archived records with `date`, or those arrays; old annual JSONL's `retention:"pinned"` is excluded. Existing annual archives are never modified.

Malformed available metadata or symlink metadata becomes visible pending for the affected publication; it is not treated as proof that a date is unarchived. New archive consumers should emit the canonical/date index and reconstruct the optional local projection from it. A supplement's patch status noop describes the absent daily file operation; its separate pending supplement work and fact batch remain durable.

## Work conventions

Stable IDs are constructed from operation/batch/period and Store's enqueue is idempotent without reopening complete work. Successful output is required before consumers acknowledge/complete work.

| kind | work_id | payload |
| --- | --- | --- |
| consumer | `consumer:<analytics|monthly>:<batch_id>` | consumer, batch_id, affected_dates, affected_weeks, affected_months |
| date / week / month | `<kind>:<batch_id>:<period>` | period, batch_id |
| index | `index:<operation_id>` | path, operation_id, digest (including absent for successful deletion) |
| journal_supplement | `journal_supplement:<operation_id>` | original stable patch, reason |
| export | `export:<batch_id>` | batch_id, diagnostic reason on WorkItem |

Facts/coverage revisions queue date/week/month consumers from the artifact's affected periods. Months derive from affected dates and week-end dates. Only successfully changed files produce index work; failed/conflicting/busy files do not. Index consumption coalesces by current path and reads current contents: the saved digest identifies the published change, and may precede later manual editing. An export failure work completes after bytes, registration and consumer queueing recover. `PublishResult` independently reports semantic commit, export, each file, consumer outstanding batches/index work and pending reasons.

## Verification and injection

An optional third `WriterOptions` argument to createPublisher/createSafeWikiWriter allows a synthetic `now()` and a `fault(stage,operation_id)` callback. Production calls omit it. Stages: before_intent, after_intent, before_target, after_target, after_file_registered, after_export_rename. A failure returns durable pending for publication (the low-level safe writer throws while preserving state); subsequent resume does no semantic/LLM work. Run `node --test tests/publish/publisher.test.ts` and `npm test` on Node 25.8.0. Tests use only synthetic temporary roots and a port-shaped fake Store; integrated real SQLite verification belongs to coordinator.
