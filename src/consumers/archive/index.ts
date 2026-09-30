import { basename } from 'node:path';
import type { ArchiveRequest, BookkeepingConfig, Store, FactRef, FileOutcome, FileIntent, WorkItem } from '../../contracts/types.ts';
import { createSafeWikiWriter, acquireWikiLock, readWikiTarget, digestBytes } from '../../publish/index.ts';
import { canonicalDailyDate, retainedJournal, retainedWindowStart, frontmatterScalar } from '../../publish/journals.ts';
import { archiveFolder, sha, checkMonth, monthlyPath, effectiveMonthFacts, listMarkdown, readArchiveRecords, type ArchiveReadIssue } from './records.ts';
import type { WriterOptions } from '../../publish/files.ts';
export { readArchiveRecords } from './records.ts';

interface LinkPlan { path: string; digest: string; desired_base64: string; operation_id: string }
interface ArchiveSnapshot { month: string; date: string; path: string; source_digest: string; original_base64: string; archive_path: string; archive_base64: string; archive_operation: string; fact_refs: FactRef[] }
interface ArchivePlan extends ArchiveSnapshot { delete_operation: string; links: LinkPlan[] }
export interface ArchivePageOutcome { date: string; path: string; status: 'eligible' | 'retained' | 'applied' | 'noop' | 'pending' | 'conflict'; archive_path: string | null; reason: string | null }
export interface ArchiveResult { schema_version: 1; month: string; mode: 'report' | 'apply'; status: 'complete' | 'partial' | 'pending'; pages: ArchivePageOutcome[]; reason: string | null; issues?: ArchiveReadIssue[] }
export interface ArchiveOptions extends WriterOptions {
  /** Internal publisher recovery scope; backlink scans remain Wiki-wide. */
  resumePaths?: readonly string[];
  faultArchive?: (stage: 'snapshots_saved' | 'plan_saved' | 'archive_saved' | 'links_saved' | 'before_delete' | 'after_delete', path: string) => void | Promise<void>;
}
const success = (outcome: FileOutcome) => outcome.status === 'applied' || outcome.status === 'noop';
/** A baseline-specific retry remains owned by the original durable exact plan. */
export function archiveDeleteOperationMatches(plan: { path: string; delete_operation: string }, intent: FileIntent): boolean {
  return intent.path === plan.path && intent.desired_bytes_base64 === null && intent.desired_digest === 'absent' &&
    (intent.operation_id === plan.delete_operation || intent.operation_id === `${plan.delete_operation}:${sha(intent.baseline_digest)}`);
}
const dailyTargets = (path: string): Set<string> => {
  const stem = path.replace(/\.md$/, '');
  return new Set([basename(stem), stem, stem.replace(/^wiki\//, ''), stem.replace(/^wiki\/personal\//, ''), `${basename(stem)}.md`, path]);
};
function rewriteLinks(text: string, path: string, date: string, month: string): string {
  const targets = dailyTargets(path);
  return text.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (whole, target: string, alias: string | undefined) => {
    const original = target.split('#')[0];
    if (!targets.has(original)) return whole;
    return `[[回顾_${month.replaceAll('-', '_')}|${alias ?? target}]]`;
  });
}
function usableReview(bytes: Buffer | null, month: string): boolean {
  if (!bytes) return false;
  const text = bytes.toString('utf8').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<!-- bookkeeping:monthly-supplement:start[\s\S]*?<!-- bookkeeping:monthly-supplement:end -->/g, '')
    .replace(/^\s*#+[^\n]*$/gm, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  return Boolean(text) && !['draft', 'pending'].includes(frontmatterScalar(bytes, 'status') ?? '');
}
export function createArchiveService(store: Store, config: BookkeepingConfig, options: ArchiveOptions = {}) {
  const writer = createSafeWikiWriter(store, config, options);
  const now = () => options.now?.() ?? new Date();
  async function queuePlan(plan: ArchivePlan): Promise<WorkItem> {
    const item: WorkItem = { schema_version: 1, work_id: `archive-plan:${plan.month}:${sha(`${plan.path}:${plan.source_digest}`)}`, kind: 'archive_plan', lane: 'history', state: 'pending',
      payload: plan as unknown as Record<string, unknown>, reason: null, migration_key: null, updated_at: now().toISOString() };
    await store.enqueueWork(item); return item;
  }
  async function authorizedDigest(snapshot: Pick<ArchiveSnapshot, 'month' | 'path' | 'source_digest'>, plans: WorkItem[]): Promise<string> {
    const allowed = new Map(plans.filter(work => work.payload.month === snapshot.month).flatMap(work =>
      ((work.payload.links ?? []) as LinkPlan[]).filter(link => link.path === snapshot.path).map(link => [link.operation_id, link] as const)));
    let digest = snapshot.source_digest;
    for (const intent of await store.listFileIntents(['applied'])) {
      if (!allowed.has(intent.operation_id) || !intent.operation_id.startsWith('archive-link:') || intent.path !== snapshot.path || intent.baseline_digest !== digest) continue;
      const link = allowed.get(intent.operation_id)!;
      if (link.digest !== intent.baseline_digest || digestBytes(Buffer.from(link.desired_base64, 'base64')) !== intent.desired_digest) throw new Error('Archive backlink intent differs from saved exact plan');
      if (intent.backup_bytes_base64 === null || intent.desired_bytes_base64 === null ||
        digestBytes(Buffer.from(intent.backup_bytes_base64, 'base64')) !== digest ||
        digestBytes(Buffer.from(intent.desired_bytes_base64, 'base64')) !== intent.desired_digest) throw new Error('Corrupt authorized archive backlink intent');
      digest = intent.desired_digest;
    }
    return digest;
  }
  async function deletedByMonth(path: string, month: string): Promise<boolean> {
    for (const work of await store.listWork('archive_plan')) {
      if (work.payload.month !== month || work.payload.path !== path) continue;
      const plan = work.payload as unknown as ArchivePlan;
      const intent = await store.getFileIntent(plan.delete_operation);
      if (intent?.state !== 'applied' || intent.path !== path || intent.desired_digest !== 'absent' || intent.desired_bytes_base64 !== null) continue;
      const archive = await readWikiTarget(config.wiki_root, plan.archive_path);
      if (archive.digest === digestBytes(Buffer.from(plan.archive_base64, 'base64'))) return true;
    }
    return false;
  }
  async function report(request: ArchiveRequest): Promise<ArchiveResult> {
    checkMonth(request.month);
    const pages: ArchivePageOutcome[] = [];
    const issues = (await readArchiveRecords(config)).issues;
    const retainedMonth = request.month >= retainedWindowStart(config, now()).slice(0, 7);
    const review = await readWikiTarget(config.wiki_root, monthlyPath(request.month));
    for (const path of await listMarkdown(config.wiki_root)) {
      const target = await readWikiTarget(config.wiki_root, path), date = canonicalDailyDate(path, target.bytes);
      if (!date?.startsWith(request.month)) continue;
      const retained = retainedMonth || retainedJournal(target.bytes);
      const issue = issues.find(issue => issue.date === date);
      pages.push({ date, path, status: retained ? 'retained' : !issue && usableReview(review.bytes, request.month) ? 'eligible' : 'pending', archive_path: null,
        reason: retained ? 'Retained window or pinned/intentional daily' : issue?.reason ?? (usableReview(review.bytes, request.month) ? null : 'Usable monthly review is required before deletion') });
    }
    return { schema_version: 1, month: request.month, mode: request.mode, status: pages.some(page => page.status === 'pending') ? 'pending' : issues.length ? 'partial' : 'complete', pages, reason: null, issues };
  }
  async function run(request: ArchiveRequest): Promise<ArchiveResult> {
    checkMonth(request.month);
    if (request.mode !== 'report' && request.mode !== 'apply') throw new Error('Archive mode must be report or apply');
    if (request.mode === 'report') return report(request);
    if (request.month >= retainedWindowStart(config, now()).slice(0, 7)) return { schema_version: 1, month: request.month, mode: 'apply', status: 'pending', pages: [], reason: 'Current and preceding month are retained' };
    const facts = await effectiveMonthFacts(store, request.month);
    const issues = (await readArchiveRecords(config)).issues;
    for (const issue of issues) await store.enqueueWork({ schema_version: 1, work_id: `archive-record-issue:${sha(JSON.stringify(issue))}`, kind: 'archive_record', lane: 'history', state: 'pending',
      payload: { ...issue }, reason: issue.reason, migration_key: null, updated_at: now().toISOString() });
    const lock = await acquireWikiLock(config.wiki_root);
    if (!lock) return { schema_version: 1, month: request.month, mode: 'apply', status: 'pending', pages: [], reason: 'Wiki writer is active' };
    const pages: ArchivePageOutcome[] = [];
    try {
      const inScope = (path: string) => !options.resumePaths || options.resumePaths.includes(path);
      const pendingPlans = (await store.listWork('archive_plan', 'pending')).filter(work => work.payload.month === request.month && inScope(String(work.payload.path)));
      const byPath = new Map(pendingPlans.map(work => [String(work.payload.path), work]));
      // Include plans whose source was already deleted just before a crash.
      const paths = new Set([...await listMarkdown(config.wiki_root), ...byPath.keys()].filter(inScope));
      const snapshots = new Map<string, ArchiveSnapshot>();
      const snapshotWork = new Map<string, WorkItem>();
      const skipped = new Set<string>();
      const priorSnapshots = (await store.listWork('archive_snapshot', 'pending')).filter(work => work.payload.month === request.month && inScope(String(work.payload.path)));
      const allPlans = await store.listWork('archive_plan');
      for (const work of priorSnapshots) {
        const path = String(work.payload.path); paths.add(path);
        if (!byPath.has(path)) {
          const completed = allPlans.find(plan => plan.payload.month === request.month && plan.payload.path === path && plan.payload.source_digest === work.payload.source_digest);
          if (completed) byPath.set(path, completed);
        }
      }
      // Freeze every source BEFORE any backlink mutation. Otherwise archiving A
      // can rewrite B before B's complete original has been preserved.
      for (const path of [...paths].sort()) {
        try {
          const source = await readWikiTarget(config.wiki_root, path);
          const prior = byPath.get(path);
          const date = canonicalDailyDate(path, source.bytes) ?? (prior?.payload.date as string | undefined);
          if (!date?.startsWith(request.month) || retainedJournal(source.bytes)) continue;
          if (issues.some(issue => issue.date === date)) throw new Error('Malformed existing archive record for this date requires reconciliation');
          const review = await readWikiTarget(config.wiki_root, monthlyPath(request.month));
          if (!usableReview(review.bytes, request.month)) throw new Error('Usable monthly review is required before deletion');
          const saved = priorSnapshots.find(work => work.payload.path === path);
          let snapshot = saved?.payload as unknown as ArchiveSnapshot | undefined;
          if (!snapshot && prior) snapshot = prior.payload as unknown as ArchivePlan;
          if (snapshot && source.bytes !== null && source.digest !== await authorizedDigest(snapshot, allPlans)) throw new Error('Source differs from frozen original and authorized backlink changes; deletion deferred');
          if (!snapshot) {
            if (source.bytes === null) continue;
            const refs = facts.filter(fact => fact.journal_date.value === date).map(({ fact_id, revision }) => ({ schema_version: 1 as const, fact_id, revision }));
            const identity = sha(`${path}:${source.digest}`);
            const archiveRecord = { schema_version: 1, format: 'daily-journal-archive-v2', archive_id: `archive:${identity}`, date,
              original_stem: basename(path, '.md'), source_path: path, original_digest: source.digest, original_bytes_base64: source.bytes.toString('base64'),
              original_markdown: source.bytes.toString('utf8'), locator: `archive:${identity}:${date}`, fact_refs: refs, retention: 'archived', created_at: now().toISOString() };
            snapshot = { month: request.month, date, path, source_digest: source.digest, original_base64: source.bytes.toString('base64'),
              archive_path: `${archiveFolder}/v2/${request.month}/${identity}.json`, archive_base64: Buffer.from(JSON.stringify(archiveRecord) + '\n').toString('base64'),
              archive_operation: `archive-original:${identity}`, fact_refs: refs };
          }
          const work: WorkItem = saved ?? { schema_version: 1, work_id: `archive-snapshot:${snapshot.archive_operation}`, kind: 'archive_snapshot', lane: 'history', state: 'pending',
            payload: snapshot as unknown as Record<string, unknown>, reason: null, migration_key: null, updated_at: now().toISOString() };
          await store.enqueueWork(work);
          snapshots.set(path, snapshot); snapshotWork.set(path, work);
        } catch (error) {
          const source = await readWikiTarget(config.wiki_root, path), date = canonicalDailyDate(path, source.bytes) ?? (byPath.get(path)?.payload.date as string | undefined);
          if (!date?.startsWith(request.month)) throw error;
          skipped.add(path); pages.push({ date, path, status: 'pending', archive_path: null, reason: (error as Error).message });
        }
      }
      // Persist complete original version files for all frozen sources first.
      for (const [path, snapshot] of snapshots) {
        try {
          const output = await writer.writeLocked({ operation_id: snapshot.archive_operation, path: snapshot.archive_path, baseline_digest: 'absent',
            desired_bytes: Buffer.from(snapshot.archive_base64, 'base64'), fact_refs: snapshot.fact_refs }, lock);
          if (!success(output)) throw new Error(output.reason ?? 'Full original preservation is pending');
          const actual = await readWikiTarget(config.wiki_root, snapshot.archive_path);
          if (actual.digest !== digestBytes(Buffer.from(snapshot.archive_base64, 'base64'))) throw new Error('Saved full original differs from frozen snapshot');
        } catch (error) { skipped.add(path); pages.push({ date: snapshot.date, path, status: 'pending', archive_path: snapshot.archive_path, reason: (error as Error).message }); }
      }
      await options.faultArchive?.('snapshots_saved', request.month);
      for (const path of [...paths].sort()) {
        if (skipped.has(path)) continue;
        let date: string | null = null, archivePath: string | null = null;
        try {
          const source = await readWikiTarget(config.wiki_root, path);
          const prior = byPath.get(path);
          date = canonicalDailyDate(path, source.bytes) ?? (prior?.payload.date as string | undefined) ?? null;
          if (!date?.startsWith(request.month)) continue;
          if (retainedJournal(source.bytes)) { pages.push({ date, path, status: 'retained', archive_path: null, reason: 'Pinned/intentional daily remains' }); continue; }
          if (issues.some(issue => issue.date === date)) throw new Error('Malformed existing archive record for this date requires reconciliation');
          const review = await readWikiTarget(config.wiki_root, monthlyPath(request.month));
          if (!usableReview(review.bytes, request.month)) throw new Error('Usable monthly review is required before deletion');
          let work = prior;
          let plan: ArchivePlan;
          const snapshot = snapshots.get(path);
          if (!snapshot) continue;
          const expectedSource = await authorizedDigest(snapshot, await store.listWork('archive_plan'));
          if (source.bytes !== null && source.digest !== expectedSource) throw new Error('Source changed after initial snapshot; deletion deferred');
          if (work) plan = work.payload as unknown as ArchivePlan;
          else {
            if (source.bytes === null) continue;
            const identity = sha(`${path}:${snapshot.source_digest}`);
            const links: LinkPlan[] = [];
            for (const other of await listMarkdown(config.wiki_root)) {
              if (other === path) continue;
              const snapshot = await readWikiTarget(config.wiki_root, other);
              if (snapshot.bytes === null) continue;
              const text = snapshot.bytes.toString('utf8'), desired = rewriteLinks(text, path, date, request.month);
              if (desired !== text) {
                if (skipped.has(other)) throw new Error(`Backlink source has no preserved original: ${other}`);
                if (!Buffer.from(text).equals(snapshot.bytes)) throw new Error(`Backlink page is not lossless UTF-8: ${other}`);
                links.push({ path: other, digest: snapshot.digest, desired_base64: Buffer.from(desired).toString('base64'), operation_id: `archive-link:${identity}:${sha(`${other}:${snapshot.digest}`)}` });
              }
            }
            plan = { ...snapshot, delete_operation: `archive-delete:${identity}`, links };
            work = await queuePlan(plan);
            await options.faultArchive?.('plan_saved', path);
          }
          archivePath = plan.archive_path;
          const archived = await writer.writeLocked({ operation_id: plan.archive_operation, path: plan.archive_path, baseline_digest: 'absent', desired_bytes: Buffer.from(plan.archive_base64, 'base64'), fact_refs: plan.fact_refs }, lock);
          if (!success(archived)) { pages.push({ date, path, status: archived.status, archive_path: archivePath, reason: archived.reason }); continue; }
          // Canonical/date evidence is written only after actual saved archive output.
          const archiveWork: WorkItem = { schema_version: 1, work_id: `archive:${plan.archive_operation}`, kind: 'archive', lane: 'history', state: 'complete',
            payload: { date, archived_dates: [date], archive_path: plan.archive_path, source_path: path, source_digest: plan.source_digest, fact_refs: plan.fact_refs },
            reason: null, migration_key: null, updated_at: now().toISOString() };
          await store.enqueueWork(archiveWork);
          await store.enqueueWork({ schema_version: 1, work_id: `archive-context:${plan.archive_operation}`, kind: 'archive_context', lane: 'history', state: 'pending',
            payload: { month: plan.month, date, archive_path: plan.archive_path, locator: `archive:${sha(`${path}:${plan.source_digest}`)}:${date}`, fact_refs: plan.fact_refs },
            reason: 'Unstructured original remains bounded extraction context; mapped fact refs are not new assertions', migration_key: null, updated_at: now().toISOString() });
          await options.faultArchive?.('archive_saved', path);
          let blocked: FileOutcome | null = null;
          for (const link of plan.links) {
            if (options.resumePaths && !inScope(link.path)) {
              const peer = await readWikiTarget(config.wiki_root, link.path);
              const peerDate = canonicalDailyDate(link.path, peer.bytes);
              if (peer.bytes !== null && peerDate?.startsWith(request.month) && !retainedJournal(peer.bytes)) {
                const frozen = (await store.listWork('archive_snapshot')).find(work => work.payload.month === request.month && work.payload.path === link.path)?.payload as unknown as ArchiveSnapshot | undefined;
                if (!frozen || (await readWikiTarget(config.wiki_root, frozen.archive_path)).digest !== digestBytes(Buffer.from(frozen.archive_base64, 'base64')))
                  throw new Error(`Daily backlink source has no preserved original; run explicit month archive: ${link.path}`);
              }
            }
            const outcome = await writer.writeLocked({ operation_id: link.operation_id, path: link.path, baseline_digest: link.digest, desired_bytes: Buffer.from(link.desired_base64, 'base64'), fact_refs: plan.fact_refs }, lock);
            if (!success(outcome)) { blocked = outcome; break; }
          }
          if (blocked) { pages.push({ date, path, status: blocked.status, archive_path: archivePath, reason: `Backlink ${blocked.path}: ${blocked.reason}` }); continue; }
          await options.faultArchive?.('links_saved', path);
          // Re-enumerate after all backlink writes; even a successful old intent
          // does not prove that a human has not reintroduced a daily backlink.
          let remaining: string | null = null;
          for (const other of await listMarkdown(config.wiki_root)) {
            if (other === path) continue;
            const snapshot = await readWikiTarget(config.wiki_root, other), text = snapshot.bytes?.toString('utf8') ?? '';
            if (rewriteLinks(text, path, date, request.month) !== text) { remaining = other; break; }
          }
          if (remaining) throw new Error(`Unmigrated daily backlink remains: ${remaining}`);
          await options.faultArchive?.('before_delete', path);
          for (const link of plan.links) {
            const latest = await readWikiTarget(config.wiki_root, link.path);
            if (latest.bytes === null && await deletedByMonth(link.path, request.month)) continue;
            const expectedLinkDigest = await authorizedDigest({ month: request.month, path: link.path, source_digest: link.digest }, await store.listWork('archive_plan'));
            if (latest.digest !== expectedLinkDigest) throw new Error(`Migrated backlink page changed; deletion deferred: ${link.path}`);
          }
          for (const other of await listMarkdown(config.wiki_root)) {
            if (other === path) continue;
            const snapshot = await readWikiTarget(config.wiki_root, other), text = snapshot.bytes?.toString('utf8') ?? '';
            if (rewriteLinks(text, path, date, request.month) !== text) throw new Error(`Daily backlink appeared before deletion: ${other}`);
          }
          const current = await readWikiTarget(config.wiki_root, path);
          const deleteDigest = await authorizedDigest(snapshot, await store.listWork('archive_plan'));
          if (current.bytes !== null && (current.digest !== deleteDigest || retainedJournal(current.bytes))) throw new Error('Source changed after preservation; deletion deferred');
          const finalReview = await readWikiTarget(config.wiki_root, monthlyPath(request.month));
          const reviewLink = plan.links.find(link => link.path === monthlyPath(request.month));
          const expectedReviewDigest = await authorizedDigest({ month: request.month, path: monthlyPath(request.month),
            source_digest: reviewLink?.digest ?? review.digest }, await store.listWork('archive_plan'));
          if (finalReview.digest !== expectedReviewDigest || !usableReview(finalReview.bytes, request.month)) throw new Error('Monthly review changed or disappeared; deletion deferred');
          const archiveCheck = await readWikiTarget(config.wiki_root, plan.archive_path);
          if (archiveCheck.digest !== digestBytes(Buffer.from(plan.archive_base64, 'base64'))) throw new Error('Saved full archive changed or disappeared; deletion deferred');
          let deleteOperation = plan.delete_operation;
          const firstDelete = await store.getFileIntent(deleteOperation);
          if (current.bytes !== null && firstDelete && firstDelete.state !== 'applied' && firstDelete.baseline_digest !== deleteDigest) {
            if (!archiveDeleteOperationMatches(plan, firstDelete) || firstDelete.backup_bytes_base64 === null || digestBytes(Buffer.from(firstDelete.backup_bytes_base64, 'base64')) !== firstDelete.baseline_digest)
              throw new Error('Corrupt saved archive deletion intent');
            // All semantic dependencies and the source's complete authorized
            // chain were checked above. Preserve the immutable old intent and
            // save a stable retry for ONLY this proved new baseline.
            deleteOperation = `${plan.delete_operation}:${sha(deleteDigest)}`;
          }
          const deleted = await writer.writeLocked({ operation_id: deleteOperation, path, baseline_digest: deleteDigest, desired_bytes: null, fact_refs: plan.fact_refs, archive_delete_verified: true }, lock);
          if (!success(deleted)) { pages.push({ date, path, status: deleted.status, archive_path: archivePath, reason: deleted.reason }); continue; }
          // Once absence is real, every previous baseline-specific attempt can
          // repair its registration. Nothing here authorizes another unlink.
          for (const intent of await store.listFileIntents()) if (archiveDeleteOperationMatches(plan, intent)) await writer.recoverLocked(intent, lock);
          await options.faultArchive?.('after_delete', path);
          await store.completeWork(work!.work_id);
          await store.completeWork(snapshotWork.get(path)!.work_id);
          pages.push({ date, path, status: deleted.status, archive_path: archivePath, reason: null });
        } catch (error) { if (date) pages.push({ date, path, status: 'pending', archive_path: archivePath, reason: (error as Error).message }); else throw error; }
      }
      const pending = pages.filter(page => page.status === 'pending' || page.status === 'conflict');
      return { schema_version: 1, month: request.month, mode: 'apply', status: pending.length ? pages.some(page => page.status === 'applied' || page.status === 'noop') ? 'partial' : 'pending' : issues.length ? 'partial' : 'complete', pages, reason: null, issues };
    } finally { await lock.release(); }
  }
  return { run, report: (month: string) => report({ month, mode: 'report' }) };
}
