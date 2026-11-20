import { randomUUID } from 'node:crypto';
import { Database } from '../src/db.js';
import { MemoryService } from '../src/memory.js';
import { FormService } from '../src/forms.js';
import type { Actor, Answer, ClaimDraft, Context, Extraction, MemoryAI, Snapshot } from '../src/models.js';

export const cosmosEndpoint=process.env.TEST_COSMOS_ENDPOINT??'http://127.0.0.1:8081';
export const cosmosKey=Buffer.from('local-emulator-test-key').toString('base64');
export const cosmosEnv={COSMOS_ENDPOINT:cosmosEndpoint,COSMOS_KEY:cosmosKey};
export const options={endpoint:cosmosEndpoint,key:cosmosKey,database:process.env.TEST_COSMOS_DATABASE??'memory-test'};
export const context:Context={occurred_at:'2026-11-14T15:00:00-05:00',timezone:'America/New_York',conversation_context:''};
export class ScriptedAI implements MemoryAI {
  extractions:Extraction[]=[];extractCalls=0;answerRecords:any;answerOverride?:Answer;answerHook?:()=>Promise<void>;
  async extract(_text:string,_context:Context,_snapshot:Snapshot){this.extractCalls++;const result=this.extractions.shift();if(!result)throw new Error('No scripted extraction');return result;}
  async embed(text:string){const v=Array<number>(1536).fill(0);for(let i=0;i<text.length;i++)v[text.charCodeAt(i)%1536]!+=1;v[0]=1;return v;}
  async embedMany(texts:string[]){return Promise.all(texts.map(text=>this.embed(text)));}
  async answer(_question:string,_level:number,records:unknown[]){this.answerRecords=records;await this.answerHook?.();if(this.answerOverride)return this.answerOverride;
    const claims=(records[0] as any).claims;return {answer:claims.map((c:any)=>`${c.predicate}: ${JSON.stringify(c.value)}`).join('; '),used_claim_ids:claims.map((c:any)=>c.id),missing_information:[],conflicts:[]};}
}
export function extraction(self:string,claims:Partial<ClaimDraft>[],entities:Extraction['entities']=[]):Extraction {
  return {clarification:null,entities:[{ref:'self',existing_id:self,kind:'person',name:'Me',aliases:[]},...entities],claims:claims.map(c=>({subject_ref:'self',predicate:'name',object_ref:null,value:'Alex',domain:'identity',valid_from:null,valid_to:null,modality:'asserted',qualifiers:{},quote:'Alex',value_quote:'Alex',change:'add',replaces:[],...c}))};
}
export async function setupDatabase(){const db=new Database(options);await db.initialize();return db;}
export async function fixture(admin:Database,issuer='test-issuer'){
  const actor:Actor={issuer,subject:randomUUID(),clientId:'test-agent'},vault=await admin.invite(actor);
  const db=new Database(options),ai=new ScriptedAI(),memory=new MemoryService(db,ai,'test-embedding-v1');
  return {actor,vault,db,ai,memory,forms:new FormService(memory)};
}
export async function rows(f:Awaited<ReturnType<typeof fixture>>,kind:import('../src/db.js').Kind,query:import('../src/db.js').Query={}){return f.db.withVault(f.actor,false,tx=>tx.find(kind,query));}
