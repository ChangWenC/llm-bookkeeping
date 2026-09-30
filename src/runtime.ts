import type { BookkeepingConfig, RuntimeServices } from './contracts/types.ts';
export class UnavailableError extends Error { constructor(message:string){super(message);this.name='UnavailableError';} }
/** Composition only: missing modules are an explicit execution error, not fake success. */
export async function createRuntime(config:BookkeepingConfig):Promise<RuntimeServices>{
  if(process.versions.node!=='25.8.0')throw new UnavailableError(`Node 25.8.0 required; found ${process.versions.node}`);
  const load=async(path:string)=>{try{return await import(path);}catch(e){if((e as any).code==='ERR_MODULE_NOT_FOUND')throw new UnavailableError(`Not implemented: ${path}`);throw e;}};
  const storeModule=await load('./store/index.ts');
  const store=await storeModule.createStore(config);
  try{
    const modules=await Promise.all([load('./adapters/index.ts'),load('./review/index.ts'),load('./publish/index.ts')]);
    return {store,adapters:modules[0].createAdapters(config),reviewer:modules[1].createReviewer(store,config),publisher:modules[2].createPublisher(store,config),consumers:[]};
  }catch(e){await store.close();throw e;}
}
