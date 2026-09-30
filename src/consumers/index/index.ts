import { spawn } from 'node:child_process';
import type { BookkeepingConfig, Consumer, ConsumerOutcome, Store, WorkItem } from '../../contracts/types.ts';
import { acquireWikiLock, readWikiTarget } from '../../publish/index.ts';
import { sha } from '../archive/records.ts';
import { fileURLToPath } from 'node:url';

export interface PublicCommand { executable: string; args: string[]; timeout_ms?: number }
export interface CommandResult { exit_code: number; stdout: string; stderr: string }
export interface IndexContext { wiki_root: string; paths: string[]; requires_wiki_lock?: boolean }
export type CommandRunner = (command: PublicCommand, context: IndexContext) => Promise<CommandResult>;
export interface IndexOptions { commands?: { lint: PublicCommand; build_index: PublicCommand; qmd: PublicCommand }; runner?: CommandRunner; now?: () => Date }
export const runPublicCommand: CommandRunner = (command, context) => new Promise((resolve, reject) => {
  if (!command.executable || !Array.isArray(command.args)) { reject(new Error('Explicit executable and argument array required')); return; }
  const executable = context.requires_wiki_lock ? process.execPath : command.executable;
  const args = context.requires_wiki_lock ? ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./lock-command.ts', import.meta.url)), context.wiki_root, JSON.stringify(command)] : command.args;
  const child = spawn(executable, args, { cwd: context.wiki_root, shell: false,
    env: { ...process.env, BOOKKEEPING_WIKI_ROOT: context.wiki_root, BOOKKEEPING_CHANGED_PATHS_JSON: JSON.stringify(context.paths) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout = (stdout + data.toString()).slice(-65536); });
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-65536); });
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 5000); killTimer.unref(); }, command.timeout_ms ?? 120000); timer.unref();
  child.on('error', error => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error); });
  child.on('close', (code, signal) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); resolve({ exit_code: code ?? 1, stdout, stderr: signal ? `${stderr}\nCommand terminated: ${signal}` : stderr }); });
});
export function createIndexConsumer(store: Store, config: BookkeepingConfig, options: IndexOptions = {}): Consumer {
  const commands = options.commands ?? { lint: { executable: process.execPath, args: ['scripts/lint.mjs'] }, build_index: { executable: 'python3', args: ['scripts/build_index.py'] }, qmd: { executable: 'qmd', args: ['update'] } };
  const runner = options.runner ?? runPublicCommand, now = () => (options.now?.() ?? new Date()).toISOString();
  return { target: 'index', async consume(): Promise<ConsumerOutcome> {
    const work = await store.listWork('index', 'pending');
    if (!work.length) return { schema_version: 1, target: 'index', status: 'complete', reason: null };
    const workIds = work.map(item => item.work_id).sort(), paths = [...new Set(work.map(item => String(item.payload.path)))].sort();
    for (const path of paths) await readWikiTarget(config.wiki_root, path); // permits successful deleted paths, rejects escapes
    const job = sha(JSON.stringify(workIds)), context = { wiki_root: config.wiki_root, paths };
    let completedBuild = false;
    for (const stage of ['lint', 'build_index', 'qmd'] as const) {
      const stageId = `index-stage:${job}:${stage}`;
      const previous = (await store.listWork('index_stage')).find(item => item.work_id === stageId);
      if (previous?.state === 'complete') { if (stage === 'build_index') completedBuild = true; continue; }
      await store.enqueueWork({ schema_version: 1, work_id: stageId, kind: 'index_stage', lane: 'live', state: 'pending', payload: { stage, work_ids: workIds, paths }, reason: 'Public index pipeline awaits output', migration_key: null, updated_at: now() });
      try {
        let output: CommandResult;
        if (stage === 'build_index') {
          if (!options.runner) output = await runner(commands[stage], { ...context, requires_wiki_lock: true });
          else {
            const lock = await acquireWikiLock(config.wiki_root);
            if (!lock) return { schema_version: 1, target: 'index', status: 'pending', reason: 'Wiki writer is active; index build delayed' };
            try { output = await runner(commands[stage], context); } finally { await lock.release(); }
          }
        } else output = await runner(commands[stage], context);
        if (output.exit_code !== 0) throw new Error(`${stage} exited ${output.exit_code}: ${output.stderr || output.stdout}`);
        await store.completeWork(stageId);
        if (stage === 'build_index') completedBuild = true;
      } catch (error) {
        const reason = (error as Error).message;
        await store.enqueueWork({ schema_version: 1, work_id: `index-failure:${job}:${stage}:${sha(reason)}`, kind: 'index_failure', lane: 'live', state: 'pending', payload: { stage, work_ids: workIds, paths }, reason, migration_key: null, updated_at: now() });
        return { schema_version: 1, target: 'index', status: completedBuild ? 'partial' : 'pending', reason };
      }
    }
    for (const item of work) await store.completeWork(item.work_id);
    for (const kind of ['index_stage', 'index_failure']) for (const item of await store.listWork(kind, 'pending')) {
      const ids = item.payload.work_ids;
      if (Array.isArray(ids) && ids.every(id => workIds.includes(String(id)))) await store.completeWork(item.work_id);
    }
    return { schema_version: 1, target: 'index', status: 'complete', reason: null };
  } };
}
