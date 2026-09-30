import { readFile } from 'node:fs/promises';
import { createStore } from '../../src/store/index.ts';
const {config,result,step}=JSON.parse(await readFile(process.argv[2],'utf8'));
const store=await createStore(config,{onTransactionStep(at){if(at===step)process.exit(71);}});
await store.commitReview(result);store.close();
