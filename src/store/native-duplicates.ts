/** Bounded, explicit maintenance preparation. No event mutation or semantic commit. */
import { DatabaseSync } from 'node:sqlite';
import { join, isAbsolute } from 'node:path';
import { mkdir, lstat, chmod, readFile, open } from 'node:fs/promises';
import type { BookkeepingConfig, RawFragment, ReviewBundle, ReviewResult, SourceEvent, TimeRange } from '../contracts/types.ts';
import {exactReviewUnit} from './unit-dispositions.ts';
import { record, string, array, version, utcComparisonKey, utc } from '../contracts/validation.ts';
import { canonical, digest } from '../analytics/serialization.ts';
import { canonicalLocation, validateDataLocation } from '../config.ts';
import { createStore } from './index.ts';
import { ReviewReadExclusions } from './read-exclusions.ts';
import { correctCodexClassification } from './codex-automation.ts';

export interface NativeDuplicateManifest {
    schema_version: 1;
    source: string;
    range: TimeRange;
    pairs: { canonical_event_id: string; redundant_event_id: string }[];
}
interface SavedEvent { event: SourceEvent; rowid: number; reviewed: boolean; partial: boolean }
interface PlannedReview { bundle: ReviewBundle; result: ReviewResult }
export interface DuplicatePreview {
    schema_version: 1; plan_sha: string;
    counts: { pairs: number; eligible: number; already_reviewed: number; partial_review: number; prepared: number; deferred: number; bundles: number };
    required_bundle_bytes: number | null;
    required_chunk_body_bytes: number | null;
}
interface Plan { preview: DuplicatePreview; materials: PlannedReview[] }

export function validateDuplicateManifest(input: unknown): NativeDuplicateManifest {
    const value = version(input, 'duplicate manifest');
    const source = string(value.source, 'duplicate source');
    if (!source.trim() || source.length > 128) throw new Error('Invalid duplicate source');
    const rangeValue = version(value.range, 'duplicate range');
    const range: TimeRange = { schema_version: 1, from: utc(rangeValue.from, 'duplicate range.from'), to: utc(rangeValue.to, 'duplicate range.to') };
    if (utcComparisonKey(range.from) >= utcComparisonKey(range.to)) throw new Error('Duplicate range must be nonempty');
    const pairs = array(value.pairs, 'duplicate pairs').map((input: unknown) => {
        const pair = record(input, 'duplicate pair');
        return { canonical_event_id: string(pair.canonical_event_id, 'canonical ID'), redundant_event_id: string(pair.redundant_event_id, 'redundant ID') };
    });
    if (!pairs.length || pairs.length > 64) throw new Error('Duplicate manifest requires 1..64 explicit pairs');
    const redundant = new Set<string>();
    for (const pair of pairs) {
        if (!pair.canonical_event_id || !pair.redundant_event_id || pair.canonical_event_id.length > 512 || pair.redundant_event_id.length > 512
            || pair.canonical_event_id === pair.redundant_event_id || redundant.has(pair.redundant_event_id)) throw new Error('Invalid/repeated duplicate pair ID');
        redundant.add(pair.redundant_event_id);
    }
    if (pairs.some(pair => redundant.has(pair.canonical_event_id))) throw new Error('Canonical IDs cannot also be redundant');
    return { schema_version: 1, source, range, pairs: pairs.sort((a, b) => a.redundant_event_id.localeCompare(b.redundant_event_id)) };
}

