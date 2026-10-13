# October 7 operational CLI and authoring

All commands use Node25.8.0 and an explicit absolute `--config CONFIG`. Output/manifests are private local directories outside Wiki, sources and iCloud (0700; files0600). Development uses synthetic data only. This CLI invokes no model. The automation author reviews the entire bounded material and writes its own ReviewResult or JournalResolution.

## Daily step protocol

```sh
node src/cli.ts daily-round --manifest /ABS/PRIVATE/run/manifest.json --output /ABS/PRIVATE/run --config /ABS/config.json
node src/cli.ts daily-round --manifest /ABS/PRIVATE/run/manifest.json --output /ABS/PRIVATE/run --input /ABS/PRIVATE/run/review.json --config /ABS/config.json
node src/cli.ts daily-round --manifest /ABS/PRIVATE/run/manifest.json --output /ABS/PRIVATE/run --journal-input /ABS/PRIVATE/run/resolution.json --config /ABS/config.json
node src/cli.ts daily-round --manifest /ABS/PRIVATE/run/manifest.json --output /ABS/PRIVATE/run --defer-active 'Explicit local failure reason' --defer-stage review --config /ABS/config.json
```

Optional first `--cutoff UTC` cannot be later than actual start. Resume requires the original cutoff/config/output. `--input`, `--journal-input`, `--defer-active` are mutually exclusive. `--defer-stage` requires deferral and accepts `review|material|publish|journal`; default is review or journal according to active material. A missing input returns the same active object. Invalid JSON/format returns `repair_input` and retains active without quota; repair only formatting against the same frozen bundle and submit again. If actual review fails or no usable result JSON exists, explicitly defer with reason; exact original event byte units or journal work IDs are skipped for this run only. Neither path fabricates zero facts or completion.

Response fields: `schema_version,run_id,manifest,cutoff,started_at,state,terminal,semantic_deadline,task_deadline,next_action,started_bundles,capture_elapsed_ms,remaining_ms,active,stages`. `review` active has `{kind:'source',source,lane,bundle_id,file,units}`; `journal_review` active has `{kind:'journal',journal_bundle_id,file,work_ids}`. `publication_pending` retains accepted active input for recovery; `repair_input` includes reason/next_action. `complete|deadline` include durable remaining status when time permits and/or a stop reason. Execution failures exit1 (input errors2); a storage failure may also return `receipt` preserving already committed/exported/file outcomes. Do not report the failed command as if no facts were accepted.

`stages` contains receipt refs plus counts/status metadata. Full original stage results live in `OUTPUT/receipts/UUID.json`; no receipt text is truncated. The scheduling manifest contains refs and small summaries, not thousands of old noop outcomes. Each run starts at original `started_at`, captures at most20min, starts no semantic source/journal review at105min, stops new atomic operations/consumers at120min. Model/tool subprocess timeouts must also be bounded by returned remaining_ms. Each24 source starts reserve16live/8history; source and journal share96 starts. Initial journal is at most1 batch, sources get each live then each history, later2:1 and a journal opportunity after four completed source packets and priority after ninety minutes. Failed/empty source-lanes do not consume quota. A fresh manifest is required for a later run.

Source result authoring remains [review-result-authoring.md](review-result-authoring.md): every actual supplied chunk requires explicit complete/partial/deferred progress; only fully reviewed zero-fact chunks get `zero_facts:true`. Optional `journal_dispositions` binds candidate/date/path to `patch|already_present|not_needed|defer`. `patch` supplies a matching actual page suggestion; other decisions give a reason, and `already_present` gives exact meaningful `evidence_text` from a current full baseline. Absent fields are accepted compatibility data and leave debt.

## Journal APIs and exact JSON

```sh
node src/cli.ts journal-prepare --output /ABS/PRIVATE/journal --cutoff UTC --max-items 32 --config CONFIG
node src/cli.ts journal-prepare --work /ABS/PRIVATE/selection.json --output /ABS/PRIVATE/journal --cutoff UTC --config CONFIG
node src/cli.ts journal-resolve --input /ABS/PRIVATE/resolution.json --config CONFIG
```

Selection is `{schema_version:1,work_ids:["exact-work-id"]}`. `--max-items` is positive and additionally bounded by Reviewer material limits. Preparation writes one compact JournalWorkBundle no larger than configured final bundle bytes and returns `journal_bundle_id,cutoff,file,work_ids,facts,baselines,conflicts` (last three are counts). The material contains frozen work, accepted exact revisions, retirement/related existing facts, complete current baselines or disclosed excerpts and real operation conflicts. Standalone oversize explicit selections reject; use a smaller prefix. The daily scheduler automatically shrinks selection and isolates single failures.

