import { beforeAll,afterAll,beforeEach,afterEach,it,expect } from 'vitest';
import type { Database } from '../src/db.js';
import { randomUUID } from 'node:crypto';
import { context,extraction,fixture,setupDatabase,rows } from './helpers.js';
import type { Field } from '../src/models.js';
let admin:Database,f:Awaited<ReturnType<typeof fixture>>;
beforeAll(async()=>{admin=await setupDatabase();});afterAll(async()=>{await admin.close();});
beforeEach(async()=>{f=await fixture(admin);});afterEach(async()=>{await f.db.close();});
function event(value:unknown,sequence=1,label='Full name'):Field{return {event_id:randomUUID(),device_id:'00000000-0000-4000-8000-000000000002',sequence,field_key:'00000000-0000-4000-8000-000000000001',label,value:value as any,input_type:'text',observed_at:'2026-11-14T20:00:00Z',page_path:'/intake',origin:'user'};}
async function paired(){const session=await f.forms.start(f.actor,'Medical intake','https://forms.example');const pair=await f.forms.pair(session.pairing_code,'https://forms.example');return {...session,...pair};}
it('pairs one exact origin once; a capture token cannot access another session',async()=>{
  const session=await f.forms.start(f.actor,'Intake','https://forms.example');
  await expect(f.forms.pair(session.pairing_code,'https://other.example')).rejects.toMatchObject({code:'wrong_origin'});
  const pair=await f.forms.pair(session.pairing_code,'https://forms.example');
  await expect(f.forms.pair(session.pairing_code,'https://forms.example')).rejects.toMatchObject({code:'invalid_capture_secret'});
  const other=await fixture(admin);try{await expect(other.forms.get(other.actor,session.session_id)).rejects.toMatchObject({code:'not_found'});}finally{await other.db.close();}
  expect((await f.forms.status(pair.capture_token)).session_id).toBe(session.session_id);
});
it('saves unfinished drafts, preserves revisions and prevents out-of-order overwrite',async()=>{
  const session=await paired(),first=event('Alex');
  await f.forms.capture(session.capture_token,{events:[first]});
  expect((await f.forms.capture(session.capture_token,{events:[first]})).accepted).toBe(0);
  await expect(f.forms.capture(session.capture_token,{events:[{...first,value:'Mallory'}]})).rejects.toMatchObject({code:'event_conflict'});
  await f.forms.capture(session.capture_token,{events:[event('Alexandra',2)]});
  await expect(f.forms.capture(session.capture_token,{events:[event('Old',1)]})).rejects.toMatchObject({code:'out_of_order'});
  const stored=await f.forms.get(f.actor,session.session_id);
  expect(stored.session.status).toBe('draft');expect(stored.fields[0].value).toBe('Alexandra');
  expect(f.ai.extractCalls).toBe(0);
  expect((await rows(f,'claims')).length).toBe(0);
});
it('requires a fresh final snapshot and completion promotes source-grounded fields without submission',async()=>{
  const session=await paired();await f.forms.capture(session.capture_token,{events:[event('Alex')]});
  expect((await f.forms.finalize(f.actor,session.session_id,context,randomUUID()) as any).status).toBe('awaiting_final_snapshot');
  const status=await f.forms.status(session.capture_token);
  await expect(f.forms.checkpoint(session.capture_token,status.snapshot_challenge,1)).rejects.toMatchObject({code:'pending_capture'});
  await f.forms.checkpoint(session.capture_token,status.snapshot_challenge,0);
  const form=await f.forms.get(f.actor,session.session_id);
  f.ai.extractions.push(extraction(f.vault,[{predicate:'name',value:'Alex',quote:'Full name [00000000-0000-4000-8000-000000000001]: "Alex"',value_quote:'Alex'}]));
  const saved=await f.forms.finalize(f.actor,session.session_id,context,randomUUID()) as any;
  expect(saved.status).toBe('saved');expect(saved.claim_ids).toHaveLength(1);
  expect((await f.forms.get(f.actor,session.session_id)).session).toMatchObject({status:'finalized',submission_status:'unknown'});
  expect(form.fields).toHaveLength(1);
  expect((await rows(f,'claim_evidence'))[0].field_keys).toEqual(['00000000-0000-4000-8000-000000000001']);
});
it('a late field edit invalidates the final checkpoint',async()=>{
  const session=await paired();await f.forms.capture(session.capture_token,{events:[event('Alex')]});
  await f.forms.finalize(f.actor,session.session_id,context,randomUUID());
  await f.forms.checkpoint(session.capture_token,(await f.forms.status(session.capture_token)).snapshot_challenge,0);
  await f.forms.capture(session.capture_token,{events:[event('Alexandra',2)]});
  expect((await f.forms.finalize(f.actor,session.session_id,context,randomUUID()) as any).status).toBe('awaiting_final_snapshot');
});
it('form finalization does not bypass existing-fact approval; further edits invalidate that proposal',async()=>{
  f.ai.extractions.push(extraction(f.vault,[{predicate:'name',value:'Alex',quote:'Name Alex',value_quote:'Alex'}]));
  const original=await f.memory.remember(f.actor,'Name Alex',context,randomUUID()) as any;
  const session=await paired();await f.forms.capture(session.capture_token,{events:[event('Alexandra')]});
  await f.forms.finalize(f.actor,session.session_id,context,randomUUID());
  await f.forms.checkpoint(session.capture_token,(await f.forms.status(session.capture_token)).snapshot_challenge,0);
  f.ai.extractions.push(extraction(f.vault,[{predicate:'name',value:'Alexandra',quote:'Full name [00000000-0000-4000-8000-000000000001]: "Alexandra"',value_quote:'Alexandra',change:'correction',replaces:original.claim_ids}]));
  const pending=await f.forms.finalize(f.actor,session.session_id,context,randomUUID()) as any;
  expect(pending.status).toBe('approval_required');
  await f.forms.capture(session.capture_token,{events:[event('Alexis',2)]});
  await expect(f.memory.decide(f.actor,pending.proposal_id,'approve','Use Alexandra')).rejects.toMatchObject({code:'stale_form'});
});
it('forgetting purges recognized draft-field revisions and blocks replay resurrection',async()=>{
  f.ai.extractions.push(extraction(f.vault,[{predicate:'date_of_birth',value:'May 12',quote:'Birthday May 12',value_quote:'May 12'}]));
  const original=await f.memory.remember(f.actor,'Birthday May 12',context,randomUUID()) as any;
  const session=await paired(),birth={...event('May 12'),label:'Date of birth'};
  await f.forms.capture(session.capture_token,{events:[birth]});
  const pending=await f.memory.proposeForget(f.actor,original.claim_ids,'Forget birthday');
  await f.memory.decide(f.actor,pending.proposal_id,'approve','Forget birthday');
  expect((await f.forms.get(f.actor,session.session_id)).fields).toHaveLength(0);
  expect((await f.forms.status(session.capture_token)).forgotten_field_keys).toEqual([birth.field_key]);
  await expect(f.forms.capture(session.capture_token,{events:[birth]})).rejects.toMatchObject({code:'forgotten_field'});
  expect((await rows(f,'form_revisions')).length).toBe(0);
});
it('supports re-pairing an unfinished form and revokes the previous capture token',async()=>{
  const session=await paired(),again=await f.forms.pairAgain(f.actor,session.session_id);
  const pair=await f.forms.pair(again.pairing_code,'https://forms.example');
  await expect(f.forms.status(session.capture_token)).rejects.toMatchObject({code:'invalid_capture_secret'});
  expect((await f.forms.status(pair.capture_token)).session_id).toBe(session.session_id);
});
it('can discard an unclassified draft only after scoped chat approval',async()=>{
  const session=await paired();await f.forms.capture(session.capture_token,{events:[event('A contextual application answer')]});
  const proposed=await f.memory.proposeDiscardForm(f.actor,session.session_id,'Forget this draft form');
  expect((await f.forms.get(f.actor,session.session_id)).fields).toHaveLength(1);
  await f.memory.decide(f.actor,proposed.proposal_id,'approve','Forget this entire draft form');
  await expect(f.forms.get(f.actor,session.session_id)).rejects.toMatchObject({code:'not_found'});
  expect((await rows(f,'form_revisions')).length).toBe(0);
});
