#!/usr/bin/env node
/** Standalone, bounded, read-only inventory. No application modules or dependencies. */
import { open, opendir, lstat, realpath, writeFile, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute, extname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { strict as assert } from 'node:assert';

type Options = { root?: string; sessionRoots: string[]; sessionFirstLine: boolean; maxFiles: number; maxBytes: number; maxEntries: number };
type Counts = Record<string, number>;
type FileReport = {
  path: string; kind: string; size_bytes: number; mtime_utc: string;
  status: string; bytes_read: number; parsed_records: number; invalid_records: number;
  records_unread: null; record_count_is_lower_bound: boolean;
  field_shapes: Record<string, Counts>; time_convention_candidates: Counts;
  unknown_keys: number; shape_sampling: boolean; schema_family: string | null;
};
const scopes = ['.cache/daily_bookkeeping/state', 'wiki/personal/_evidence'];
const knownKeys = new Set(`$schema $id $defs $ref type properties required items oneOf anyOf allOf additionalProperties const enum format pattern minimum maximum minLength maxLength minItems maxItems uniqueItems if then else not schema_version id logical_id revision supersedes date original_stem title summary sections links sources promoted_to retention confidence created updated notes occurred_at occurred_timezone observation_type evidence_state contested capability_candidates direction_candidates context_ids source_timezone journal_timezone analysis_timezone source_ref source_hashes source_types time_windows extractor_version dedup_key mapping_status semantic_fact_hash verification verified_fact content_hash recorded_at weekly_id weekly_revision weekly_content_hash target_id target_type target_content_hash decision correction reason retracts_review_id retracts_content_hash attribution_effect decision_contract_effect capability_candidate_effect reviewed_on review_duration_minutes supported_pairs observation_id capability_id decision_contract candidate_capability label keywords subject_ids goal_bindings valid_from expires_on trigger_rules decision_kind impact source_hash fact_kind outcome_in verification_kinds decision_change decisions action_decision action_id replacement_summary week_started week_ended timezone packet_id packet_hash coverage coverage_status headline material_change calm_week confirmations validation_action prior_validation_action strong_alerts capability_updates direction_alignment patterns timestamp time role payload message content metadata session_id conversation_id parent_id cwd provider account conversation messages events status capture_status review_status index_status source enabled offset cursor checkpoint from to start end cutoff complete pending version last_run last_success next_run state live history read_offset byte_offset size mtime ranges gaps unresolved scope source_id owner sender self aliases ignored pinned roots path analysiszone travel_timeline journal_timeline queue tasks operation_id batch_id fact_id chunk_id event_id bundle_id target captured_at reviewed_at published_at processed_at updated_at created_at last_seen_at`.split(/\s+/));
const opaqueKeys = new Set('body content summary title notes reason correction label keywords headline text transcript contacts members accounts sender owner self aliases ignored pinned payload message'.split(' '));
const privatePath = /(?:^|[._-])(credentials?|secrets?|tokens?|passwords?|auth|keychain|contacts?|accounts?)(?:$|[._-])/i;
const families: Record<string, string> = {
  'daily-journal-jsonl-v1': 'daily-journal-jsonl-v1',
  'self-analytics-observation-v1': 'self-analytics-observation-v1',
  'self-analytics-review-event-v1': 'self-analytics-review-event-v1',
  'self-analytics-review-input-v1': 'self-analytics-review-input-v1',
  'self-analytics-weekly-record-v1': 'self-analytics-weekly-record-v1',
  'llm-wiki/personal/daily-journal-jsonl-v1': 'daily-journal-jsonl-v1',
};
const safeNames = new Set(`.cache daily_bookkeeping state wiki personal _evidence daily_journals self_analytics observations reviews weekly packets manifests coverage checkpoints cursors runs facts drafts pending receipts markers archive archives schema_daily_journal.json schema_observation.json schema_review.json schema_review_input.json schema_weekly.json config.json state.json cursor.json checkpoint.json observations.jsonl reviews.jsonl weekly.jsonl manifest.json index.json`.split(' '));
function increment(counts: Counts, key: string, n = 1) { counts[key] = (counts[key] ?? 0) + n; }
function safePath(path: string) {
  return path.split(/[\\/]/).map((part, i) => safeNames.has(part) || /^(?:daily_\d{4}|(?:observations|reviews|weekly)_\d{4}|\d{4}(?:-\d{2}){0,2})(?:\.jsonl?)?$/.test(part)
    ? part : `<redacted-${i}${extname(part) === '.jsonl' ? '.jsonl' : extname(part) === '.json' ? '.json' : ''}>`).join('/');
}
function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) return 'unsafe_integer';
  return typeof value;
}
function timeKind(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return 'numeric_unit_unknown';
  if (typeof value !== 'string') return 'non_string';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'calendar_date_zone_unknown';
  if (/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)) return 'utc_timestamp_candidate';
  if (/^\d{4}-\d{2}-\d{2}[T ].*[+-]\d{2}:?\d{2}$/.test(value)) return 'offset_timestamp_candidate';
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return 'timestamp_without_offset_candidate';
  if (/^[A-Za-z_+-]+\/[A-Za-z_+\/-]+$/.test(value)) {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return 'iana_timezone_candidate'; } catch { return 'unrecognized_timezone'; }
  }
  return 'unrecognized_string';
}
function observe(report: FileReport, value: unknown, prefix = '', depth = 0, firstLineOnly = false) {
  if (Object.keys(report.field_shapes).length >= 512) { report.shape_sampling = true; return; }
  const field = prefix || '$';
  increment(report.field_shapes[field] ??= {}, kind(value));
  if (depth >= (firstLineOnly ? 2 : 4)) { if (value && typeof value === 'object') report.shape_sampling = true; return; }
  if (Array.isArray(value)) {
    if (value.length > 20) report.shape_sampling = true;
    for (const item of value.slice(0, 20)) observe(report, item, `${field}[]`, depth + 1, firstLineOnly);
  } else if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const entries = Object.entries(object);
    if (entries.length > 128) report.shape_sampling = true;
    for (const [key, child] of entries.slice(0, 128)) {
      if (!knownKeys.has(key)) { report.unknown_keys++; continue; }
      const childPath = prefix ? `${prefix}.${key}` : key;
      // Session inventory deliberately contains no value-derived metadata, even schema family/time.
      if (!firstLineOnly && /(?:timezone|(?:^|_)(?:date|time|timestamp|at|from|to|cutoff|created|updated)$)/.test(key)) increment(report.time_convention_candidates, `${childPath}:${timeKind(child)}`);
      if (!firstLineOnly && key === 'schema_version' && typeof child === 'string' && families[child]) report.schema_family = families[child];
      if (!firstLineOnly && key === '$id' && typeof child === 'string' && families[child]) report.schema_family = families[child];
      if (opaqueKeys.has(key)) increment(report.field_shapes[childPath] ??= {}, kind(child));
      else observe(report, child, childPath, depth + 1, firstLineOnly);
    }
  }
}
function within(path: string, parent: string) { const rel = relative(parent, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); }

