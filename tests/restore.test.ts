import { beforeAll,afterAll,it,expect } from 'vitest';
import type { Database } from '../src/db.js';
import { randomUUID } from 'node:crypto';
import { context,extraction,fixture,setupDatabase,rows } from './helpers.js';
import { ReceiptSchema,reapplyDeletionReceipt } from '../src/restore.js';
let admin:Database;
beforeAll(async()=>{admin=await setupDatabase();});afterAll(async()=>{await admin.close();});
it('replays content-free receipts against restored documents without affecting another vault',async()=>{
  const f=await fixture(admin),other=await fixture(admin);
  try{
    f.ai.extractions.push(extraction(f.vault,[{predicate:'date_of_birth',value:'May 12',quote:'Birthday May 12',value_quote:'May 12'}]));
    const saved=await f.memory.remember(f.actor,'Birthday May 12',context,randomUUID()) as any;
    const backup=await f.db.container.items.query<any>({query:"SELECT * FROM c WHERE c.vault_id=@vault AND ARRAY_CONTAINS(@kinds,c.kind)",parameters:[{name:'@vault',value:f.vault},{name:'@kinds',value:['sources','claims','claim_evidence']}]},{partitionKey:f.vault}).fetchAll();
    const proposal=await f.memory.proposeForget(f.actor,saved.claim_ids,'Forget birthday');
    const forgotten=await f.memory.decide(f.actor,proposal.proposal_id,'approve','Forget birthday') as any;
    const receipt=ReceiptSchema.parse((await rows(f,'deletion_receipts',{where:{id:forgotten.receipt_id}}))[0]);
    expect(JSON.stringify(receipt)).not.toContain('May 12');
    for(const row of backup.resources){const { _rid,_self,_etag,_attachments,_ts,...document}=row;await f.db.container.items.upsert(document);}
    other.ai.extractions.push(extraction(other.vault,[{predicate:'name',value:'Jamie',quote:'Name Jamie',value_quote:'Jamie'}]));
    await other.memory.remember(other.actor,'Name Jamie',context,randomUUID());
    // Revoked vaults must also have restored private content erased.
    const head=await admin.read(admin.container,'vault',f.vault);await admin.container.item('vault',f.vault).replace({...head,active:false});
    await reapplyDeletionReceipt(admin,receipt);
    expect((await admin.withVaultId(f.vault,false,tx=>tx.find('claims'),undefined,true))).toHaveLength(0);
    expect(await rows(other,'claims')).toHaveLength(1);
  }finally{await f.db.close();await other.db.close();}
});
