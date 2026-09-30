/** The writer PID survives execve, so a dead coordinator cannot expose an active
 * index subprocess to premature lock reclamation. No source records reach argv. */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { acquireWikiLock } from '../../publish/lock.ts';
import type { PublicCommand } from './index.ts';

async function executablePath(input: string): Promise<string> {
  if (isAbsolute(input)) { await access(input, constants.X_OK); return input; }
  if (input.includes('/')) throw new Error('Index executable must be absolute or a PATH program name');
  for (const folder of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const path = join(folder, input);
    try { await access(path, constants.X_OK); return path; } catch { /* try next explicit PATH directory */ }
  }
  throw new Error(`Index executable unavailable: ${input}`);
}
const [root, serialized] = process.argv.slice(2);
const command = JSON.parse(serialized) as PublicCommand;
const executable = await executablePath(command.executable);
if (!process.execve) throw new Error('Pinned Node runtime requires execve for safe index subprocess ownership');
const lock = await acquireWikiLock(root);
if (!lock) { process.stderr.write('Wiki writer is active; index build delayed\n'); process.exit(75); }
try {
  process.chdir(root);
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  process.execve(executable, [executable, ...command.args], environment);
  throw new Error('execve unexpectedly returned');
} catch (error) { await lock.release(); throw error; }