function readCurrent(db: DatabaseSync, id: string, exclusions: ReviewReadExclusions): SavedEvent {
    if (!exclusions.allowed(id)) throw new Error('Native duplicate source event read excluded');
    const row = db.prepare('SELECT rowid,json FROM events WHERE id=?').get(id) as { rowid: number; json: string } | undefined;
    if (!row) throw new Error('Manifest event missing');
    let event = JSON.parse(row.json) as SourceEvent;
    if (event.schema_version !== 1 || event.event_id !== id) throw new Error('Manifest event primary key/schema mismatch');
    const fragment = (source: SourceEvent): RawFragment | null => {
        if (!exclusions.eventAllowed(source)) throw new Error('Native duplicate source event read excluded');
        if (exclusions.fragmentBlocked(db, source.fragment_ref)) throw new Error('Native duplicate original fragment read excluded');
        const raw = source.fragment_ref && db.prepare('SELECT json FROM fragments WHERE id=?').get(source.fragment_ref) as { json: string } | undefined;
        return raw ? JSON.parse(raw.json) : null;
    };
    // Preview also observes current verified classification without changing DB.
    // This is the same indexed, exact-source anchor used by normal Store reads.
    if (event.source.provider === 'codex') {
        const anchorRow = event.role === 'assistant' ? db.prepare("SELECT id,CASE WHEN review_read_allowed(id)=1 THEN json ELSE NULL END AS json FROM events WHERE json_extract(json,'$.source.provider')='codex' AND json_extract(json,'$.source.account_id')=? AND json_extract(json,'$.source.conversation_id')=? AND json_extract(json,'$.locator')=? AND json_extract(json,'$.generation')=? AND json_extract(json,'$.role')='user' AND ordering<? ORDER BY ordering DESC,id DESC LIMIT 1")
            .get(event.source.account_id, event.source.conversation_id, event.locator, event.generation, event.physical_order) as { id: string; json: string | null } | undefined : undefined;
        if (anchorRow && anchorRow.json === null) throw new Error('Native duplicate nearest user anchor read excluded');
        const anchor = anchorRow?.json ? JSON.parse(anchorRow.json) as SourceEvent : null;
        event = correctCodexClassification(event, fragment(event), anchor, anchor && fragment(anchor)).event;
    }
    const reviewed = !!db.prepare("SELECT 1 FROM reviewed_sources WHERE kind='daily' AND source_id=? LIMIT 1").get(id);
    const partial = !reviewed && (!!db.prepare("SELECT 1 FROM reviewed_units WHERE kind='daily' AND event_id=? LIMIT 1").get(id)
        || !!db.prepare("SELECT 1 FROM reviewed_spans WHERE kind='daily' AND source_id=? LIMIT 1").get(id));
    return { event, rowid: row.rowid, reviewed, partial };
}

function proofValue(event: SourceEvent): unknown {
    const { turn_complete: _turnComplete, ...context } = event.context;
    return {
        source: event.source, body: event.body, role: event.role, channel: event.channel, kind: event.kind,
        classification: event.classification, original_time: event.original_time, utc_time: event.utc_time,
        time_precision: event.time_precision, wire_timezone: event.wire_timezone,
        journal_date: event.journal_date, journal_timezone: event.journal_timezone, journal_timezone_basis: event.journal_timezone_basis, context,
    };
}
function checkEvent(event: SourceEvent, manifest: NativeDuplicateManifest): void {
    if (event.source.provider !== manifest.source || !event.source.account_id || !event.source.conversation_id || !event.source.message_id
        || event.body === null || !['user', 'assistant'].includes(event.role) || event.classification !== 'main'
        || event.context.context_only === true || event.context.incomplete_turn === true || event.original_time.value === null
        || event.utc_time.value === null || event.time_precision === 'unknown') throw new Error('Duplicate event lacks a complete main native identity/time boundary');
    const time = utcComparisonKey(event.utc_time.value);
    if (time < utcComparisonKey(manifest.range.from) || time >= utcComparisonKey(manifest.range.to)) throw new Error('Duplicate event outside explicit range');
}
function checkPair(canonicalEvent: SavedEvent, redundant: SavedEvent, manifest: NativeDuplicateManifest): void {
    const a = canonicalEvent.event, b = redundant.event;
    checkEvent(a, manifest); checkEvent(b, manifest);
    if (a.generation === b.generation || canonical(proofValue(a)) !== canonical(proofValue(b))) throw new Error('Duplicate pair differs in strict native/content/time/context fields');
    const at = a.context.turn_complete, bt = b.context.turn_complete;
    if (at !== bt && !([at, bt].every(value => typeof value === 'boolean'))) throw new Error('Unproven completion metadata difference');
    // A completed review wins; otherwise the sole allowed monotonic metadata
    // difference is false -> true completion, then oldest persistent row wins.
    const preferred = canonicalEvent.reviewed !== redundant.reviewed ? canonicalEvent.reviewed
        : at !== bt && typeof at === 'boolean' && typeof bt === 'boolean' ? at
        : canonicalEvent.rowid < redundant.rowid;
    if (!preferred && !redundant.reviewed) throw new Error('Manifest canonical does not match reviewed/completion/earliest priority');
    if (!canonicalEvent.reviewed && a.role !== 'user' && at === false) throw new Error('Canonical assistant turn is not complete');
}

