import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const implementationRoot=fileURLToPath(new URL('../',import.meta.url));
import { spawnSync } from 'node:child_process';
const files = [];
async function discover(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await discover(path);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) files.push(path);
  }
}
await discover(join(implementationRoot,'test'));
await discover(join(implementationRoot,'tests'));
if (!files.length) throw new Error('No test files found');
const result = spawnSync(process.execPath, ['--test', ...files.sort()], { stdio: 'inherit', cwd:implementationRoot });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