export async function inventory(options: Options) {
  const result = {
    schema_version: 'migration-inventory-v1', generated_at: new Date().toISOString(),
    privacy: 'metadata_only; unknown keys and path components redacted; no source values',
    source_coverage: { status: 'unknown', reason: 'Filesystem inventory does not establish source capture or review completeness; legacy complete flags are not evidence.' },
    limits: { max_files: options.maxFiles, max_bytes: options.maxBytes, max_directory_entries: options.maxEntries, max_depth: 12, per_file_bytes: 1024 * 1024, session_first_line_bytes: 64 * 1024 },
    counts: { directory_entries_seen: 0, eligible_files_seen: 0, inspected_files: 0, metadata_only_files: 0, bytes_read: 0, data_records_parsed_lower_bound: 0, schema_files_inspected: 0, invalid_records: 0, skipped_entries: {} as Counts },
    discovery_status: 'enumerated_allowed_scopes', undiscovered_entries: null as null,
    roots: [] as { kind: string; path: string; status: string }[], files: [] as FileReport[],
  };
  const targets: { path: string; mode: 'evidence' | 'state' | 'session'; display: string }[] = [];
  if (options.root) {
    for (const scope of scopes) targets.push({ path: join(options.root, scope), mode: scope.startsWith('.cache') ? 'state' : 'evidence', display: scope });
  }
  options.sessionRoots.forEach((path, i) => targets.push({ path, mode: 'session', display: `explicit-session-root-${i + 1}` }));
  let sequence = 0;
  async function inspect(path: string, display: string, mode: 'evidence' | 'state' | 'session') {
    const stat = await lstat(path);
    if (!stat.isFile()) { increment(result.counts.skipped_entries, 'not_regular_file'); return; }
    result.counts.eligible_files_seen++;
    if (result.files.length >= options.maxFiles) { increment(result.counts.skipped_entries, 'file_budget'); result.discovery_status = 'partial'; return; }
    const jsonl = extname(path).toLowerCase() === '.jsonl';
    const isSchema = /^schema_[a-z_]+\.json$/.test(basename(path));
    const report: FileReport = { path: `${display}#${++sequence}`, kind: mode === 'session' ? 'session_jsonl' : isSchema ? 'json_schema_candidate' : jsonl ? 'jsonl_data' : 'json_container', size_bytes: stat.size, mtime_utc: stat.mtime.toISOString(), status: 'unknown', bytes_read: 0, parsed_records: 0, invalid_records: 0, records_unread: null, record_count_is_lower_bound: true, field_shapes: {}, time_convention_candidates: {}, unknown_keys: 0, shape_sampling: false, schema_family: null };
    result.files.push(report);
    if (mode === 'session' && !options.sessionFirstLine) { report.status = 'metadata_only'; result.counts.metadata_only_files++; return; }
    const remaining = options.maxBytes - result.counts.bytes_read;
    const cap = Math.min(remaining, mode === 'session' ? 64 * 1024 : 1024 * 1024);
    if (cap <= 0 || (!jsonl && stat.size > cap)) { report.status = 'byte_budget_unread'; result.counts.metadata_only_files++; return; }
    let handle;
    try {
      // O_NOFOLLOW prevents a swapped final symlink from escaping the permitted tree.
      const { constants } = await import('node:fs');
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev) { report.status = 'changed_before_read'; return; }
      const buffer = Buffer.alloc(Math.min(cap, stat.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      report.bytes_read = bytesRead; result.counts.bytes_read += bytesRead; result.counts.inspected_files++;
      const eof = bytesRead === stat.size;
      const full = buffer.subarray(0, bytesRead);
      if (jsonl) {
        const newline = full.indexOf(10);
        const end = mode === 'session' ? (newline < 0 ? (eof ? bytesRead : 0) : newline) : (eof ? bytesRead : full.lastIndexOf(10) + 1);
        const rows = mode === 'session' ? [full.subarray(0, end).toString('utf8')] : full.subarray(0, end).toString('utf8').split('\n');
        for (const row of rows) {
          if (!row.trim()) continue;
          if (report.parsed_records + report.invalid_records >= 10000) { report.shape_sampling = true; break; }
          try { observe(report, JSON.parse(row), '', 0, mode === 'session'); report.parsed_records++; } catch { report.invalid_records++; }
        }
        report.status = mode === 'session' ? (report.parsed_records ? 'first_line_only' : 'first_line_unknown') : (eof && !report.shape_sampling && !report.invalid_records ? 'file_bytes_inspected' : 'partial');
        report.record_count_is_lower_bound = mode === 'session' || !eof || report.shape_sampling || !!report.invalid_records;
      } else {
        try {
          const value: unknown = JSON.parse(full.toString('utf8'));
          observe(report, value);
          report.parsed_records = isSchema ? 0 : Array.isArray(value) ? value.length : 1;
          report.status = isSchema ? 'schema_shape_inspected' : 'container_inspected';
          report.record_count_is_lower_bound = false;
        } catch { report.invalid_records++; report.status = 'invalid_json'; }
      }
      const after = await handle.stat();
      const current = await lstat(path).catch(() => null);
      if (!current || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || current.ino !== stat.ino || current.dev !== stat.dev) { report.status = 'changed_during_read'; report.record_count_is_lower_bound = true; }
      if (isSchema) result.counts.schema_files_inspected++;
      else if (mode !== 'session') result.counts.data_records_parsed_lower_bound += report.parsed_records;
      result.counts.invalid_records += report.invalid_records;
    } catch { report.status = 'read_unavailable'; } finally { await handle?.close(); }
  }
  async function walk(path: string, display: string, mode: 'evidence' | 'state' | 'session', boundary: string, depth = 0) {
    if (depth > 12) { increment(result.counts.skipped_entries, 'depth_budget'); result.discovery_status = 'partial'; return; }
    let dir;
    try {
      if (!within(await realpath(path), boundary)) { increment(result.counts.skipped_entries, 'escaped_boundary'); return; }
      dir = await opendir(path);
      for await (const entry of dir) {
        if (result.counts.directory_entries_seen >= options.maxEntries) { result.discovery_status = 'partial'; return; }
        result.counts.directory_entries_seen++;
        if (entry.isSymbolicLink()) { increment(result.counts.skipped_entries, 'symlink'); continue; }
        if (privatePath.test(entry.name) || entry.name === '.git' || entry.name === 'node_modules') { increment(result.counts.skipped_entries, 'excluded_private_or_code_path'); continue; }
        const child = join(path, entry.name), childDisplay = `${display}/${safePath(entry.name)}`;
        if (entry.isDirectory()) await walk(child, childDisplay, mode, boundary, depth + 1);
        else if (entry.isFile() && (extname(entry.name).toLowerCase() === '.json' || extname(entry.name).toLowerCase() === '.jsonl') && (mode !== 'session' || extname(entry.name).toLowerCase() === '.jsonl')) {
          if (within(await realpath(child), boundary)) await inspect(child, childDisplay, mode);
          else increment(result.counts.skipped_entries, 'escaped_boundary');
        } else increment(result.counts.skipped_entries, 'non_json_data');
      }
    } catch { increment(result.counts.skipped_entries, 'directory_unavailable'); result.discovery_status = 'partial'; }
  }
  for (const target of targets) {
    const root = { kind: target.mode, path: target.display, status: 'unknown' };
    result.roots.push(root);
    try {
      const stat = await lstat(target.path);
      if (stat.isSymbolicLink()) { root.status = 'symlink_not_followed'; continue; }
      if (!stat.isDirectory()) { root.status = 'not_directory'; continue; }
      const boundary = await realpath(target.path);
      await walk(target.path, target.display, target.mode, boundary);
      root.status = 'visited';
    } catch { root.status = 'unavailable_or_absent'; }
  }
  return result;
}

function parseArgs(args: string[]) {
  const options: Options = { sessionRoots: [], sessionFirstLine: false, maxFiles: 200, maxBytes: 16 * 1024 * 1024, maxEntries: 4000 };
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--session-first-line') { options.sessionFirstLine = true; continue; }
    const value = args[++i];
    if (!value) throw new Error('missing_argument');
    if (['--root', '--session-root', '--output'].includes(flag)) {
      if (!isAbsolute(value)) throw new Error('absolute_path_required');
      if (flag === '--root') options.root = resolve(value);
      if (flag === '--session-root') options.sessionRoots.push(resolve(value));
      if (flag === '--output') output = resolve(value);
    } else if (['--max-files', '--max-bytes', '--max-entries'].includes(flag)) {
      const n = Number(value); if (!Number.isSafeInteger(n) || n < 1 || n > (flag === '--max-bytes' ? 256 * 1024 * 1024 : 100000)) throw new Error('invalid_budget');
      if (flag === '--max-files') options.maxFiles = n;
      if (flag === '--max-bytes') options.maxBytes = n;
      if (flag === '--max-entries') options.maxEntries = n;
    } else throw new Error('unknown_argument');
  }
  if (!options.root && !options.sessionRoots.length) throw new Error('explicit_root_required');
  if (options.sessionFirstLine && !options.sessionRoots.length) throw new Error('session_root_required');
  if (output && [options.root, ...options.sessionRoots].some(root => root && within(output!, root))) throw new Error('output_must_be_outside_inputs');
  return { options, output };
}