function material(events: SourceEvent[], manifest: NativeDuplicateManifest): PlannedReview {
    const identity = digest(canonical({ completion_policy:'primary_spans_v1',source: manifest.source, range: manifest.range, events }));
    const chunk = { schema_version: 1 as const, chunk_id: 'native-duplicate-chunk:' + identity, events, context_events: [],
        body_bytes: events.reduce((n, event) => n + Buffer.byteLength(event.body ?? ''), 0) };
    const bundle: ReviewBundle = { schema_version: 1,review_requirements:{schema_version:1,unit_dispositions:true,inspection_version:2,completion_policy:'primary_spans_v1'}, bundle_id: 'native-duplicate-bundle:' + identity, kind: 'daily', lane: 'history', period: null,
        cutoff: manifest.range.to, chunks: [chunk], existing_facts: [], baselines: [], coverage: [], unfinished: [{ schema_version: 1, range: manifest.range,
            reason: 'Explicit native duplicate closure only; canonical source state and capture coverage are unchanged', locator: null, resumable: false }] };
    const result: ReviewResult = { schema_version: 1, result_id: 'native-duplicate-result:' + identity, bundle_id: bundle.bundle_id, created_at: manifest.range.to,
        chunks: [{ schema_version: 1, chunk_id: chunk.chunk_id, status: 'complete', reviewed_event_ids: events.map(event => event.event_id), zero_facts: true,
            reason: 'Strict manifest-proven redundant native events; no new semantic fact' }], candidates: [], pages: [],unit_dispositions:events.map(event=>({schema_version:1,units:[exactReviewUnit(event)],disposition:'no_persistent_information',fact_refs:[],reason:'Strict exact native duplicate proof; no additional persistent information'})) };
    return { bundle, result };
}

