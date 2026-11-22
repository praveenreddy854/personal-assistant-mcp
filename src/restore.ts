import { z } from 'zod';
import { MemoryService } from './memory.js';
import { Database } from './db.js';
import type { MemoryAI } from './models.js';

export const ReceiptSchema=z.object({
  vault_id:z.uuid(),id:z.uuid(),lineage_ids:z.array(z.uuid()),source_ids:z.array(z.uuid()),
  field_refs:z.array(z.object({session_id:z.uuid(),field_key:z.string()})),removed_claims:z.number().int(),
  claim_ids:z.array(z.uuid()).default([]),session_ids:z.array(z.uuid()).default([]),request_keys:z.array(z.uuid()).default([]),created_at:z.string()
});
export type Receipt=z.infer<typeof ReceiptSchema>;

/** After a restore, revoke restored family-vault secrets even when no receipt touched that vault. */
export async function invalidateRestoredFamilyVault(db:Database) {
  const family=await db.read(db.directory,'family','family');if(!family)return false;
  const memory=new MemoryService(db,{} as MemoryAI,'restore-does-not-call-models');
  await db.withVaultId(family.vault_id,true,async tx=>{
    await memory.invalidateCopies(tx);
    for(const session of await tx.find('form_sessions'))await tx.set('form_sessions',session.id,{pair_hash:null,capture_hash:null,checkpoint_revision:null,snapshot_challenge:null});
    await db.bump(tx);
  },undefined,true);
  return true;
}

/** Administrative replay: disable serving until every receipt has been reapplied. */
export async function reapplyDeletionReceipt(db:Database,receipt:Receipt) {
  if(!await db.read(db.container,'vault',receipt.vault_id))return;
  const memory=new MemoryService(db,{} as MemoryAI,'restore-does-not-call-models');
  await db.withVaultId(receipt.vault_id,true,async tx=>{
    if((await tx.find('claims',{where:{lineage_id:receipt.lineage_ids},limit:1})).length)await memory.applyForget(tx,{lineages:receipt.lineage_ids});
    for(const id of receipt.session_ids){const form=await tx.get('form_sessions',id);if(form)await memory.discardForm(tx,{session_id:id,revision:form.revision});}
    await memory.removeFields(tx,receipt.field_refs);await memory.removeClaims(tx,receipt.claim_ids);
    await memory.invalidateCopies(tx);
    for(const key of receipt.request_keys)await tx.put('operations',key,{request_key:key,request_hash:'',result:{},forgotten:true,lease_until:null});
    for(const session of await tx.find('form_sessions'))await tx.set('form_sessions',session.id,{pair_hash:null,capture_hash:null,checkpoint_revision:null,snapshot_challenge:null});
    await tx.put('deletion_receipts',receipt.id,receipt);await db.bump(tx);
  },undefined,true);
}
