import type { BookkeepingConfig, CoverageGap, PageBaseline } from '../contracts/types.ts';
import { readPageBaseline } from './baselines.ts';
import { canonical } from '../analytics/serialization.ts';

/** Goal context is exact configured page evidence, never a discovered namespace or a contract confirmation. */
export async function readGoalPageBaselines(config: BookkeepingConfig, budget = Math.floor(config.limits.bundle_bytes / 8)): Promise<{ baselines: PageBaseline[]; gaps: CoverageGap[] }> {
  if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('Goal material budget must be a positive safe integer');
  const limit = Math.min(budget, Math.floor(config.limits.bundle_bytes / 8));
  const baselines: PageBaseline[] = [], gaps: CoverageGap[] = [];
  const issue = (reason: string, path: string | null = null) => gaps.push({ schema_version: 1, range: null, reason, locator: path, resumable: true });
  const paths = [...new Set(config.goal_whitelist)];
  const selected = paths.slice(0, 16);
  if (paths.length > selected.length) issue(`Explicit goal page material omitted by budget: ${paths.length - selected.length}; prepare with a narrower explicit goal whitelist`);
  // Reserve full-path/full-digest metadata before dividing the remaining body budget.
  const metadata = Buffer.byteLength(canonical(selected.map(path => ({ schema_version: 1, path, digest: '0'.repeat(64), content: '', context_excerpt: true, excerpt_reason: 'x'.repeat(256) }))));
  const bodyBudget = Math.floor((limit - metadata) / Math.max(1, selected.length));
  if (selected.length && bodyBudget < 64) {
    issue('Explicit goal page metadata exceeds its bounded material budget; use fewer configured pages or a larger bundle budget');
    return { baselines, gaps };
  }
  for (const path of selected) {
    if (!path.startsWith('wiki/') || !path.endsWith('.md') || path.split('/').some(part => part === '..' || part === '.' || !part) || path.includes('\\')) {
      issue('Configured goal is not an exact relative Wiki Markdown page; no discovery attempted', path);
      continue;
    }
    try {
      const page = await readPageBaseline(config, path, bodyBudget);
      baselines.push(page);
      if (Buffer.byteLength(canonical(baselines)) > limit) {
        baselines.pop();
        issue('Goal page material does not fit its total budget; retry with fewer configured pages or a larger bundle budget', path);
        continue;
      }
      if (page.digest === 'absent') issue('Explicit configured goal page is absent; no goal contract inferred', path);
      else if (page.context_excerpt) issue(page.excerpt_reason! + '; increase bundle budget or narrow the goal whitelist to read the full goal page', path);
    } catch (error) {
      issue('Explicit configured goal page unavailable: ' + String(error), path);
    }
  }
  return { baselines, gaps };
}
