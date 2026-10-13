import type {JournalBaselineEvidence,JournalBaselineAssessment} from '../contracts/types.ts';
import {validateJournalBaselineAssessment} from '../contracts/validation.ts';
import {digest} from '../analytics/serialization.ts';
/** Complete structural Markdown blocks using original page byte coordinates. */
export function journalBodyBlocks(content:string):Omit<JournalBaselineEvidence,'dimensions'>[] {
 const header=content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/),offset=header?.[0].length??0;
 const lines=[...content.slice(offset).matchAll(/[^\n]*(?:\n|$)/g)].filter(match=>match[0].length).map(match=>({text:match[0].replace(/\r?\n$/,''),start:offset+match.index!,end:offset+match.index!+match[0].replace(/\r?\n$/,'').length}));
 const blocks:Omit<JournalBaselineEvidence,'dimensions'>[]=[];let fenced=false;
 for(let i=0;i<lines.length;){const line=lines[i]!;if(/^\s*(```|~~~)/.test(line.text)){fenced=!fenced;i++;continue;}if(fenced||!line.text.trim()||/^\s{0,3}(#{1,6}\s|[-*_]{3,}\s*$)/.test(line.text)){i++;continue;}
  const kind=/^\s*(?:[-+*]|\d+[.)])\s+/.test(line.text)?'list_item':'paragraph';let end=i;
  while(end+1<lines.length){const next=lines[end+1]!.text;if(!next.trim()||/^\s*(?:[-+*]|\d+[.)])\s+/.test(next)||/^\s{0,3}(#{1,6}\s|```|~~~|[-*_]{3,}\s*$)/.test(next))break;end++;}
  const startChar=line.start,endChar=lines[end]!.end,text=content.slice(startChar,endChar);
  blocks.push({schema_version:1,section:'body',kind,start_byte:Buffer.byteLength(content.slice(0,startChar)),end_byte:Buffer.byteLength(content.slice(0,endChar)),text});i=end+1;
 }
 return blocks;
}
export function strongJournalAssessment(assessment:JournalBaselineAssessment|undefined,baseline:{content:string|null;digest:string;excerpt?:boolean}|undefined):boolean {
 if(!assessment)return false;validateJournalBaselineAssessment(assessment);
 if(!baseline||baseline.excerpt||assessment.baseline_digest!==baseline.digest||(baseline.content===null?'absent':digest(baseline.content))!==baseline.digest)return false;
 const content=baseline.content??'',header=content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/),lines=header?.[1]!.split(/\r?\n/)??[],indices=lines.map((line,index)=>/^(?:summary|'summary'|"summary")[ \t]*:/.test(line)?index:-1).filter(index=>index>=0);if(indices.length>1)return false;
 let summary:string|null=null;if(indices.length){const index=indices[0]!;summary=lines[index]!.replace(/^(?:summary|'summary'|"summary")[ \t]*:[ \t]*/,'');for(let next=index+1;next<lines.length&&/^[ \t]+/.test(lines[next]!);next++)summary+='\n'+lines[next];}
 const safeDimensions=(dimensions:import('../contracts/types.ts').JournalAssessmentDimensions|undefined)=>!!dimensions&&Object.values(dimensions).every(value=>['consistent','not_applicable'].includes(value));
 if(assessment.summary_text!==summary||assessment.consistency!=='consistent'||assessment.summary_consistency!=='consistent'||assessment.body_consistency!=='consistent'||!assessment.relation||assessment.relation==='unknown'||!safeDimensions(assessment.summary_dimensions)||!Array.isArray(assessment.body_evidence))return false;
 const blocks=journalBodyBlocks(content);
 if(!assessment.body_evidence.length)return blocks.length===0&&assessment.body_evidence_text==='';
 const seen=new Set<string>();for(const evidence of assessment.body_evidence){const key=JSON.stringify([evidence.start_byte,evidence.end_byte]);if(seen.has(key)||!safeDimensions(evidence.dimensions)||!blocks.some(block=>block.start_byte===evidence.start_byte&&block.end_byte===evidence.end_byte&&block.text===evidence.text&&block.kind===evidence.kind))return false;seen.add(key);}
 return assessment.body_evidence_text===assessment.body_evidence.map(item=>item.text).join('\n\n');
}
