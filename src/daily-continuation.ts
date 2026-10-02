import { parseArgs, runCli } from './cli.ts';
import { absolutePath, loadConfig } from './config.ts';
import { array, InputError, string, version } from './contracts/validation.ts';
import type { CliDependencies } from './cli.ts';

export interface DailyStep {
  schema_version: 1; source: string; args: string[];
}
export interface DailyPlan { schema_version: 1; steps: DailyStep[] }

/** A bounded coordinator plan; only existing prepare/publish CLI routes run. */
export function validateDailyPlan(value: unknown): DailyPlan {
  const plan = version(value, 'daily plan');
  const steps = array(plan.steps, 'steps');
  if (!steps.length || steps.length > 64) throw new InputError('daily plan requires 1–64 steps');
  for (const entry of steps) {
    const step = version(entry, 'daily step');
    string(step.source, 'step.source');
    const args = array(step.args, 'step.args');
    if (!args.length || args.length > 48 || args.some(value => typeof value !== 'string' || !value.length || value.length > 4096)) throw new InputError('step.args must be a bounded CLI argument list');
    const parsed = parseArgs(args);
    if (parsed.options.config) throw new InputError('Daily steps inherit one explicit config');
    if (parsed.command === 'prepare') {
      if (parsed.options.kind !== 'daily' || parsed.options.source !== step.source) throw new InputError('Preparation step must select its exact daily source');
    } else if (parsed.command !== 'publish' || parsed.options.resume) {
      throw new InputError('Daily step requires source-scoped prepare or one publish input');
    }
  }
  return plan as DailyPlan;
}

/** Never calls a model or creates review results. Source failures leave siblings eligible. */
export async function continueDailyPlan(value: unknown, configPath: string, dependencies: CliDependencies = {}) {
  const plan = validateDailyPlan(value);
  absolutePath(configPath, 'config');
  const config = await (dependencies.loadConfig ?? loadConfig)(configPath);
  const allocation = plan.steps.filter(step => step.args[0] === 'prepare').reduce((total, step) => {
    const parsed = parseArgs(step.args);
    return total + Number(parsed.options['max-bundles'] ?? config.limits.bundles_per_round);
  }, 0);
  if (allocation > config.limits.bundles_per_round) throw new InputError('Planned preparation exceeds the total configured round bundle budget');
  dependencies = { ...dependencies, loadConfig: async () => config };
  const receipts: { source: string; command: string; exit_code: number; result: unknown; diagnostics: string }[] = [];
  let storage: 'available' | 'unavailable' = 'available';
  for (const step of plan.steps) {
    let output = '', diagnostics = '';
    const exitCode = await runCli([...step.args, '--config', configPath], {
      ...dependencies, stdout: text => { output += text; }, stderr: text => { diagnostics += text; },
    });
    const result = JSON.parse(output);
    receipts.push({ source: step.source, command: step.args[0], exit_code: exitCode, result, diagnostics });
    if (exitCode === 1 && result?.error?.scope === 'storage') {
      storage = 'unavailable';
      return { schema_version: 1, receipts, storage, remaining_steps: plan.steps.length - receipts.length };
    }
    if (exitCode === 1) {
      // A fresh source-independent Store opening distinguishes source/file debt
      // from a global DB/config/runtime outage. It does not certify write capacity.
      let probeOutput = '', probeDiagnostics = '';
      const probeCode = await runCli(['status', '--config', configPath], {
        ...dependencies, stdout: text => { probeOutput += text; }, stderr: text => { probeDiagnostics += text; },
      });
      if (probeCode !== 0) {
        storage = 'unavailable';
        return { schema_version: 1, receipts, storage, probe: { exit_code: probeCode, result: JSON.parse(probeOutput), diagnostics: probeDiagnostics }, remaining_steps: plan.steps.length - receipts.length };
      }
    }
  }
  return { schema_version: 1, receipts, storage, remaining_steps: 0 };
}
