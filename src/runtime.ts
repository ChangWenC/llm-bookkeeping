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
export async function createRuntime(config: BookkeepingConfig, command?: string): Promise<RuntimeServices> {
  requireNode();
  const storeModule = await loadModule('./store/index.ts');
  const store: Store = await storeModule.createStore(config);
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
    restore: (input, dataDir) => restoreRuntime(input, dataDir, config),
    async close() {
      try { await Promise.all(adapters.map(adapter => adapter.close?.())); }
      finally { await store.close(); }
    },
  };
  try {
    if (!command || command === 'collect' || command === 'replay') {
      const module = await loadModule('./adapters/index.ts');
      adapters.push(...module.createAdapters(config));
    }
    if (!command || command === 'prepare') {
      const module = await loadModule('./review/index.ts');
      services.reviewer = module.createReviewer(store, config);
    }
    if (!command || command === 'publish') {
      const module = await loadModule('./publish/index.ts');
      services.publisher = module.createPublisher(store, config);
    }
    return services;
  } catch (error) {
    await services.close!();
    throw error;
  }
}