JournalResolution example (substitute exact IDs/date/path/baseline from material):

```json
{
  "schema_version": 1,
  "resolution_id": "journal-resolution:stable-author-id",
  "journal_bundle_id": "exact-frozen-bundle-id",
  "created_at": "2026-10-06T12:00:00Z",
  "dispositions": [
    {"schema_version":1,"work_id":"exact-work-id","disposition":"patch","suggestion_id":"page:1","reason":null}
  ],
  "pages": [
    {"schema_version":1,"suggestion_id":"page:1","work_ids":["exact-work-id"],"date":"2026-10-05","path":"wiki/personal/journals/日记_2026_10_05.md","baseline_digest":"exact-digest","mode":"append","old_text":null,"new_text":"Explicit factual journal text.\n"}
  ]
}
```

For selected work carrying `payload.operation_id`, a patch MUST carry the exact same `supersedes_operation_id`; do not mix originals with different operation IDs in one suggestion. An existing body/summary semantic replacement becomes a stable awaiting-user-confirmation proposal; it is not automatically applied. Pure metadata/format maintenance remains independently constrained. Non-patch dispositions have no suggestion: `already_present` requires strong full baseline_assessment, evidence_text exactly equal to its complete body_evidence_text, and nonempty reason; the evidence records complete paragraph/list-item bytes without claiming automatic semantic proof. For a still-effective fact, `not_needed` requires a nonempty editorial reason plus the current full strong baseline_assessment; only an already corrected/withdrawn old revision additionally requires frozen related retirement proof. `defer` keeps work pending with reason. A manual edit after preparation rejects old baseline decisions: reprepare, then author a new resolution ID. Immutable accepted resolution retries reuse the same exact JSON/ID. Unresolved/excerpt/missing facts are deferred locally.

Resolution has no `chunks,candidates,facts,bundle_id,analysis,monthly_review`: no second semantic result/revisions/marks/outbox. It returns `resolution_id,reused,work_ids,files,publication,pending`, independently showing committed file resolution and actual apply/resume/export/derived outcomes. Debt closes only upon verified target display or validated explicit terminal decision. A queued historical supplement remains pending until exact frozen work actually appears in monthly output; never recreate expired daily files.

An error after resolution acceptance does not imply rollback. Apply/resume exceptions return exit1 with `receipt` carrying `resolution_commit:'committed'`, stable resolution/work/patch IDs, `continuation.stage=apply|resume` and failed status. `files:null` means apply failed before it returned a complete receipt; for resume failure, actual preceding files are retained and `publication:null` means no complete resume report was returned. Inspect persisted resolution/work/operation metadata before retrying. Old monthly_display work without fact_refs preserves its immutable payload; the existing exact ready batch supplies compatibility refs during monthly rendering. Store identity checks remain strict for changed existing payloads.

## Acceptance-time inventory and recovery

```sh
node src/cli.ts journal-inventory --from UTC --to UTC --limit 100 --output /ABS/PRIVATE/inventory/page-1 --config CONFIG
node src/cli.ts journal-inventory --from UTC --to UTC --after-result EXACT_CURSOR --limit 100 --output /ABS/PRIVATE/inventory/page-2 --config CONFIG
node src/cli.ts journal-recover --input /ABS/PRIVATE/recover-100.json --config CONFIG
```

`from/to` is actual acceptance half-open UTC, limit1–100 (default20). Console response gives file/counts/result_ids/unknown_acceptance/next_result_id/range. Full AcceptedDailyInventory contains items with accepted_at UnknownValue, separate result_created_at, acceptance_time_basis, window_membership, complete saved bundle/result/commit/facts/target revisions/patch statuses/conflicts. Older actual acceptance time is unknown and included by default regardless of business date/model timestamp; `--exclude-unknown` excludes those explicitly. Continue using returned cursor and original window until null; save each page in a distinct output directory. Do not infer acceptance from filename or mtime.

Recovery input is `{schema_version:1,result_ids:["exact-accepted-daily-result-id"]}` with1–100 unique IDs. Coordinator establishes its private evidence/scope first, including manually accepted historical results with business dates earlier than the acceptance window. Recovery uses actual runtime clock, is idempotent and only adds missing precise publication work; no facts/review completion/export are duplicated. Response lists exact result_ids and work_ids; then run bounded journal preparation/resolution (or daily round) to settle. `status` distinguishes eligible review debt/excluded or blocked stored records, capture/unread observations, facts/outbox/files/consumer/journal pending/conflict/unresolved.

