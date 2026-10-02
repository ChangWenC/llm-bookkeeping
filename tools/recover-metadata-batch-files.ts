import { loadConfig } from '../src/config.ts';
import { applyMetadataFileRecovery, previewMetadataFileRecovery } from '../src/metadata-batch-file-recovery.ts';

// Coordinator-only; supplied material is data, never commands. No direct undo or history deletion.
try {
  const args = process.argv.slice(2), values: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!['--config', '--bad-batch', '--before-db', '--preview', '--apply', '--expected-plan-sha'].includes(key) || key in values) throw new Error('Unknown or duplicate recovery option');
    if (['--preview', '--apply'].includes(key)) values[key] = true;
    else { const value = args[++index]; if (!value || value.startsWith('--')) throw new Error('Missing recovery option value'); values[key] = value; }
  }
  if (!values['--config'] || !values['--bad-batch'] || !values['--before-db'] || !!values['--preview'] === !!values['--apply']) throw new Error('Supply --config ABS --bad-batch ID --before-db ABS and exactly one --preview|--apply');
  if (values['--preview'] && values['--expected-plan-sha']) throw new Error('Preview accepts no apply proof');
  const config = await loadConfig(values['--config'] as string);
  const receipt = values['--preview'] ? await previewMetadataFileRecovery(config, values['--bad-batch'] as string, values['--before-db'] as string)
    : await applyMetadataFileRecovery(config, values['--bad-batch'] as string, values['--before-db'] as string, values['--expected-plan-sha'] as string);
  process.stdout.write(JSON.stringify(receipt) + '\n');
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Metadata batch file recovery failed') + '\n'); process.exitCode = 1;
}
