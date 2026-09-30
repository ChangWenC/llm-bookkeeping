import type { DatabaseSync } from 'node:sqlite';
import type { AnalyticsCatalog, AnalyticsDefinition, AnalyticsReviewEvent, AnalyticsReviewInput, AnalysisRevisionRef, BookkeepingConfig, FactArtifact, FactRef, GoalContract, MajorDecisionContract, ProfessionalFact, ReviewReceipt, SourceCoverage, WeeklyAnalysisResult, WeeklyAnalysisSnapshot, WeeklyObservation } from '../contracts/types.ts';
import { activityReview, attributionOverlays, validatePairTargets, capabilityMatches } from '../analytics/reviews.ts';
import { goalActiveAt, decisionActiveAt } from '../analytics/contracts.ts';
import { analyticsPilotStats, type PilotActionEvent } from '../analytics/pilot.ts';
import { canonical } from '../analytics/serialization.ts';
import { analysisKey, factKey, cropProjection, observationFor, contentHash } from '../analytics/model.ts';
interface StoredProfessionalFact {
    fact_ref: FactRef;
    kind: ProfessionalFact['kind'];
    occurred_at: ProfessionalFact['occurred_at'];
    projection: ProfessionalFact['projection'] | null;
    action: 'assert' | 'replace' | 'retract';
    target_refs: FactRef[];
    aggregate: boolean;
    reason: string | null;
}
export interface AnalyticsNotice {
    schema_version: 1;
    notice_id: string;
    decision_ref: AnalysisRevisionRef;
    fact_ref: FactRef;
    subject: string;
    verified_at: string;
}
export interface AnalyticsOutput {
    schema_version: 1;
    batch_id: string;
    facts: ProfessionalFact[];
    observations: WeeklyObservation[];
    coverage: SourceCoverage[];
    snapshots: WeeklyAnalysisSnapshot[];
    notices: AnalyticsNotice[];
    freshness: {
        analysis_ref: AnalysisRevisionRef;
        freshness_at: string;
    }[];
    overlays: Record<string, unknown>[];
    analytics_catalog: AnalyticsCatalog;
    exclusions: {
        fact_ref: FactRef;
        reason: string;
    }[];
}
const json = <T>(row: any): T => JSON.parse(row.json);
/** SQLite tables and all their write paths remain owned by the Store module. */
export class AnalyticsRepository {
    private readonly db: DatabaseSync;
    constructor(db: DatabaseSync) {
        this.db = db;
        db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_batches(id TEXT PRIMARY KEY,content_hash TEXT NOT NULL,output_json TEXT);
      CREATE TABLE IF NOT EXISTS analytics_facts(id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS analytics_coverage(id TEXT PRIMARY KEY,json TEXT NOT NULL,cutoff TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_targets(id TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,json TEXT NOT NULL,content_hash TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS analytics_reviews(id TEXT PRIMARY KEY,json TEXT NOT NULL,status TEXT NOT NULL,reason TEXT);
      CREATE TABLE IF NOT EXISTS analytics_review_definitions(review_id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_snapshots(id TEXT NOT NULL,revision INTEGER NOT NULL,week_end TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS analytics_freshness(batch_id TEXT PRIMARY KEY,analysis_id TEXT NOT NULL,revision INTEGER NOT NULL,at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_notices(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_legacy(migration_key TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_reservations(id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS analytics_definition_baselines(id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS analytics_action_events(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_state(key TEXT PRIMARY KEY,json TEXT NOT NULL);
    `);
    }
    transaction<T>(operation: () => T): T {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = operation();
            this.db.exec('COMMIT');
            return value;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    private saveTarget(ref: AnalysisRevisionRef, kind: string, value: unknown): void {
        const hash = contentHash(value);
        const old = this.db.prepare('SELECT content_hash FROM analytics_targets WHERE id=? AND revision=?').get(ref.logical_id, ref.revision) as any;
        if (old) {
            if (old.content_hash !== hash)
                throw new Error('Analytics target identity conflict');
            return;
        }
        const latest = this.latestRevision(ref.logical_id);
        if (latest && this.target({ ...ref, revision: latest })?.kind !== kind)
            throw new Error('Analytics target kind must remain stable');
        if (latest && ref.revision <= latest)
            throw new Error('Analytics target revision must increase');
        this.db.prepare('INSERT INTO analytics_targets VALUES(?,?,?,?,?)').run(ref.logical_id, ref.revision, kind, canonical(value), hash);
    }
    latestRevision(id: string): number { return (this.db.prepare('SELECT MAX(revision) AS revision FROM analytics_targets WHERE id=?').get(id) as any).revision ?? 0; }
    target(ref: AnalysisRevisionRef): {
        kind: string;
        value: any;
    } | null {
        const row = this.db.prepare('SELECT kind,json FROM analytics_targets WHERE id=? AND revision=?').get(ref.logical_id, ref.revision) as any;
        return row ? { kind: row.kind, value: json(row) } : null;
    }
    reviews(): AnalyticsReviewEvent[] { return this.db.prepare("SELECT json FROM analytics_reviews WHERE status='applied' ORDER BY rowid").all().map(json<AnalyticsReviewEvent>); }
    reviewState(ref: AnalysisRevisionRef): AnalyticsReviewEvent | null {
        return activityReview(this.reviews(), ref);
    }
    confirmed(ref: AnalysisRevisionRef): boolean { return this.latestRevision(ref.logical_id) === ref.revision && this.reviewState(ref)?.action === 'confirm'; }
    private effectiveRecords(): StoredProfessionalFact[] {
        const rows = this.db.prepare('SELECT json FROM analytics_facts ORDER BY rowid').all().map(json<StoredProfessionalFact>);
        const max = new Map<string, number>();
        const retired = new Map<string, number>();
        for (const fact of rows) {
            max.set(fact.fact_ref.fact_id, Math.max(max.get(fact.fact_ref.fact_id) ?? 0, fact.fact_ref.revision));
            if (fact.action !== 'assert')
                for (const target of fact.target_refs)
                    retired.set(target.fact_id, Math.max(retired.get(target.fact_id) ?? 0, target.revision));
        }
        return rows.filter(fact => fact.action !== 'retract' && fact.fact_ref.revision === max.get(fact.fact_ref.fact_id) && fact.fact_ref.revision > (retired.get(fact.fact_ref.fact_id) ?? 0));
    }
    facts(): ProfessionalFact[] { return this.effectiveRecords().filter(fact => fact.projection && fact.aggregate).map(fact => ({ schema_version: 1, fact_ref: fact.fact_ref, projection: fact.projection!, kind: fact.kind, occurred_at: fact.occurred_at })); }
    lookupFacts(refs: FactRef[]): ProfessionalFact[] {
        return refs.flatMap(ref => {
            const row = this.db.prepare('SELECT json FROM analytics_facts WHERE id=? AND revision=?').get(ref.fact_id, ref.revision);
            if (!row)
                return [];
            const fact = json<StoredProfessionalFact>(row);
            return fact.projection && fact.aggregate ? [{ schema_version: 1 as const, fact_ref: fact.fact_ref, kind: fact.kind, occurred_at: fact.occurred_at, projection: fact.projection }] : [];
        });
    }
    exclusions(): {
        fact_ref: FactRef;
        reason: string;
        occurred_at: ProfessionalFact['occurred_at'];
    }[] { return this.effectiveRecords().filter(fact => fact.reason !== null).map(fact => ({ fact_ref: fact.fact_ref, reason: fact.reason!, occurred_at: fact.occurred_at })); }
    coverage(): SourceCoverage[] { return this.db.prepare('SELECT json FROM analytics_coverage ORDER BY id').all().map(json<SourceCoverage>); }
    observations(): WeeklyObservation[] {
        const live = new Set(this.facts().map(fact => factKey(fact.fact_ref)));
        return this.db.prepare("SELECT json FROM analytics_targets t WHERE kind='observation' AND revision=(SELECT MAX(revision) FROM analytics_targets n WHERE n.id=t.id) ORDER BY id").all().map(json<WeeklyObservation>).filter(observation => observation.evidence_refs.every(ref => live.has(factKey(ref))));
    }
    rawSnapshot(week: string): WeeklyAnalysisSnapshot | null { const row = this.db.prepare('SELECT json FROM analytics_snapshots WHERE week_end=? ORDER BY revision DESC LIMIT 1').get(week); return row ? json(row) : null; }
    snapshots(asOf = new Date().toISOString()): WeeklyAnalysisSnapshot[] {
        const activeGoal = (ref: AnalysisRevisionRef) => { const goal = this.target(ref)?.value as GoalContract | undefined; return !!goal && goalActiveAt(goal, asOf, this.confirmed(ref)); };
        const current = new Set(this.facts().map(fact => factKey(fact.fact_ref)));
        return this.db.prepare('SELECT json FROM analytics_snapshots s WHERE revision=(SELECT MAX(revision) FROM analytics_snapshots n WHERE n.id=s.id) ORDER BY week_end,revision').all().map(json<WeeklyAnalysisSnapshot>).map(snapshot => {
            const observations = snapshot.observations.filter(observation => { const review = this.reviewState(observation.observation_ref); return observation.evidence_refs.every(ref => current.has(factKey(ref))) && review?.action !== 'reject' && review?.action !== 'retract'; }).map(observation => { const review = this.reviewState(observation.observation_ref); return { ...observation, summary: review?.action === 'correct' ? review.correction! : observation.summary, stage: review?.action === 'confirm' ? 'formal' as const : 'candidate' as const }; });
            const changed = observations.length !== snapshot.observations.length || snapshot.capabilities.some(capability => capability.evidence_refs.some(ref => !current.has(factKey(ref)))) || snapshot.goal_gaps.some(gap => !activeGoal(gap.goal_ref) || gap.evidence_refs.some(ref => !current.has(factKey(ref))));
            const action = snapshot.validation_action;
            return { ...snapshot, observations, goal_gaps: snapshot.goal_gaps.filter(gap => activeGoal(gap.goal_ref) && gap.evidence_refs.every(ref => current.has(factKey(ref)))), ...(changed ? { coverage_status: 'partial' as const, direction: 'unknown' as const, capabilities: snapshot.capabilities.map(capability => capability.evidence_refs.every(ref => current.has(factKey(ref))) ? capability : { ...capability, trend: 'unknown' as const, explanation: 'Evidence revision replaced/retracted; semantic recomputation pending', evidence_refs: [] }) } : {}), validation_action: action };
        });
    }
    unresolvedHistory(): boolean { return this.readHistory().some((record: any) => record.result.unresolved > 0); }
    confirmedGoals(config: BookkeepingConfig, asOf = new Date().toISOString()): GoalContract[] {
        return this.db.prepare("SELECT json FROM analytics_targets WHERE kind='goal_contract' ORDER BY rowid").all().map(json<GoalContract>).filter(goal => config.goal_whitelist.includes(goal.contract_ref.logical_id) && goalActiveAt(goal, asOf, this.confirmed(goal.contract_ref)));
    }
    configureCatalog(config: BookkeepingConfig): void { this.transaction(() => this.syncCatalog(config)); }
    private syncCatalog(config: BookkeepingConfig): void {
        for (const [kind, definitions] of [['capability_definition', config.analytics_catalog?.capabilities ?? []], ['direction_definition', config.analytics_catalog?.directions ?? []]] as const) {
            for (const definition of definitions) {
                this.saveTarget(definition.definition_ref, kind, definition);
                if (definition.status === 'formal')
                    this.db.prepare('INSERT OR IGNORE INTO analytics_definition_baselines VALUES(?,?)').run(definition.definition_ref.logical_id, definition.definition_ref.revision);
            }
        }
    }
    catalog(config?: BookkeepingConfig): AnalyticsCatalog {
        const definitions = (kind: string): AnalyticsDefinition[] => this.db.prepare('SELECT json FROM analytics_targets t WHERE kind=? AND revision=(SELECT MAX(revision) FROM analytics_targets n WHERE n.id=t.id) ORDER BY id').all(kind).map(json<AnalyticsDefinition>).map(definition => {
            const baseline = this.db.prepare('SELECT 1 FROM analytics_definition_baselines WHERE id=? AND revision=?').get(definition.definition_ref.logical_id, definition.definition_ref.revision);
            const review = this.reviewState(definition.definition_ref);
            return { ...definition, status: review?.action === 'confirm' || (baseline && !review) ? 'formal' as const : 'candidate' as const };
        });
        return { schema_version: 1, capabilities: definitions('capability_definition'), directions: definitions('direction_definition'), project_mappings: config?.analytics_catalog?.project_mappings ?? [] };
    }
    overlays(): Record<string, unknown>[] {
        const definitions = Object.fromEntries(this.db.prepare('SELECT review_id,json FROM analytics_review_definitions').all().map((row: any) => [row.review_id, JSON.parse(row.json)]));
        return attributionOverlays(this.observations(), this.catalog(), this.reviews(), definitions);
    }
    /** Caller has validated the semantic result; this participates in Store's existing transaction. */
    saveAnalysis(result: WeeklyAnalysisResult, batchId: string): void {
        const snapshot = result.snapshot;
        const event = (suffix: string, action_ref: AnalysisRevisionRef, disposition: PilotActionEvent['disposition']) => {
            const value: PilotActionEvent = { event_id: batchId + ':' + suffix, at: result.freshness_at, action_ref, disposition };
            this.db.prepare('INSERT OR IGNORE INTO analytics_action_events VALUES(?,?)').run(value.event_id, canonical(value));
        };
        if (result.prior_action_disposition && !(result.prior_action_disposition.disposition === 'abandon' && snapshot.validation_action?.state === 'abandoned' && snapshot.validation_action.action_ref.logical_id === result.prior_action_disposition.action_ref.logical_id))
            event('prior', result.prior_action_disposition.action_ref, result.prior_action_disposition.disposition);
        if (snapshot.validation_action)
            event('current', snapshot.validation_action.action_ref, snapshot.validation_action.state === 'active' ? 'active' : snapshot.validation_action.state === 'abandoned' ? 'abandon' : 'completed');
        for (const observation of snapshot.observations)
            this.saveTarget(observation.observation_ref, 'observation', { ...observation, stage: 'candidate' });
        if (snapshot.validation_action)
            this.saveTarget(snapshot.validation_action.action_ref, 'action', snapshot.validation_action);
        this.saveTarget(snapshot.analysis_ref, 'snapshot', snapshot);
        const old = this.db.prepare('SELECT json FROM analytics_snapshots WHERE id=? AND revision=?').get(snapshot.analysis_ref.logical_id, snapshot.analysis_ref.revision) as any;
        if (old && old.json !== canonical(snapshot))
            throw new Error('Weekly snapshot identity conflict');
        this.db.prepare('INSERT OR IGNORE INTO analytics_snapshots VALUES(?,?,?,?)').run(snapshot.analysis_ref.logical_id, snapshot.analysis_ref.revision, snapshot.week_end, canonical(snapshot));
        this.db.prepare('INSERT OR IGNORE INTO analytics_freshness VALUES(?,?,?,?)').run(batchId, snapshot.analysis_ref.logical_id, snapshot.analysis_ref.revision, result.freshness_at);
    }
    reserveAnalysis(result: WeeklyAnalysisResult): void {
        const snapshot = result.snapshot;
        const targets = [{ ref: snapshot.analysis_ref, value: snapshot }, ...snapshot.observations.map(observation => ({ ref: observation.observation_ref, value: { ...observation, stage: 'candidate' } })), ...(snapshot.validation_action ? [{ ref: snapshot.validation_action.action_ref, value: snapshot.validation_action }] : [])];
        for (const { ref, value } of targets) {
            const previous = this.target(ref);
            if (previous && canonical(previous.value) !== canonical(value))
                throw new Error('Analytics target identity conflict');
            const old = this.db.prepare('SELECT json FROM analytics_reservations WHERE id=? AND revision=?').get(ref.logical_id, ref.revision) as any;
            if (old && old.json !== canonical(value))
                throw new Error('Reserved analytics revision identity conflict');
            this.db.prepare('INSERT OR IGNORE INTO analytics_reservations VALUES(?,?,?)').run(ref.logical_id, ref.revision, canonical(value));
        }
    }
    freshness(): {
        analysis_ref: AnalysisRevisionRef;
        freshness_at: string;
    }[] { return this.db.prepare('SELECT analysis_id,revision,MAX(at) AS at FROM analytics_freshness GROUP BY analysis_id,revision ORDER BY at').all().map((row: any) => ({ analysis_ref: { schema_version: 1, logical_id: row.analysis_id, revision: row.revision }, freshness_at: row.at })); }
    ingest(batch: FactArtifact, config: BookkeepingConfig, asOf = new Date().toISOString()): AnalyticsOutput {
        return this.transaction(() => {
            this.syncCatalog(config);
            // Hash only professional transport fields. Original fact bodies never enter the Analytics ledger or output.
            const records: StoredProfessionalFact[] = batch.facts.map(fact => {
                const projection = fact.analytics_projection.value ? cropProjection(fact.analytics_projection.value, config) : null;
                const aggregate = fact.kind !== 'legacy_record' && !(fact.attribution.legacy_mapping_unresolved === true);
                return { fact_ref: { schema_version: 1, fact_id: fact.fact_id, revision: fact.revision }, kind: fact.kind, occurred_at: fact.occurred_at,
                    projection, action: fact.action, target_refs: fact.target_refs, aggregate,
                    reason: !projection ? fact.analytics_projection.value === null ? 'Professional projection unavailable' : 'Outside professional whitelist' : !aggregate ? 'Unverified/unmapped legacy evidence excluded' : null };
            });
            const hash = contentHash({ records, coverage: batch.coverage, analysis: batch.analysis ?? null });
            const previous = this.db.prepare('SELECT * FROM analytics_batches WHERE id=?').get(batch.batch_id) as any;
            if (previous) {
                if (previous.content_hash !== hash)
                    throw new Error('Analytics batch identity conflict');
                return JSON.parse(previous.output_json);
            }
            for (const fact of records) {
                const previousFact = this.db.prepare('SELECT json FROM analytics_facts WHERE id=? AND revision=?').get(fact.fact_ref.fact_id, fact.fact_ref.revision) as any;
                if (previousFact && previousFact.json !== canonical(fact))
                    throw new Error('Professional fact revision identity conflict');
                this.db.prepare('INSERT OR IGNORE INTO analytics_facts VALUES(?,?,?)').run(fact.fact_ref.fact_id, fact.fact_ref.revision, canonical(fact));
            }
            for (const coverage of batch.coverage) {
                const old = this.db.prepare('SELECT cutoff FROM analytics_coverage WHERE id=?').get(coverage.coverage_id) as any;
                if (!old || Date.parse(old.cutoff) <= Date.parse(coverage.cutoff))
                    this.db.prepare('INSERT INTO analytics_coverage VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,cutoff=excluded.cutoff').run(coverage.coverage_id, canonical(coverage), coverage.cutoff);
            }
            for (const fact of this.facts()) {
                const observation = observationFor(fact);
                const latest = this.latestRevision(observation.observation_ref.logical_id);
                const previous = latest ? this.target({ ...observation.observation_ref, revision: latest })?.value as WeeklyObservation : undefined;
                if (previous?.evidence_refs.some(ref => factKey(ref) === factKey(fact.fact_ref)))
                    continue;
                observation.observation_ref.revision = latest + 1;
                this.saveTarget(observation.observation_ref, 'observation', observation);
            }
            if (batch.analysis)
                this.saveAnalysis(batch.analysis, batch.batch_id);
            this.evaluateDecisions(config, asOf);
            const output: AnalyticsOutput = { schema_version: 1, batch_id: batch.batch_id, facts: this.facts(), observations: this.observations(), coverage: this.coverage(), snapshots: this.snapshots(asOf), notices: this.notices(asOf), freshness: this.freshness(), overlays: this.overlays(), analytics_catalog: this.catalog(config), exclusions: records.filter(fact => fact.reason && fact.action !== 'retract').map(fact => ({ fact_ref: fact.fact_ref, reason: fact.reason! })) };
            this.db.prepare('INSERT INTO analytics_batches VALUES(?,?,?)').run(batch.batch_id, hash, canonical(output));
            return output;
        });
    }
    applyReview(input: AnalyticsReviewInput, config: BookkeepingConfig, withinTransaction = false, asOf = new Date().toISOString()): ReviewReceipt[] {
        const operation = (): ReviewReceipt[] => {
            this.syncCatalog(config);
            if (input.kind === 'capability_candidate') {
                if (input.definition.status !== 'candidate')
                    throw new Error('New capability definition must be candidate');
                this.saveTarget(input.definition.definition_ref, 'capability_definition', input.definition);
                return [{ schema_version: 1, review_id: 'registration:' + analysisKey(input.definition.definition_ref), target_ref: input.definition.definition_ref, status: 'pending', reason: 'Candidate capability requires exact user confirmation' }];
            }
            if (input.kind !== 'review') {
                const contract = input.contract;
                if (contract.confirmed)
                    throw new Error('New contracts require explicit revision confirmation');
                this.saveTarget(contract.contract_ref, input.kind, contract);
                return [{ schema_version: 1, review_id: 'registration:' + analysisKey(contract.contract_ref), target_ref: contract.contract_ref, status: 'pending', reason: 'Candidate contract requires explicit user confirmation' }];
            }
            const receipts: ReviewReceipt[] = [];
            const currentFacts = new Set(this.facts().map(fact => factKey(fact.fact_ref)));
            for (const event of input.events) {
                const previous = this.db.prepare('SELECT * FROM analytics_reviews WHERE id=?').get(event.review_id) as any;
                if (previous) {
                    if (previous.json !== canonical(event))
                        throw new Error('Review event identity conflict');
                    receipts.push({ schema_version: 1, review_id: event.review_id, target_ref: event.target_ref, status: previous.status === 'applied' ? 'already_applied' : previous.status, reason: previous.reason });
                    continue;
                }
                const target = this.target(event.target_ref);
                let status: ReviewReceipt['status'] = 'applied';
                let reason: string | null = null;
                if (!target) {
                    status = 'pending';
                    reason = 'Target revision not available';
                }
                else if (event.action === 'retract') {
                    const original = this.db.prepare("SELECT json,status FROM analytics_reviews WHERE id=?").get(event.retracts_review_id ?? '') as any;
                    if (!original || original.status !== 'applied' || analysisKey(JSON.parse(original.json).target_ref) !== analysisKey(event.target_ref)) {
                        status = 'pending';
                        reason = 'Retraction must bind one applied review on the exact same target';
                    }
                }
                else if (this.latestRevision(event.target_ref.logical_id) !== event.target_ref.revision) {
                    status = 'stale';
                    reason = 'Review binds an older revision';
                }
                else if (event.evidence_refs.some(ref => !currentFacts.has(factKey(ref)))) {
                    status = 'stale';
                    reason = 'Evidence revision is no longer effective';
                }
                else if (target.kind === 'observation' && !(target.value as WeeklyObservation).evidence_refs.every(ref => currentFacts.has(factKey(ref)))) {
                    status = 'stale';
                    reason = 'Observation evidence was replaced or retracted';
                }
                else if (target.kind === 'goal_contract' && !config.goal_whitelist.includes(event.target_ref.logical_id)) {
                    status = 'pending';
                    reason = 'Goal is outside explicit whitelist';
                }
                else if (target.kind === 'decision_contract') {
                    const decision = target.value as MajorDecisionContract;
                    const goal = this.target(decision.goal_ref)?.value as GoalContract | undefined;
                    if (!goal || !this.confirmed(decision.goal_ref) || goal.subject !== decision.subject) {
                        status = 'pending';
                        reason = 'Decision requires an exact confirmed subject/goal contract';
                    }
                }
                if (status === 'applied' && event.action !== 'retract' && (event.selected_pairs?.length || (event.action === 'correct' && event.selected_pairs !== undefined))) {
                    try {
                        validatePairTargets(event, target?.kind === 'observation' ? target.value : null, this.catalog(config).capabilities);
                        const definitions = this.catalog(config).capabilities.filter(definition => (target!.value as WeeklyObservation).capability_ids.some(id => capabilityMatches(definition, id))).map(definition => definition.definition_ref);
                        this.db.prepare('INSERT INTO analytics_review_definitions VALUES(?,?)').run(event.review_id, canonical(definitions));
                    }
                    catch (error) {
                        status = 'pending';
                        reason = String(error);
                    }
                }
                this.db.prepare('INSERT INTO analytics_reviews VALUES(?,?,?,?)').run(event.review_id, canonical(event), status, reason);
                receipts.push({ schema_version: 1, review_id: event.review_id, target_ref: event.target_ref, status, reason });
            }
            this.evaluateDecisions(config, asOf);
            return receipts;
        };
        return withinTransaction ? operation() : this.transaction(operation);
    }
    private evaluateDecisions(config: BookkeepingConfig, asOf: string): void {
        const goals = this.confirmedGoals(config, asOf);
        const decisions = this.db.prepare("SELECT json FROM analytics_targets WHERE kind='decision_contract' ORDER BY rowid").all().map(json<MajorDecisionContract>).filter(decision => this.confirmed(decision.contract_ref));
        for (const decision of decisions) {
            const goal = goals.find(goal => analysisKey(goal.contract_ref) === analysisKey(decision.goal_ref));
            if (!goal || !decisionActiveAt(decision, goal, asOf, { decision_confirmed: this.confirmed(decision.contract_ref), goal_confirmed: this.confirmed(goal.contract_ref) }))
                continue;
            for (const fact of this.facts()) {
                const verification = fact.projection.verification;
                if (fact.kind !== 'fact' || !verification || verification.basis !== 'user_explicit_verification')
                    continue;
                if (fact.projection.subject !== decision.subject || verification.subject !== decision.subject || verification.name !== decision.trigger.name || verification.value !== decision.trigger.expected_value)
                    continue;
                const time = Date.parse(verification.verified_at);
                if (time > Date.parse(asOf))
                    continue;
                if (time < Date.parse(decision.valid_from) || time >= Date.parse(decision.valid_to) || (goal.deadline && time > Date.parse(goal.deadline)))
                    continue;
                if (fact.projection.attribution.goal_target_version !== goal.target_version)
                    continue;
                if (!verification.event_refs.length || verification.event_refs.some(ref => !fact.projection.event_refs.some(source => source.event_id === ref.event_id)))
                    continue;
                const notice: AnalyticsNotice = { schema_version: 1, notice_id: 'decision:' + contentHash([decision.contract_ref, fact.fact_ref]), decision_ref: decision.contract_ref, fact_ref: fact.fact_ref, subject: decision.subject, verified_at: verification.verified_at };
                this.db.prepare('INSERT OR IGNORE INTO analytics_notices VALUES(?,?)').run(notice.notice_id, canonical(notice));
            }
        }
    }
    noticeHistory(): AnalyticsNotice[] { return this.db.prepare('SELECT json FROM analytics_notices ORDER BY rowid').all().map(json<AnalyticsNotice>); }
    notices(asOf = new Date().toISOString()): AnalyticsNotice[] {
        const facts = new Set(this.facts().map(fact => factKey(fact.fact_ref)));
        return this.noticeHistory().filter(notice => {
            const decision = this.target(notice.decision_ref)?.value as MajorDecisionContract | undefined;
            const goal = decision ? this.target(decision.goal_ref)?.value as GoalContract | undefined : undefined;
            return Date.parse(notice.verified_at) <= Date.parse(asOf) && facts.has(factKey(notice.fact_ref)) && !!decision && !!goal && decisionActiveAt(decision, goal, asOf, { decision_confirmed: this.confirmed(notice.decision_ref), goal_confirmed: this.confirmed(decision.goal_ref) });
        });
    }
    pilot(config: BookkeepingConfig, asOf: string) {
        const active = new Set(this.notices(asOf).map(notice => notice.notice_id));
        return analyticsPilotStats(config, { as_of: asOf, coverage: this.coverage(), reviews: this.reviews(), notices: this.noticeHistory().map(notice => ({ notice_id: notice.notice_id, verified_at: notice.verified_at, active: active.has(notice.notice_id) })), actions: this.db.prepare('SELECT json FROM analytics_action_events ORDER BY rowid').all().map(json<PilotActionEvent>) });
    }
    historyRecord(key: string): any | null { const row = this.db.prepare('SELECT json FROM analytics_legacy WHERE migration_key=?').get(key); return row ? json(row) : null; }
    saveHistory(key: string, value: unknown): void { this.db.prepare('INSERT INTO analytics_legacy VALUES(?,?)').run(key, canonical(value)); }
    readHistory(): unknown[] { return this.db.prepare('SELECT json FROM analytics_legacy ORDER BY rowid').all().map(json); }
    currentOutput(batchId: string, config?: BookkeepingConfig, asOf = new Date().toISOString()): AnalyticsOutput { return { schema_version: 1, batch_id: batchId, facts: this.facts(), observations: this.observations(), coverage: this.coverage(), snapshots: this.snapshots(asOf), notices: this.notices(asOf), freshness: this.freshness(), overlays: this.overlays(), analytics_catalog: this.catalog(config), exclusions: this.exclusions().map(item => ({ fact_ref: item.fact_ref, reason: item.reason })) }; }
    cockpitRegion(): string | null { const row = this.db.prepare("SELECT json FROM analytics_state WHERE key='cockpit_region'").get(); return row ? json<string>(row) : null; }
    setCockpitRegion(region: string): void { this.db.prepare("INSERT INTO analytics_state VALUES('cockpit_region',?) ON CONFLICT(key) DO UPDATE SET json=excluded.json").run(canonical(region)); }
    pendingCockpit(): {
        operation_id: string;
        region: string;
    } | null { const row = this.db.prepare("SELECT json FROM analytics_state WHERE key='pending_cockpit'").get(); return row ? json(row) : null; }
    setPendingCockpit(value: {
        operation_id: string;
        region: string;
    } | null): void {
        if (value === null)
            this.db.prepare("DELETE FROM analytics_state WHERE key='pending_cockpit'").run();
        else
            this.db.prepare("INSERT INTO analytics_state VALUES('pending_cockpit',?) ON CONFLICT(key) DO UPDATE SET json=excluded.json").run(canonical(value));
    }
}
/** Consumer-facing persistence operations expose no SQLite handle or transaction primitives. */
export type AnalyticsPort = Pick<AnalyticsRepository, 'ingest' | 'facts' | 'lookupFacts' | 'exclusions' | 'coverage' | 'observations' | 'snapshots' | 'rawSnapshot' | 'unresolvedHistory' | 'confirmedGoals' | 'applyReview' | 'currentOutput' | 'cockpitRegion' | 'setCockpitRegion' | 'pendingCockpit' | 'setPendingCockpit' | 'target' | 'latestRevision' | 'configureCatalog' | 'catalog' | 'pilot'>;
export function getAnalyticsPort(store: unknown): AnalyticsPort {
    const provider = store as {
        analyticsPort?: () => AnalyticsPort;
    };
    if (typeof provider.analyticsPort !== 'function')
        throw new Error('Analytics requires transactional Store persistence');
    return provider.analyticsPort();
}
export function getAnalyticsHistoryRepository(store: unknown): AnalyticsRepository {
    const provider = store as {
        analyticsHistoryRepository?: () => AnalyticsRepository;
    };
    if (typeof provider.analyticsHistoryRepository !== 'function')
        throw new Error('History requires transactional Store persistence');
    return provider.analyticsHistoryRepository();
}