## Full-record inspection

```sh
node tools/inspect-review-material.ts --input /ABS/PRIVATE/material.json --section facts --offset 0 --limit 20
```

Accepts ReviewBundle, JournalWorkBundle, AcceptedDailyInventory or JournalConfirmationProposal. V2 emits compact JSON <=16384 UTF-8 bytes including newline/envelope. Sections include metadata/events/facts/baselines/summary/coverage/unfinished/archive_contexts and the journal/inventory sections. Follow each exact-material section next_cursor object through every fragment. Concatenate json_fragment by stable item_id and exact byte_start/end, verify total_bytes/item_sha256 and parse complete JSON before reviewing. Summary is only identity/count/directory/read-state; it never means semantic completion. Metadata preserves monthly/weekly/replay/requirements and frozen work/page contracts; facts live in their separate bounded section. Source slices and baseline excerpts stay explicit. No inspection creates semantic progress or proves model understanding. Old --limit cannot enlarge v2 output; explicit --offset does not certify skipped records read. Read every relevant section; unread fragments/deferred units remain debt.

## October 7 finish, continuation and monthly steps

`daily-round --manifest ABS --output ABS --finish --reason REASON --config CONFIG` keeps the original start/cutoff/count/active metadata. It creates no material, defers exact unread units, recovers accepted publication/consumers within the original remaining time and normally saves terminal=true. Shared-storage failure or process interruption may retain a nonterminal manifest; do not keep writing failed storage merely to record a terminal state. Metadata deadline/finish precedes source read guards. A terminal run may retain ordinary pending debt. Complete committed exceptions are saved in receipt files when storage remains writable, otherwise returned intact in error.receipt; publication_pending keeps accepted IDs, not a request to rewrite semantics.

`prepare --kind daily --lane history --source PROVIDER --from UTC --to UTC --cutoff ORIGINAL --selection-basis event_time --output ABS --config CONFIG` selects event dates across physical capture lanes. Omitted selection-basis on old explicit range/period preserves capture_lane. Replay is unchanged. For provider preparation.state=more, save its continuation object privately and pass `--continuation ABS_JSON` with the same complete scope; never invent/edit cursor. Empty filtered pages do not exhaust a source or consume starts. Deferred units remain source debt.

`monthly-round --manifest ABS --output ABS [--cutoff UTC] [--pages ABS_PATHS_MANIFEST] [--archive-month YYYY-MM] --config CONFIG` begins previous complete month, then oldest eligible pending months. Each returns at most one active monthly packet and rotates after acceptance. Submit `--input ABS_RESULT`, explicitly `--defer-active REASON`, or stop with `--finish --reason REASON`. Original two-hour/105-minute/96-start clocks and each month's frozen snapshot/cutoff/offset persist. Archive-month must precede the previous month and is attempted at most once after semantic settlement through report/apply; omitted means no archive request. Missing metadata capability is unavailable, never an empty completed queue. Only explicitly complete chunks with persisted exact fact-material reads advance; accepted partial/omitted chunks retain the original page. Exact-snapshot metadata first-unread positions prevent skipping oversized holes; absent progress is not completion, and a newer month snapshot cannot prove the active snapshot read. Reuse a manifest only within its original deadline; later normal tasks create a new manifest, and separate recovery cannot retrospectively certify the expired scheduled run. manual originals not supplied remain partial. See complete replacement prompts [daily](daily-automation-prompt-2026-10-07.md) and [monthly](monthly-automation-prompt-2026-10-07.md); coordinator installs them without changing model/effort/schedule.

Compact stage_outcomes is authoritative only to the extent of its real receipts and metadata: review, fact export, file publication, journal, index and expected consumers are independent. terminal/state complete means this scheduling run stopped. A96-start limit or105-minute semantic cutoff cannot prove exhaustion; missing consumer execution is not_run, absent final metadata is unknown, awaiting/deferred/conflict debt is partial. Consumers completing queue delivery do not complete monthly semantics.

Current journal closure uses strong full-baseline assessment and exact complete paragraph/list-item evidence. already_present.evidence_text equals body_evidence_text; not_needed also requires strong assessment, including for a still-effective fact. Facts/export remain independent when closure evidence is insufficient.
