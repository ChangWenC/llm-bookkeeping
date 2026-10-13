import type { DatabaseSync } from 'node:sqlite';
export function initializeSchema(db: DatabaseSync): void {
    db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS preparation_cursors(id TEXT PRIMARY KEY,scope_digest TEXT NOT NULL,json TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES('schema','1');
      CREATE TABLE IF NOT EXISTS semantic_pages(snapshot_id TEXT NOT NULL,offset INTEGER NOT NULL,kind TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(snapshot_id,offset));
      CREATE TABLE IF NOT EXISTS semantic_material_pages(snapshot_id TEXT NOT NULL,material_id TEXT NOT NULL,offset INTEGER NOT NULL,kind TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(snapshot_id,material_id));
      CREATE TABLE IF NOT EXISTS archive_material_work(snapshot_id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fact_material_reads(snapshot_id TEXT NOT NULL,fact_id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(snapshot_id,fact_id,revision));
      CREATE TABLE IF NOT EXISTS fact_material_snapshots(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collections(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fragments(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,json TEXT NOT NULL,time TEXT,classification TEXT NOT NULL,ordering TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS event_time ON events(time,ordering,id);
      CREATE INDEX IF NOT EXISTS incomplete_event_metadata ON events(time,ordering,id) WHERE classification='main' AND (COALESCE(json_extract(json,'$.context.incomplete_turn'),0)=1 OR (json_extract(json,'$.role')!='user' AND json_extract(json,'$.context.turn_complete')=0));
      CREATE INDEX IF NOT EXISTS event_provider_time ON events(json_extract(json,'$.source.provider'),time,ordering,id);
      CREATE INDEX IF NOT EXISTS event_conversation_time ON events(json_extract(json,'$.source.provider'),json_extract(json,'$.source.account_id'),json_extract(json,'$.source.conversation_id'),time,ordering,id);
      CREATE INDEX IF NOT EXISTS codex_source_user ON events(
        json_extract(json,'$.source.account_id'),json_extract(json,'$.source.conversation_id'),
        json_extract(json,'$.locator'),json_extract(json,'$.generation'),ordering,id)
        WHERE json_extract(json,'$.source.provider')='codex' AND json_extract(json,'$.role')='user';
      CREATE TABLE IF NOT EXISTS event_lanes(event_id TEXT NOT NULL REFERENCES events(id),lane TEXT NOT NULL,PRIMARY KEY(event_id,lane));
      CREATE TABLE IF NOT EXISTS coverage(id TEXT PRIMARY KEY,json TEXT NOT NULL,from_time TEXT NOT NULL,to_time TEXT NOT NULL,lane TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS coverage_review_scope ON coverage(json_extract(json,'$.provider'),json_extract(json,'$.account_id'),json_extract(json,'$.conversation_id'),lane,from_time,to_time);
      CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY,json TEXT NOT NULL,provider TEXT NOT NULL,lane TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bundles(id TEXT PRIMARY KEY,json TEXT NOT NULL,kind TEXT NOT NULL,lane TEXT NOT NULL,period TEXT,cutoff TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,json TEXT NOT NULL,kind TEXT NOT NULL,lane TEXT NOT NULL,from_time TEXT,to_time TEXT,state TEXT NOT NULL DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS reviewed_units(kind TEXT NOT NULL,lane TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(kind,lane,event_id));
      CREATE TABLE IF NOT EXISTS reviewed_spans(kind TEXT NOT NULL,lane TEXT NOT NULL,source_id TEXT NOT NULL,start_byte INTEGER NOT NULL,end_byte INTEGER NOT NULL,total_bytes INTEGER NOT NULL,PRIMARY KEY(kind,lane,source_id,start_byte,end_byte));
      CREATE TABLE IF NOT EXISTS reviewed_sources(kind TEXT NOT NULL,lane TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(kind,lane,source_id));
      CREATE INDEX IF NOT EXISTS reviewed_sources_cross_lane ON reviewed_sources(kind,source_id);
      CREATE INDEX IF NOT EXISTS reviewed_units_cross_lane ON reviewed_units(kind,event_id);
      CREATE INDEX IF NOT EXISTS reviewed_spans_cross_lane ON reviewed_spans(kind,source_id,start_byte,end_byte);
      CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,bundle_id TEXT UNIQUE NOT NULL REFERENCES bundles(id),json TEXT NOT NULL,content TEXT NOT NULL,commit_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS accepted_publication_batch ON results(CASE WHEN json_valid(commit_json) THEN json_extract(commit_json,'$.batch_id') ELSE NULL END);
      CREATE TABLE IF NOT EXISTS acceptance_times(result_id TEXT PRIMARY KEY REFERENCES results(id),accepted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts(id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE INDEX IF NOT EXISTS facts_recorded ON facts(recorded_at,id,revision);
      CREATE INDEX IF NOT EXISTS facts_journal_date ON facts(json_extract(json,'$.journal_date.value'),recorded_at,id,revision);
      CREATE INDEX IF NOT EXISTS facts_occurred ON facts(json_extract(json,'$.occurred_at.value'),recorded_at,id,revision);
      CREATE TABLE IF NOT EXISTS fact_event_refs(fact_id TEXT NOT NULL,revision INTEGER NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(event_id,fact_id,revision));
      CREATE TABLE IF NOT EXISTS fact_targets(fact_id TEXT NOT NULL,revision INTEGER NOT NULL,target_id TEXT NOT NULL,target_revision INTEGER NOT NULL,PRIMARY KEY(target_id,target_revision,fact_id,revision));
      CREATE INDEX IF NOT EXISTS fact_ref_origin ON fact_event_refs(fact_id,revision,event_id);
      CREATE INDEX IF NOT EXISTS fact_target_origin ON fact_targets(fact_id,revision,target_id,target_revision);
      CREATE TRIGGER IF NOT EXISTS index_fact_refs AFTER INSERT ON facts BEGIN
        INSERT OR IGNORE INTO fact_event_refs SELECT NEW.id,NEW.revision,json_extract(value,'$.event_id') FROM json_each(NEW.json,'$.event_refs') WHERE json_extract(value,'$.event_id') IS NOT NULL;
        INSERT OR IGNORE INTO fact_targets SELECT NEW.id,NEW.revision,json_extract(value,'$.fact_id'),json_extract(value,'$.revision') FROM json_each(NEW.json,'$.target_refs') WHERE json_extract(value,'$.fact_id') IS NOT NULL;
      END;
      CREATE TABLE IF NOT EXISTS patches(id TEXT PRIMARY KEY,json TEXT NOT NULL,status TEXT NOT NULL,reason TEXT);
      CREATE TABLE IF NOT EXISTS operation_supersessions(original_id TEXT PRIMARY KEY,replacement_id TEXT UNIQUE NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_terminals(original_id TEXT PRIMARY KEY,audit_ref TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_bundles(id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal_resolutions(id TEXT PRIMARY KEY,bundle_id TEXT UNIQUE NOT NULL,json TEXT NOT NULL,commit_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS source_reads(provider TEXT NOT NULL,account_id TEXT NOT NULL,last_read_at TEXT NOT NULL,PRIMARY KEY(provider,account_id));
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,json TEXT NOT NULL,status TEXT NOT NULL,export_path TEXT);
      CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status);
      CREATE TABLE IF NOT EXISTS publication_acceptance_order(ordinal INTEGER PRIMARY KEY AUTOINCREMENT,batch_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS acks(consumer TEXT NOT NULL,batch_id TEXT NOT NULL REFERENCES outbox(id),json TEXT NOT NULL,PRIMARY KEY(consumer,batch_id));
      CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,json TEXT NOT NULL,state TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS intent_state ON intents(state);
      CREATE INDEX IF NOT EXISTS archived_journal_intent_path ON intents(json_extract(json,'$.path')) WHERE state='applied' AND json_extract(json,'$.desired_bytes_base64') IS NULL;
      CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,json TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,migration_key TEXT UNIQUE);
      CREATE INDEX IF NOT EXISTS work_kind_state ON work(kind,state);
      CREATE INDEX IF NOT EXISTS work_event_metadata ON work(json_extract(json,'$.payload.event_id'),kind,state);
      CREATE INDEX IF NOT EXISTS journal_archive_date ON work(json_extract(json,'$.payload.date')) WHERE kind='archive';
      CREATE TABLE IF NOT EXISTS semantic_replay_events(work_id TEXT NOT NULL REFERENCES work(id),event_id TEXT NOT NULL REFERENCES events(id),PRIMARY KEY(work_id,event_id));
      CREATE TABLE IF NOT EXISTS imports(migration_key TEXT PRIMARY KEY,json TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_mappings(source_id TEXT PRIMARY KEY,json TEXT NOT NULL);
    `);
    if (!db.prepare("SELECT 1 FROM metadata WHERE key='fact-ref-index:v1'").get()) {
        db.exec('BEGIN IMMEDIATE');
        try { db.exec(`
          INSERT OR IGNORE INTO fact_event_refs SELECT f.id,f.revision,json_extract(r.value,'$.event_id') FROM facts f,json_each(f.json,'$.event_refs') r WHERE json_extract(r.value,'$.event_id') IS NOT NULL;
          INSERT OR IGNORE INTO fact_targets SELECT f.id,f.revision,json_extract(r.value,'$.fact_id'),json_extract(r.value,'$.revision') FROM facts f,json_each(f.json,'$.target_refs') r WHERE json_extract(r.value,'$.fact_id') IS NOT NULL;
          INSERT OR IGNORE INTO metadata VALUES('fact-ref-index:v1','1');`);db.exec('COMMIT'); } catch(error){db.exec('ROLLBACK');throw error;}
    }
    // Backfill once from this database's extant insertion order, never model time.
    // The INTEGER primary key then persists through VACUUM/backup and restore.
    if ((db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as any)?.value === '1' && !db.prepare("SELECT 1 FROM metadata WHERE key='publication-acceptance-order:v1'").get()) {
        db.exec('BEGIN IMMEDIATE');
        try {
            if (!db.prepare("SELECT 1 FROM metadata WHERE key='publication-acceptance-order:v1'").get()) {
                db.exec(`INSERT INTO publication_acceptance_order(batch_id)
                    SELECT o.id FROM outbox o WHERE NOT EXISTS(SELECT 1 FROM publication_acceptance_order a WHERE a.batch_id=o.id)
                    AND (SELECT COUNT(*) FROM results r WHERE (CASE WHEN json_valid(r.commit_json) THEN json_extract(r.commit_json,'$.batch_id') ELSE NULL END)=o.id AND CASE WHEN json_valid(r.commit_json) THEN json_extract(r.commit_json,'$.schema_version')=1 AND json_extract(r.commit_json,'$.result_id')=r.id AND json_extract(r.commit_json,'$.batch_id')=o.id ELSE 0 END)=1 AND (SELECT COUNT(*) FROM results claims WHERE (CASE WHEN json_valid(claims.commit_json) THEN json_extract(claims.commit_json,'$.batch_id') ELSE NULL END)=o.id)=1 ORDER BY o.rowid;
                    INSERT INTO metadata VALUES('publication-acceptance-order:v1','1');`);
            }
            db.exec('COMMIT');
        } catch(error) {db.exec('ROLLBACK');throw error;}
    }
}
