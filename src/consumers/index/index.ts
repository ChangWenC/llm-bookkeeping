import { spawn } from 'node:child_process';
import type { BookkeepingConfig, Consumer, ConsumerOutcome, Store, WorkItem } from '../../contracts/types.ts';
import { acquireWikiLock, readWikiTarget } from '../../publish/index.ts';
import { sha } from '../archive/records.ts';
import { fileURLToPath } from 'node:url';
import { storageFailureCode } from '../../storage-errors.ts';
import { DEFAULT_INDEX_COMMANDS } from '../../config.ts';
import { parsePublicLint, PUBLIC_LINT_REPORT_VERSION, PUBLIC_LINT_REQUIRED_CAPABILITY } from './lint.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface PublicCommand { executable: string; args: string[]; timeout_ms?: number; kill_grace_ms?: number }
export interface CommandResult { exit_code: number; stdout: string; stderr: string; output_limit_exceeded?: boolean }
export const PUBLIC_OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
export interface IndexContext { wiki_root: string; paths: string[]; requires_wiki_lock?: boolean }
export type CommandRunner = (command: PublicCommand, context: IndexContext) => Promise<CommandResult>;
export interface IndexOptions { commands?: { lint: PublicCommand; build_index: PublicCommand; qmd: PublicCommand }; runner?: CommandRunner; now?: () => Date; remaining_ms?: () => number }
export const runPublicCommand: CommandRunner = (command, context) => new Promise((resolve, reject) => {
  if (!command.executable || !Array.isArray(command.args)) { reject(new Error('Explicit executable and argument array required')); return; }
  const executable = context.requires_wiki_lock ? process.execPath : command.executable;
  const args = context.requires_wiki_lock ? ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('./lock-command.ts', import.meta.url)), context.wiki_root, JSON.stringify(command)] : command.args;
  const child = spawn(executable, args, { cwd: context.wiki_root, shell: false,
    env: { ...process.env, BOOKKEEPING_WIKI_ROOT: context.wiki_root, BOOKKEEPING_CHANGED_PATHS_JSON: JSON.stringify(context.paths) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let outputBytes = 0, overflow = false;
  const collect = (chunks: Buffer[], data: Buffer) => {
    if (overflow) return;
    outputBytes += data.length;
    if (outputBytes > PUBLIC_OUTPUT_LIMIT_BYTES) { overflow = true; child.kill('SIGKILL'); return; }
    chunks.push(Buffer.from(data));
  };
  child.stdout.on('data', data => collect(stdout, data));
  child.stderr.on('data', data => collect(stderr, data));
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const timer = setTimeout(() => { if (command.kill_grace_ms === 0) child.kill('SIGKILL'); else { child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), command.kill_grace_ms ?? 5000); killTimer.unref(); } }, command.timeout_ms ?? 120000); timer.unref();
  child.on('error', error => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); reject(error); });
  child.on('close', (code, signal) => { clearTimeout(timer); if (killTimer) clearTimeout(killTimer); const diagnostic = Buffer.concat(stderr).toString('utf8'); resolve({ exit_code: code ?? 1, stdout: Buffer.concat(stdout).toString('utf8'), stderr: signal ? `${diagnostic}\nCommand terminated: ${signal}` : diagnostic, ...(overflow ? { output_limit_exceeded: true } : {}) }); });
});
export function createIndexConsumer(store: Store, config: BookkeepingConfig, options: IndexOptions = {}): Consumer {
  const commands = options.commands ?? config.index_commands ?? DEFAULT_INDEX_COMMANDS;
  const runner = options.runner ?? runPublicCommand, now = () => (options.now?.() ?? new Date()).toISOString();
  return { target: 'index', async consume(): Promise<ConsumerOutcome> {
    if ((options.remaining_ms?.() ?? Infinity) <= 0) return { schema_version: 1, target: 'index', status: 'pending', reason: 'Task deadline reached before index consumption' };
    const work = await store.listWork('index', 'pending');
    if (!work.length) return { schema_version: 1, target: 'index', status: 'complete', reason: null };
    const workIds = work.map(item => item.work_id).sort(), paths = [...new Set(work.map(item => String(item.payload.path)))].sort();
    for (const path of paths) await readWikiTarget(config.wiki_root, path); // permits successful deleted paths, rejects escapes
    const job = sha(JSON.stringify(workIds)), context = { wiki_root: config.wiki_root, paths };
    let completedBuild = false, pipelineIdentity = '';
    const inputs = paths;
    const inputIdentity = await Promise.all(inputs.map(async path => [path, (await readWikiTarget(config.wiki_root, path)).digest]));
    const commandFiles: [string, string][] = [];
    // The required lint capability is implemented by this narrowly approved helper.
    try { commandFiles.push(['scripts/daily-journal-archive-target.mjs', sha(await readFile(resolve(config.wiki_root, 'scripts/daily-journal-archive-target.mjs')))]); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const baseIdentity = sha(JSON.stringify({ report_contract_version: PUBLIC_LINT_REPORT_VERSION, capability: PUBLIC_LINT_REQUIRED_CAPABILITY, commands, commandFiles, inputIdentity }));
    for (const stage of ['lint', 'build_index', 'qmd'] as const) {
      const remaining = options.remaining_ms?.() ?? Infinity;
      if (remaining <= 0) return { schema_version: 1, target: 'index', status: completedBuild ? 'partial' : 'pending', reason: 'Task deadline reached; index work retained' };
      const publicLint = stage === 'lint' && [commands[stage].executable, ...commands[stage].args].some(arg => arg === 'scripts/lint.mjs' || arg.endsWith('/scripts/lint.mjs'));
      const args = publicLint && !commands[stage].args.includes('--json') ? [...commands[stage].args, '--json'] : commands[stage].args;
      const command = { ...commands[stage], args, timeout_ms: Math.max(1, Math.min(commands[stage].timeout_ms ?? 120000, remaining)), ...(Number.isFinite(remaining) ? { kill_grace_ms: 0 } : {}) };
      const stageId = `index-stage:v${PUBLIC_LINT_REPORT_VERSION}:${job}:${stage}:${stage === 'lint' ? baseIdentity : pipelineIdentity}`;
      const previous = (await store.listWork('index_stage')).find(item => item.work_id === stageId);
      if (stage !== 'lint' && previous?.state === 'complete') { if (stage === 'build_index') completedBuild = true; continue; }
      await store.enqueueWork({ schema_version: 1, work_id: stageId, kind: 'index_stage', lane: 'live', state: 'pending', payload: { stage, work_ids: workIds, paths }, reason: 'Public index pipeline awaits output', migration_key: null, updated_at: now() });
      try {
        let output: CommandResult;
        if (stage === 'build_index') {
          if (!options.runner) output = await runner(command, { ...context, requires_wiki_lock: true });
          else {
            const lock = await acquireWikiLock(config.wiki_root);
            if (!lock) return { schema_version: 1, target: 'index', status: 'pending', reason: 'Wiki writer is active; index build delayed' };
            try { output = await runner(command, context); } finally { await lock.release(); }
          }
        } else output = await runner(command, context);
        const exceeded = output.output_limit_exceeded || Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > PUBLIC_OUTPUT_LIMIT_BYTES;
        let validationReason: string | null = null;
        if (!exceeded && stage === 'lint') {
          try {
            const report = parsePublicLint(output.stdout);
            if (report.errors.length) throw new Error('Public lint includes errors');
            pipelineIdentity = sha(`${baseIdentity}:${report.cache_identity}`);
          } catch (error) { validationReason = (error as Error).message; }
        }
        // Keep the complete bounded public result independently of its effective
        // status; validation never edits or disguises the real lint result.
        await store.enqueueWork({ schema_version: 1, work_id: `index-diagnostic:${job}:${baseIdentity}:${stage}:${sha(JSON.stringify(output))}`, kind: 'index_diagnostic', lane: 'live', state: 'complete',
          payload: { stage, work_ids: workIds, paths, ...output, effective_status: exceeded || validationReason || output.exit_code !== 0 ? 'pending' : 'complete', report_contract_version: PUBLIC_LINT_REPORT_VERSION, pipeline_identity: pipelineIdentity },
          reason: exceeded ? 'Public command output exceeded 8MiB; incomplete output cannot be interpreted' : validationReason, migration_key: null, updated_at: now() });
        if (exceeded) throw new Error(`${stage} output exceeded 8MiB; index work retained`);
        if (output.exit_code === 0 && validationReason) throw new Error(`${stage}: ${validationReason}; public diagnostics retained`);
        if (output.exit_code !== 0) throw new Error(`${stage} exited ${output.exit_code}${validationReason ? `: ${validationReason}` : ''}; public diagnostics retained`);
        await store.completeWork(stageId);
        if (stage === 'build_index') completedBuild = true;
      } catch (error) {
        const reason = (error as Error).message;
        const code = storageFailureCode(error);
        if (code) return { schema_version: 1, target: 'index', status: 'pending', reason, failure_scope: 'storage', failure_code: code };
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