async function selfTest() {
  const { test } = await import('node:test');
  await test('Synthetic-only privacy, scoped discovery, budgets and session header', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'bookkeeping-inventory-test-'));
    try {
      const evidence = join(fixture, 'wiki/personal/_evidence/daily_journals'), state = join(fixture, '.cache/daily_bookkeeping/state'), sessions = join(fixture, 'sessions');
      await mkdir(evidence, { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(sessions);
      const secret = 'PRIVATE_CHAT_PERSON_ACCOUNT_123';
      await writeFile(join(evidence, 'daily_2026.jsonl'), `${JSON.stringify({ schema_version: 'daily-journal-jsonl-v1', id: secret, date: '2026-09-30', sections: { [secret]: [secret] }, summary: secret, complete: true })}\n{bad}\n${JSON.stringify({ date: '2026-09-29' })}\n`);
      await writeFile(join(evidence, 'schema_daily_journal.json'), JSON.stringify({ $id: 'llm-wiki/personal/daily-journal-jsonl-v1', type: 'object', properties: { sections: { type: 'object' } } }));
      await writeFile(join(state, 'state.json'), JSON.stringify({ offset: 999999999999999999999, occurred_at: '2026-09-30T01:00:00+02:00', complete: true, [secret]: secret }));
      await writeFile(join(state, 'credentials.json'), JSON.stringify({ token: secret }));
      await writeFile(join(state, 'forbidden.ts'), `throw new Error('${secret}');`);
      await writeFile(join(fixture, 'outside.json'), JSON.stringify({ value: secret }));
      await symlink(join(fixture, 'outside.json'), join(state, 'symlink.json'));
      await writeFile(join(sessions, 'PRIVATE_PERSON_123.jsonl'), `${JSON.stringify({ type: secret, timestamp: '2026-09-30T01:00:00Z', payload: { id: secret, body: secret } })}\n${JSON.stringify({ summary: secret })}\n`);
      const options: Options = { root: fixture, sessionRoots: [sessions], sessionFirstLine: false, maxFiles: 20, maxBytes: 4096, maxEntries: 40 };
      const report = await inventory(options), encoded = JSON.stringify(report);
      assert(!encoded.includes(secret));
      assert(!encoded.includes('PRIVATE_PERSON_123'));
      assert.equal(report.source_coverage.status, 'unknown');
      assert.equal(report.counts.skipped_entries.symlink, 1);
      assert.equal(report.counts.skipped_entries.excluded_private_or_code_path, 1);
      assert.equal(report.counts.invalid_records, 1);
      assert.equal(report.counts.data_records_parsed_lower_bound, 3);
      assert.equal(report.files.find(file => file.kind === 'session_jsonl')?.bytes_read, 0);
      assert(!encoded.includes('outside.json'));
      const first = await inventory({ ...options, root: undefined, sessionFirstLine: true });
      assert.equal(first.files[0].parsed_records, 1);
      assert.deepEqual(first.files[0].time_convention_candidates, {});
      assert.equal(first.files[0].schema_family, null);
      assert(!JSON.stringify(first).includes(secret));
      const limited = await inventory({ ...options, maxFiles: 1, maxBytes: 1, maxEntries: 2 });
      assert(limited.counts.bytes_read <= 1); assert(limited.files.length <= 1);
      assert.equal(limited.discovery_status, 'partial');
      assert.equal(limited.undiscovered_entries, null);
      assert.throws(() => parseArgs(['--root', fixture, '--output', join(fixture, 'output.json')]));
      assert.throws(() => parseArgs(['--root', 'relative']));
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
}
if (import.meta.main) {
  if (process.version !== 'v25.8.0') { process.stderr.write('Node 25.8.0 required\n'); process.exitCode = 2; }
  else if (process.argv.slice(2).join(' ') === '--self-test') await selfTest();
  else if (process.argv.includes('--help')) process.stdout.write('node tools/inventory.ts --root ABS_WIKI [--session-root ABS_DIR] [--session-first-line] [--output ABS_NEW_FILE] [--max-files 200] [--max-bytes 16777216] [--max-entries 4000]\nDefault session mode lists metadata only. --self-test uses synthetic temporary data.\n');
  else {
    try {
      const { options, output } = parseArgs(process.argv.slice(2));
      const report = JSON.stringify(await inventory(options), null, 2) + '\n';
      if (output) await writeFile(output, report, { flag: 'wx', mode: 0o600 });
      process.stdout.write(report);
    } catch { process.stderr.write('Inventory unavailable or invalid arguments; no input values logged. Use --help.\n'); process.exitCode = 2; }
  }
}
