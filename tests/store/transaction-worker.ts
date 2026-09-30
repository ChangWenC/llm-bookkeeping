import { parentPort, workerData } from 'node:worker_threads';
import { createStore } from '../../src/store/index.ts';
const {config,result,delay}=workerData;
const store=await createStore(config,{onTransactionStep(step){if(step==='review_facts'&&delay)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,delay);}});
try { const committed=await store.commitReview(result);parentPort!.postMessage({ok:true,committed}); }catch(error){parentPort!.postMessage({ok:false,error:String(error)});}finally{store.close();}
