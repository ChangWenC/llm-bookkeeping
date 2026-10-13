import type { BookkeepingConfig, Consumer, Store } from '../contracts/types.ts';
import { DEFAULT_INDEX_COMMANDS } from '../config.ts';
import { createMonthlyConsumer } from './monthly/index.ts';
import { createIndexConsumer } from './index/index.ts';
import { createEvidenceConsumer } from './evidence/index.ts';
export { createArchiveService } from './archive/index.ts';
export { createMonthlyConsumer } from './monthly/index.ts';
export { createIndexConsumer } from './index/index.ts';
export { createEvidenceConsumer } from './evidence/index.ts';

export async function createConsumers(store: Store, config: BookkeepingConfig, targets = ['analytics', 'monthly', 'evidence', 'index'], options: { now?: () => Date; remaining_ms?: () => number } = {}): Promise<Consumer[]> {
  const consumers: Consumer[] = [];
  for (const target of targets) {
    if (target === 'evidence') consumers.push(createEvidenceConsumer(store, config, options));
    else if (target === 'monthly') consumers.push(createMonthlyConsumer(store, config, options));
    else if (target === 'index') consumers.push(createIndexConsumer(store, config, { ...options, commands: config.index_commands ?? DEFAULT_INDEX_COMMANDS }));
    else if (target === 'analytics') {
      const path = './analytics/index.ts';
      const module = await import(path);
      consumers.push(module.createAnalyticsConsumer(store, config, { now: options.now, writer: options }));
    } else throw new Error(`Unknown consumer ${target}`);
  }
  return consumers;
}
