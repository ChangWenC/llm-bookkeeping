import type {BookkeepingConfig,SourceAdapter,ProviderConfig} from '../contracts/types.ts';
import {FileAdapter} from './files.ts';
import {WechatAdapter} from './wechat.ts';
import {coverage,gap,hash} from './common.ts';
export function createAdapters(config:BookkeepingConfig):SourceAdapter[]{return config.providers.map(source=>{
 if(['codex','claude'].includes(source.provider))return new FileAdapter(source,config);
 if(source.provider==='wechat')return new WechatAdapter(source,config);
 return {provider:source.provider,async *collect(request){yield {schema_version:1 as const,batch_id:hash(`${source.provider}:${request.cutoff}`),events:[],fragments:[],checkpoints:[],coverage:[coverage(source.provider,source.account_id,request,[gap('unsupported_provider')],null,source.enabled?'unavailable':'disabled')]};}};
});}
export {FileAdapter} from './files.ts';
export {WechatAdapter,parseWechatHistory,historyArgs} from './wechat.ts';
export {parseChatExport} from './imports.ts';
export {parseLossless,parseTime} from './common.ts';