function buildPlan(db: DatabaseSync, config: BookkeepingConfig, manifest: NativeDuplicateManifest): Plan {
    const exclusions = new ReviewReadExclusions(config);
    exclusions.validateExists(db);
    db.function('review_read_allowed', id => exclusions.allowed(id) ? 1 : 0);
    const ids = [...new Set(manifest.pairs.flatMap(pair => [pair.canonical_event_id, pair.redundant_event_id]))];
    if (ids.some(id => !exclusions.allowed(id))) throw new Error('Native duplicate source event read excluded');
    const saved = new Map(ids.map(id => [id, readCurrent(db, id, exclusions)]));
    const eligible: SourceEvent[] = [], evidence: unknown[] = [];
    let alreadyReviewed = 0, partialReview = 0;
    const referenced = new Set(db.prepare("SELECT DISTINCT json_extract(ref.value,'$.event_id') AS id FROM facts f,json_each(f.json,'$.event_refs') ref WHERE json_extract(f.json,'$.kind')!='legacy_record' AND json_extract(ref.value,'$.event_id') IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(manifest.pairs.map(pair => pair.redundant_event_id))).map(row => row.id as string));
    for (const pair of manifest.pairs) {
        const kept = saved.get(pair.canonical_event_id)!, extra = saved.get(pair.redundant_event_id)!;
        checkPair(kept, extra, manifest);
        if (referenced.has(pair.redundant_event_id)) throw new Error('Redundant event is referenced by an accepted nonlegacy fact revision');
        evidence.push({ pair, kept, extra });
        if (extra.reviewed) alreadyReviewed++;
        else if (extra.partial) partialReview++;
        else eligible.push(extra.event);
    }
    const materials: PlannedReview[] = [];
    let group: SourceEvent[] = [], deferred = 0, requiredBytes = 0, requiredBodyBytes = 0;
    const fits = (items: SourceEvent[]) => items.length <= config.limits.chunk_events
        && items.reduce((n, event) => n + Buffer.byteLength(event.body ?? ''), 0) <= config.limits.chunk_body_bytes
        && Buffer.byteLength(JSON.stringify(material(items, manifest).bundle) + '\n') <= config.limits.bundle_bytes;
    const flush = () => { if (group.length) { materials.push(material(group, manifest)); group = []; } };
    for (const event of eligible) {
        if (!fits([event])) {
            deferred++;
            requiredBytes = Math.max(requiredBytes, Buffer.byteLength(JSON.stringify(material([event], manifest).bundle) + '\n'));
            requiredBodyBytes = Math.max(requiredBodyBytes, Buffer.byteLength(event.body ?? ''));
            continue;
        }
        if (group.length && !fits([...group, event])) flush();
        if (materials.length >= config.limits.bundles_per_round) { deferred++; continue; }
        group.push(event);
    }
    flush();
    const counts = { pairs: manifest.pairs.length, eligible: eligible.length, already_reviewed: alreadyReviewed, partial_review: partialReview,
        prepared: materials.reduce((n, item) => n + item.bundle.chunks[0].events.length, 0), deferred, bundles: materials.length };
    return { preview: { schema_version: 1, plan_sha: digest(canonical({ manifest, evidence, limits: config.limits, counts })), counts,
        required_bundle_bytes: requiredBytes || null, required_chunk_body_bytes: requiredBodyBytes || null }, materials };
}

function readonlyPlan(config: BookkeepingConfig, manifest: NativeDuplicateManifest): Plan {
    const db = new DatabaseSync(join(config.data_dir, 'bookkeeping.sqlite'), { readOnly: true });
    try { db.exec('BEGIN'); return buildPlan(db, config, manifest); }
    finally { db.close(); }
}
export function previewNativeDuplicates(config: BookkeepingConfig, input: unknown): DuplicatePreview {
    return readonlyPlan(config, validateDuplicateManifest(input)).preview;
}

export async function prepareNativeDuplicates(config: BookkeepingConfig, input: unknown, expectedPlanSha: string, output: string): Promise<DuplicatePreview & { files: { bundle: string; result: string }[] }> {
    if (!/^[a-f0-9]{64}$/.test(expectedPlanSha)) throw new Error('Preparation requires the exact preview plan SHA256');
    const manifest = validateDuplicateManifest(input), plan = readonlyPlan(config, manifest);
    if (plan.preview.plan_sha !== expectedPlanSha) throw new Error('Duplicate plan changed; preview again');
    if (typeof output !== 'string' || !isAbsolute(output)) throw new Error('Private output must be absolute');
    validateDataLocation(await canonicalLocation(output), await canonicalLocation(config.wiki_root),
        await Promise.all(config.providers.flatMap(provider => provider.roots).map(canonicalLocation)));
    await mkdir(output, { recursive: true, mode: 0o700 });
    const status = await lstat(output);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Unsafe private output');
    await chmod(output, 0o700);
    const store = await createStore(config);
    const files: { bundle: string; result: string }[] = [];
    try {
        const fresh = buildPlan(store.db, config, manifest);
        if (fresh.preview.plan_sha !== expectedPlanSha) throw new Error('Duplicate plan changed before bundle save; preview again');
        for (const item of fresh.materials) {
            await store.saveBundle(item.bundle);
            const bundle = `bundle-${item.bundle.bundle_id.split(':')[1]}.json`, result = `result-${item.result.result_id.split(':')[1]}.json`;
            for (const [name, value] of [[bundle, item.bundle], [result, item.result]] as const) {
                const path = join(output, name), bytes = JSON.stringify(value) + '\n';
                try {
                    const handle = await open(path, 'wx', 0o600);
                    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
                    const existing = await lstat(path);
                    if (!existing.isFile() || existing.isSymbolicLink() || await readFile(path, 'utf8') !== bytes) throw new Error('Existing private material differs');
                    await chmod(path, 0o600);
                }
            }
            files.push({ bundle, result });
        }
        const directory = await open(output, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
        return { ...fresh.preview, files };
    } finally { store.close(); }
}
