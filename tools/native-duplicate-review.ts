import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.ts';
import { previewNativeDuplicates, prepareNativeDuplicates } from '../src/store/native-duplicates.ts';

// Deliberate root-operated maintenance; never publishes or directly marks sources.
try {
    const args = process.argv.slice(2), options: Record<string, string | boolean> = {};
    for (let index = 0; index < args.length; index++) {
        const key = args[index];
        if (!['--config', '--manifest', '--preview', '--prepare', '--expected-plan-sha', '--output'].includes(key) || options[key] !== undefined) throw new Error('Unknown or repeated maintenance option');
        if (['--preview', '--prepare'].includes(key)) options[key] = true;
        else {
            const value = args[++index];
            if (!value || value.startsWith('--')) throw new Error('Missing maintenance option value');
            options[key] = value;
        }
    }
    if (!options['--config'] || !options['--manifest'] || !!options['--preview'] === !!options['--prepare']) throw new Error('Specify --config, --manifest, and exactly one of --preview / --prepare');
    if (options['--preview'] && (options['--output'] || options['--expected-plan-sha'])) throw new Error('Preview accepts no preparation options');
    const config = await loadConfig(options['--config'] as string), manifest = JSON.parse(await readFile(options['--manifest'] as string, 'utf8'));
    const receipt = options['--preview'] ? previewNativeDuplicates(config, manifest)
        : await prepareNativeDuplicates(config, manifest, options['--expected-plan-sha'] as string, options['--output'] as string);
    process.stdout.write(JSON.stringify(receipt) + '\n');
} catch (error) {
    // Errors are deliberately structural; no event bodies or private paths.
    process.stderr.write((error instanceof Error ? error.message : 'Native duplicate preparation failed') + '\n');
    process.exitCode = 1;
}
