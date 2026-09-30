import type { BookkeepingConfig, Consumer, Store } from '../contracts/types.ts';
import { DEFAULT_INDEX_COMMANDS } from '../config.ts';
import { createMonthlyConsumer } from './monthly/index.ts';
import { createIndexConsumer } from './index/index.ts';
export { createArchiveService } from './archive/index.ts';
export { createMonthlyConsumer } from './monthly/index.ts';
export { createIndexConsumer } from './index/index.ts';

export async function createConsumers(store: Store, config: BookkeepingConfig, targets = ['analytics', 'monthly', 'index']): Promise<Consumer[]> {
  const consumers: Consumer[] = [];
  for (const target of targets) {
    if (target === 'monthly') consumers.push(createMonthlyConsumer(store, config));
    else if (target === 'index') consumers.push(createIndexConsumer(store, config, { commands: config.index_commands ?? DEFAULT_INDEX_COMMANDS }));
    else if (target === 'analytics') {
      const path = './analytics/index.ts';
      const module = await import(path);
      consumers.push(module.createAnalyticsConsumer(store, config));
    } else throw new Error(`Unknown consumer ${target}`);
  }
  return consumers;
}
