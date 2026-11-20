import { beforeAll,afterAll,beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
import type { Database } from '../src/db.js';
import { randomUUID } from 'node:crypto';
import { context,extraction,fixture,setupDatabase,rows as readRows } from './helpers.js';
import { redact } from '../src/memory.js';

let admin:Database,f:Awaited<ReturnType<typeof fixture>>;
beforeAll(async()=>{admin=await setupDatabase();});afterAll(async()=>{await admin.close();});
beforeEach(async()=>{f=await fixture(admin);});afterEach(async()=>{await f.db.close();});
async function remember(predicate:string,value:unknown,text:string,key=randomUUID()){
  f.ai.extractions.push(extraction(f.vault,[{predicate,value:value as any,quote:text,value_quote:String(value)}]));
  return f.memory.remember(f.actor,text,context,key) as Promise<any>;
}
describe('private memory lifecycle',()=>{
  it('isolates document partitions and rejects cross-vault references',async()=>{
    const other=await fixture(admin);
    try{
      const saved=await remember('date_of_birth','May 12','Birthday May 12');
      const rows=await other.db.withVault(other.actor,false,async tx=>tx.find('claims',{where:{id:saved.claim_ids[0]}}));
      expect(rows).toEqual([]);
      await expect(other.memory.proposeForget(other.actor,saved.claim_ids,'Forget birthday')).rejects.toMatchObject({code:'not_found'});
      f.ai.extractions.push(extraction(f.vault,[{subject_ref:other.vault,quote:'Alex',value_quote:'Alex'}]));
      await expect(f.memory.remember(f.actor,'Alex',context,randomUUID())).rejects.toMatchObject({code:'invalid_extraction'});
    }finally{await other.db.close();}
  });
  it('deduplicates retries, rejects changed payloads and preserves zero/false values',async()=>{
    const key=randomUUID(),text='I have 0 dependents';
    f.ai.extractions.push(extraction(f.vault,[{predicate:'dependents',value:0,quote:text,value_quote:'0'}]));
    const first=await f.memory.remember(f.actor,text,context,key);
    expect(await f.memory.remember(f.actor,text,context,key)).toEqual(first);expect(f.ai.extractCalls).toBe(1);
    await expect(f.memory.remember(f.actor,'Different',context,key)).rejects.toMatchObject({code:'idempotency_conflict'});
    await remember('smokes',false,'I smoke: false');
    const rows=(await readRows(f,'claims',{orderBy:'predicate'}));
    expect(rows.map(r=>r.value)).toEqual([0,false]);
  });
  it('blocks retry resurrection after forgetting, including an in-flight model request',async()=>{
    const key=randomUUID(),text='Birthday May 12';
    await remember('date_of_birth','May 12',text,key);
    let release!:(value:any)=>void,started!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    vi.spyOn(f.ai,'extract').mockImplementationOnce(async()=>{started();return await new Promise(resolve=>{release=resolve;});});
    const pending=f.memory.remember(f.actor,text,context,randomUUID());
    const outcome=pending.then(value=>({value}),error=>({error}));
    await entered;
    const ids=(await readRows(f,'claims')).map(row=>row.id);
    const deletion=await f.memory.proposeForget(f.actor,ids,'Forget birthday');
    await f.memory.decide(f.actor,deletion.proposal_id,'approve','Forget birthday');
    release(extraction(f.vault,[{predicate:'date_of_birth',value:'May 12',quote:text,value_quote:'May 12'}]));
    expect((await outcome as any).error).toMatchObject({code:'forgotten_request'});
    await expect(f.memory.remember(f.actor,text,context,key)).rejects.toMatchObject({code:'forgotten_request'});
    expect((await readRows(f,'claims')).length).toBe(0);
  });
  it('rejects ungrounded extraction without writing evidence or claims',async()=>{
    f.ai.extractions.push(extraction(f.vault,[{value:'invented',quote:'not in the source',value_quote:'invented'}]));
    await expect(f.memory.remember(f.actor,'Actual source',context,randomUUID())).rejects.toMatchObject({code:'ungrounded_claim'});
    expect((await readRows(f,'claims')).length).toBe(0);
  });
  it('gates logical replacements even when the model labels them as additions',async()=>{
    const original=await remember('birthday','May 12','Birthday May 12');
    const proposed=await remember('DOB','May 21','Birthday May 21');
    expect(proposed.status).toBe('approval_required');
    const before=(await readRows(f,'claims'));
    expect(before.map(r=>r.value)).toEqual(['May 12']);
    expect(proposed.preview[0].existing[0].id).toBe(original.claim_ids[0]);
    await expect(f.memory.decide({...f.actor,clientId:'another-agent'},proposed.proposal_id,'approve','Yes')).rejects.toMatchObject({code:'wrong_client'});
  });
  it('detects conflicts outside a bounded interpretation snapshot',async()=>{
    const original=await remember('date_of_birth','May 12','Birthday May 12');
    const realSnapshot=f.memory.snapshot.bind(f.memory);
    vi.spyOn(f.memory,'snapshot').mockImplementation(async(...args)=>({...await realSnapshot(...args),claims:[],truncated:true}));
    const proposed=await remember('date_of_birth','May 21','Birthday May 21');
    expect(proposed.status).toBe('approval_required');expect(proposed.preview[0].existing[0].id).toBe(original.claim_ids[0]);
  });
  it('retains corrected claims but excludes them from ordinary recall',async()=>{
    const old=await remember('date_of_birth','May 12','Birthday May 12');
    const text='Correction: birthday is May 21, not May 12';
    f.ai.extractions.push(extraction(f.vault,[{predicate:'date_of_birth',value:'May 21',quote:text,value_quote:'May 21',change:'correction',replaces:old.claim_ids}]));
    const pending=await f.memory.remember(f.actor,text,context,randomUUID()) as any;
    await f.memory.recall(f.actor,'birthday',2);
    expect(f.ai.answerRecords[0].claims.map((c:any)=>c.value)).toEqual(['May 12']);
    const applied=await f.memory.decide(f.actor,pending.proposal_id,'approve','Correct my birthday to May 21');
    expect(await f.memory.decide(f.actor,pending.proposal_id,'approve','Correct my birthday to May 21')).toEqual(applied);
    await f.memory.recall(f.actor,'birthday',2);
    expect(f.ai.answerRecords[0].claims.map((c:any)=>c.value)).toEqual(['May 21']);
    const historical=(await readRows(f,'claims',{where:{id:old.claim_ids[0]}}))[0];
    expect(historical.status).toBe('corrected');expect(historical.valid_to).toBeNull();
    await f.memory.recall(f.actor,'birthday revision history',2,{include_corrections:true});
    expect(f.ai.answerRecords[0].claims).toHaveLength(2);
  });
  it('rejects stale and expired proposals',async()=>{
    await remember('name','Alex','Name Alex');
    const pending=await remember('name','Alexandra','Name Alexandra');
    await remember('occupation','Engineer','Occupation Engineer');
    await expect(f.memory.decide(f.actor,pending.proposal_id,'approve','Yes')).rejects.toMatchObject({code:'stale_proposal'});
    const second=await remember('name','Alexandra','Name Alexandra');
    await f.db.withVault(f.actor,true,tx=>tx.set('proposals',second.proposal_id,{expires_at:new Date(Date.now()-1000).toISOString()}));
    await expect(f.memory.decide(f.actor,second.proposal_id,'approve','Yes')).rejects.toMatchObject({code:'proposal_expired'});
  });
  it('preserves a real residence interval separately from correction history',async()=>{
    f.ai.extractions.push(extraction(f.vault,[{predicate:'residence',value:'Boston',quote:'Boston since 2020-01-01',value_quote:'Boston',valid_from:'2020-01-01'}]));
    const old=await f.memory.remember(f.actor,'Boston since 2020-01-01',context,randomUUID()) as any;
    f.ai.extractions.push(extraction(f.vault,[{predicate:'residence',value:'Seattle',quote:'Moved to Seattle on 2026-11-01',value_quote:'Seattle',valid_from:'2026-11-01',change:'transition',replaces:old.claim_ids}]));
    const proposed=await f.memory.remember(f.actor,'Moved to Seattle on 2026-11-01',context,randomUUID()) as any;
    await f.memory.decide(f.actor,proposed.proposal_id,'approve','Update my residence to Seattle from November 1');
    const row=(await readRows(f,'claims',{where:{id:old.claim_ids[0]}}))[0];
    expect(row).toMatchObject({status:'historical',valid_from:'2020-01-01',valid_to:'2026-11-01'});
    await f.memory.recall(f.actor,'Where did I live?',2,{as_of:'2021-01-01'});
    expect(f.ai.answerRecords[0].claims.map((c:any)=>c.value)).toEqual(['Boston']);
    const current=(await readRows(f,'claims',{where:{status:'active'}}))[0];
    const former=(await readRows(f,'claims',{where:{id:old.claim_ids[0]}}))[0];
    expect(current.lineage_id).not.toBe(former.lineage_id);
    const deletion=await f.memory.proposeForget(f.actor,[current.id],'Forget Seattle residence');
    await f.memory.decide(f.actor,deletion.proposal_id,'approve','Forget Seattle residence');
    expect((await readRows(f,'claims')).map(row=>row.value)).toEqual(['Boston']);
  });
  it('retains retraction evidence and removes it when that information is forgotten',async()=>{
    const old=await remember('allergy','penicillin','Allergy penicillin');
    const text='The penicillin allergy was retracted';
    f.ai.extractions.push(extraction(f.vault,[{predicate:'allergy',value:'penicillin',quote:text,value_quote:'penicillin',change:'retraction',replaces:old.claim_ids}]));
    const proposed=await f.memory.remember(f.actor,text,context,randomUUID()) as any;
    await f.memory.decide(f.actor,proposed.proposal_id,'approve','Retract the penicillin allergy');
    expect((await readRows(f,'claim_evidence',{orderBy:'relation'})).map(row=>row.relation)).toContain('retracts');
    const deletion=await f.memory.proposeForget(f.actor,old.claim_ids,'Forget allergy');
    await f.memory.decide(f.actor,deletion.proposal_id,'approve','Forget allergy');
    expect((await readRows(f,'sources')).length).toBe(0);
  });
  it('forgets current and corrected values, repeated correction text, proposals and cached responses',async()=>{
    const old=await remember('date_of_birth','May 12','Birthday May 12');
    const text='Birthday is May 21, not May 12';
    f.ai.extractions.push(extraction(f.vault,[{predicate:'date_of_birth',value:'May 21',quote:text,value_quote:'May 21',change:'correction',replaces:old.claim_ids}]));
    const p=await f.memory.remember(f.actor,text,context,randomUUID()) as any;
    const saved=await f.memory.decide(f.actor,p.proposal_id,'approve','Correct to May 21') as any;
    const forget=await f.memory.proposeForget(f.actor,saved.claim_ids,'Forget my birthday');
    const receipt=await f.memory.decide(f.actor,forget.proposal_id,'approve','Forget my birthday') as any;
    expect(receipt.status).toBe('forgotten');expect(receipt.removed_claims).toBe(2);
    for(const table of ['claims','sources','claim_evidence','operations','proposals','deletion_receipts']){
      const rows=(await readRows(f,table as any));
      expect(JSON.stringify(rows)).not.toContain('May 12');expect(JSON.stringify(rows)).not.toContain('May 21');
    }
    expect((await readRows(f,'deletion_receipts')).length).toBe(1);
  });
  it('redacts only the targeted source value while retaining unrelated evidence',async()=>{
    const text='My birthday is May 12. My occupation is Engineer.';
    f.ai.extractions.push(extraction(f.vault,[{predicate:'date_of_birth',value:'May 12',quote:'My birthday is May 12.',value_quote:'May 12'},
      {predicate:'occupation',value:'Engineer',quote:'My occupation is Engineer.',value_quote:'Engineer'}]));
    const result=await f.memory.remember(f.actor,text,context,randomUUID()) as any;
    const pending=await f.memory.proposeForget(f.actor,[result.claim_ids[0]],'Forget birthday');
    await f.memory.decide(f.actor,pending.proposal_id,'approve','Forget birthday');
    const source=(await readRows(f,'sources'))[0];
    expect(source.text).toContain('Engineer');expect(source.text).not.toContain('May 12');expect(source.redacted).toBe(true);
    const evidence=(await readRows(f,'claim_evidence'));
    expect(evidence.map(e=>({quote:e.quote}))).toEqual([{quote:'My occupation is Engineer.'}]);
  });
  it('does not emit a stale AI answer after memory changes during generation',async()=>{
    await remember('name','Alex','Name Alex');
    f.ai.answerHook=async()=>{await f.db.withVault(f.actor,true,async tx=>f.db.bump(tx));};
    await expect(f.memory.recall(f.actor,'name',2)).rejects.toMatchObject({code:'concurrent_change'});
  });
  it('rejects invented answer citations',async()=>{
    await remember('name','Alex','Name Alex');
    f.ai.answerOverride={answer:'Invented',used_claim_ids:[randomUUID()],missing_information:[],conflicts:[]};
    await expect(f.memory.recall(f.actor,'name',2)).rejects.toMatchObject({code:'invalid_citation'});
  });
});
it('merges overlapping redaction spans without erasing unrelated text',()=>{
  expect(redact('abcdefghij',[{start:2,end:5},{start:4,end:7}])).toBe('ab[forgotten]hij');
});
