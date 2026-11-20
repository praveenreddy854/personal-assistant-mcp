import { beforeAll,afterAll,it,expect,vi } from 'vitest';
import { Database } from '../src/db.js';
import { fixture,setupDatabase,options,context,extraction,rows } from './helpers.js';
import { randomUUID } from 'node:crypto';
let admin:Database;
beforeAll(async()=>{admin=await setupDatabase();});afterAll(async()=>{await admin.close();});
it('resumes an interrupted multi-batch change before exposing any vault records',async()=>{
  const f=await fixture(admin),db=new Database({...options,batchSize:2});
  const real=db.container.items.batch.bind(db.container.items);let calls=0;
  const spy=vi.spyOn(db.container.items,'batch').mockImplementation(async(...args)=>{calls++;if(calls===3)throw new Error('simulated process failure');return real(...args);});
  try{
    await expect(db.withVault(f.actor,true,async tx=>{for(let i=0;i<7;i++)await tx.put('sources',String(i),{text:`source ${i}`});await db.bump(tx);})).rejects.toThrow('simulated process failure');
    expect((await db.read(db.container,'vault',f.vault)).maintenance).toBeDefined();spy.mockRestore();
    expect(await rows(f,'sources')).toHaveLength(7);
    const head=await db.read(db.container,'vault',f.vault);expect(head.maintenance).toBeUndefined();expect(head.revision).toBe(1);
    const leftovers=await db.container.items.query({query:"SELECT c.id FROM c WHERE c.kind='journal' AND c.vault_id=@vault",parameters:[{name:'@vault',value:f.vault}]},{partitionKey:f.vault}).fetchAll();expect(leftovers.resources).toHaveLength(0);
  }finally{spy.mockRestore();await f.db.close();await db.close();}
});
it('retries competing conditional batches without losing either change',async()=>{
  const f=await fixture(admin),other=new Database(options);let entered=0,release!:()=>void;
  const barrier=new Promise<void>(resolve=>{release=resolve;});
  const save=(db:Database,id:string)=>db.withVault(f.actor,true,async tx=>{if(++entered<=2){if(entered===2)release();await barrier;}await tx.put('sources',id,{text:id});await db.bump(tx);});
  try{await Promise.all([save(f.db,'first'),save(other,'second')]);expect(await rows(f,'sources')).toHaveLength(2);expect((await f.db.recover(f.vault))?.revision).toBe(2);}
  finally{await f.db.close();await other.close();}
});
it('rejects an oversized document before installing a maintenance barrier',async()=>{
  const f=await fixture(admin);try{
    await expect(f.db.withVault(f.actor,true,tx=>tx.put('sources','large',{text:'x'.repeat(1800000)}))).rejects.toMatchObject({code:'change_too_large'});
    expect((await f.db.recover(f.vault))?.maintenance).toBeUndefined();expect(await rows(f,'sources')).toHaveLength(0);
  }finally{await f.db.close();}
});
it('forgets a journaled collection of sources, vectors and retries completely',async()=>{
  const f=await fixture(admin),db=new Database({...options,batchSize:2});f.memory.db=db;
  try{
    f.ai.extractions.push(extraction(f.vault,[{predicate:'allergy',value:'penicillin',quote:'Allergy penicillin',value_quote:'penicillin'}]));
    const saved=await f.memory.remember(f.actor,'Allergy penicillin',context,randomUUID()) as any;
    const proposal=await f.memory.proposeForget(f.actor,saved.claim_ids,'Forget allergy');await f.memory.decide(f.actor,proposal.proposal_id,'approve','Forget allergy');
    const raw=await db.container.items.query<any>({query:'SELECT * FROM c WHERE c.vault_id=@vault',parameters:[{name:'@vault',value:f.vault}]},{partitionKey:f.vault}).fetchAll();
    expect(JSON.stringify(raw.resources)).not.toContain('penicillin');expect(raw.resources.some(item=>item.embedding)).toBe(false);
  }finally{await f.db.close();await db.close();}
});
