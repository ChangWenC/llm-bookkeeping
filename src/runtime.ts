import type { BookkeepingConfig, RuntimeServices, Store, Reviewer, Publisher } from './contracts/types.ts';
import { validateDataLocation, canonicalLocation } from './config.ts';

export class UnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'UnavailableError'; }
}

function requireNode(): void {
  if (process.versions.node !== '25.8.0') {
    throw new UnavailableError(`Node 25.8.0 required; found ${process.versions.node}`);
  }
}

async function loadModule(path: string): Promise<any> {
  try { return await import(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      throw new UnavailableError(`Not implemented: ${path}`);
    }
    throw error;
  }
}

function unavailable(capability: string): never {
  throw new UnavailableError(`Not implemented: ${capability}`);
}

/** Restore is independent of the current database and every source adapter. */
export async function restoreRuntime(input: string, dataDir: string, config: BookkeepingConfig): Promise<unknown> {
  requireNode();
  const [destination, wiki, ...roots] = await Promise.all([dataDir, config.wiki_root, ...config.providers.flatMap(provider => provider.roots)].map(canonicalLocation));
  validateDataLocation(destination, wiki, roots);
  const module = await loadModule('./store/index.ts');
  if (typeof module.restoreStore !== 'function') unavailable('restore');
  return { schema_version: 1, ...await module.restoreStore(input, dataDir) };
}

/** Command-scoped composition. Reading status/facts or restoring never initializes sources. */
export async function createRuntime(config: BookkeepingConfig, command?: string, options: Record<string, string | boolean> = {}, now?: () => Date): Promise<RuntimeServices> {
  requireNode();
  const storeModule = await loadModule('./store/index.ts');
  const store: Store = await storeModule.createStore(config, { now });
  let deadlineAt: number | undefined;
  const budget = { now, remaining_ms: () => deadlineAt === undefined ? Infinity : Math.max(0, deadlineAt - (now?.() ?? new Date()).getTime()) };
  const adapters: RuntimeServices['adapters'] = [];
  const reviewer: Reviewer = {
    prepare: async () => unavailable('review preparation'),
    accept: async () => unavailable('review acceptance'),
  };
  const publisher: Publisher = {
    publish: async () => unavailable('publication'),
    resume: async () => unavailable('publication resume'),
    exportFacts: async () => unavailable('fact export'),
    applyPatches: async () => unavailable('file publication'),
  };
  const services: RuntimeServices = {
    store, adapters, reviewer, publisher, consumers: [],
    setDeadline: deadline => { deadlineAt = Date.parse(deadline); },
    restore: (input, dataDir) => restoreRuntime(input, dataDir, config),
    async close() {
      try { await Promise.all(adapters.map(adapter => adapter.close?.())); }
      finally { await store.close(); }
    },
  };
  try {
    if (!command || command === 'collect' || (command === 'replay' && !options.events) || command === 'daily-round') {
      const module = await loadModule('./adapters/index.ts');
      adapters.push(...module.createAdapters(config));
    }
    if (!command || command === 'prepare' || command === 'journal-prepare' || command === 'daily-round' || command === 'monthly-round') {
      const module = await loadModule('./review/index.ts');
      services.reviewer = module.createReviewer(store, config);
    }
    if (!command || command === 'publish' || command === 'journal-resolve' || command === 'daily-round' || command === 'monthly-round') {
      const module = await loadModule('./publish/index.ts');
      services.publisher = module.createPublisher(store, config, budget);
    }
    if (!command || command === 'consume' || command === 'daily-round' || command === 'monthly-round') {
      const module = await loadModule('./consumers/index.ts');
      const target = options.target;
      const targets = typeof target === 'string' && target !== 'all' ? [target] : ['analytics', 'monthly', 'evidence', 'index'];
      services.consumers = await module.createConsumers(store, config, targets, budget);
    }
    if (!command || command === 'archive' || command === 'monthly-round') {
      const module = await loadModule('./consumers/archive/index.ts');
      services.archive = request => module.createArchiveService(store, config, budget).run(request);
    }
    if (command === 'analytics-review') {
      const module = await loadModule('./consumers/analytics/index.ts');
      const analytics = module.createAnalyticsConsumer(store, config, { now });
      services.analyticsReview = input => analytics.review(input);
    }
    if (command === 'import' || command === 'migrate') {
      const module = await loadModule('./migration/index.ts');
      let analytics;
      try {
        const historyModule = await loadModule('./store/history.ts');
        analytics = historyModule.createAnalyticsHistoryPort(store, config);
      } catch (error) {
        if (!(error instanceof UnavailableError)) throw error;
        // Migration retains history and needs_review when its optional projection port is absent.
      }
      const migration = module.createMigrationService(store, config, { analytics, budget: config.migration_limits });
      services.importManifest = input => migration.importManifest(input);
      services.migrateManifest = input => migration.migrateManifest(input);
    }
    if (command === 'validate') {
      const module = await loadModule('./store/health.ts');
      services.validate = scope => module.validateStore(store, scope);
    }
    return services;
  } catch (error) {
    await services.close!();
    throw error;
  }
}
