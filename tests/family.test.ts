import { afterAll,beforeAll,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database,memberActor,ownerKey } from '../src/db.js';
import { MemoryService } from '../src/memory.js';
import { ScriptedAI,context,extraction,options,setupDatabase,cosmosEnv,fixture } from './helpers.js';
import { FormService } from '../src/forms.js';
import { invalidateRestoredFamilyVault } from '../src/restore.js';
import { authenticator } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

let admin:Database,db:Database,ai:ScriptedAI,memory:MemoryService;
beforeAll(async()=>{admin=await setupDatabase();db=new Database(options);ai=new ScriptedAI();memory=new MemoryService(db,ai,'test-embedding-v1');});
afterAll(async()=>{await db.close();await admin.close();});

it('lets family members share one vault while "me" is the signed-in member',async()=>{
  const praveen=memberActor(await admin.addMember(`Praveen-${randomUUID()}`)),ravi=memberActor(await admin.addMember(`Ravi-${randomUUID()}`));
  const p=await memory.snapshot(praveen,''),r=await memory.snapshot(ravi,'');
  const pSelf=p.entities.filter(e=>e.is_self),rSelf=r.entities.filter(e=>e.is_self);
  expect(pSelf).toHaveLength(1);expect(rSelf).toHaveLength(1);expect(pSelf[0]!.id).not.toBe(rSelf[0]!.id);

  // Ravi saves a fact about himself; Praveen can read it.
  ai.extractions.push(extraction(rSelf[0]!.id,[{predicate:'favorite_color',value:'blue',domain:'preferences',quote:'blue',value_quote:'blue'}]));
  await memory.remember(ravi,'My favorite color is blue',context,randomUUID());
  const seen=await db.withVault(praveen,false,tx=>tx.find('claims',{where:{subject_id:rSelf[0]!.id}}));
  expect(seen.map(c=>c.value)).toContain('blue');
});

it('rejects unknown and revoked tokens',async()=>{
  await expect(memory.snapshot(memberActor('not-a-real-token'),'')).rejects.toMatchObject({code:'not_invited'});
  const name=`Guest-${randomUUID()}`,guest=memberActor(await admin.addMember(name));
  await memory.snapshot(guest,'');
  expect(await admin.removeMember(name)).toBe(1);
  await expect(memory.snapshot(guest,'')).rejects.toMatchObject({code:'not_invited'});
});

it('re-adding a member after a lost token keeps the same person',async()=>{
  const name=`Maya-${randomUUID()}`,first=await memory.snapshot(memberActor(await admin.addMember(name)),'');
  await admin.removeMember(name);
  const second=await memory.snapshot(memberActor(await admin.addMember(name)),'');
  expect(second.entities.find(e=>e.is_self)!.id).toBe(first.entities.find(e=>e.is_self)!.id);
});

it('removing a member revokes their form pairing codes',async()=>{
  const name=`Form-${randomUUID()}`,actor=memberActor(await admin.addMember(name)),forms=new FormService(memory);
  const started=await forms.start(actor,'Test form','https://forms.example');
  await admin.removeMember(name);
  await expect(forms.pair(started.pairing_code,'https://forms.example')).rejects.toMatchObject({code:'invalid_capture_secret'});
});

it('rejects unknown tokens at authentication with 401',async()=>{
  const config=loadConfig({NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1:3000',...cosmosEnv,AUTH_MODE:'token'});
  const authenticate=authenticator(config,undefined,actor=>db.hasGrant(actor));
  const request=(token:string)=>({header:(n:string)=>n==='Authorization'?`Bearer ${token}`:undefined}) as any;
  await expect(authenticate(request('not-a-real-token'))).rejects.toMatchObject({status:401});
  const token=await admin.addMember(`Auth-${randomUUID()}`);
  await expect(authenticate(request(token))).resolves.toMatchObject({issuer:'family-token'});
});

it('tells the answer model who is asking',async()=>{
  const actor=memberActor(await admin.addMember(`Asker-${randomUUID()}`)),self=(await memory.snapshot(actor,'')).entities.find(e=>e.is_self)!.id;
  ai.extractions.push(extraction(self,[{predicate:'favorite_food',value:'dosa',domain:'preferences',quote:'dosa',value_quote:'dosa'}]));
  await memory.remember(actor,'My favorite food is dosa',context,randomUUID());
  await memory.recall(actor,'What is my favorite food?',1);
  const entities=(ai.answerRecords[0] as any).entities;
  expect(entities.filter((e:any)=>e.is_self).map((e:any)=>e.id)).toEqual([self]);
});

it('promotes an already-remembered person instead of duplicating them',async()=>{
  const name=`Nila-${randomUUID()}`,asker=memberActor(await admin.addMember(`Host-${randomUUID()}`));
  const hostSelf=(await memory.snapshot(asker,'')).entities.find(e=>e.is_self)!.id;
  ai.extractions.push(extraction(hostSelf,[{subject_ref:'nila',predicate:'hobby',value:'chess',domain:'preferences',quote:'chess',value_quote:'chess'}],[{ref:'nila',existing_id:null,kind:'person',name,aliases:[]}]));
  await memory.remember(asker,`${name} plays chess`,context,randomUUID());
  const before=(await memory.snapshot(asker,name)).entities.filter(e=>e.name===name);
  expect(before).toHaveLength(1);
  const nila=memberActor(await admin.addMember(name));
  expect((await memory.snapshot(nila,'')).entities.find(e=>e.is_self)!.id).toBe(before[0]!.id);
});

it('re-pairing a draft moves it to the re-pairing member and revokes the old capture token',async()=>{
  const forms=new FormService(memory),owner=`Owner-${randomUUID()}`,a=memberActor(await admin.addMember(owner)),b=memberActor(await admin.addMember(`Helper-${randomUUID()}`));
  const started=await forms.start(a,'Shared form','https://forms.example');
  const paired=await forms.pair(started.pairing_code,'https://forms.example');
  await admin.removeMember(owner);
  const again=await forms.pairAgain(b,started.session_id);
  await expect(forms.pair(again.pairing_code,'https://forms.example')).resolves.toMatchObject({session_id:started.session_id});
  await expect(forms.status(paired.capture_token)).rejects.toMatchObject({code:'invalid_capture_secret'});
});

it('restore pruning removes grants revoked after the export',async()=>{
  const keep=memberActor(await admin.addMember(`Keep-${randomUUID()}`)),drop=memberActor(await admin.addMember(`Drop-${randomUUID()}`));
  const exported=(await admin.memberGrants()).filter(id=>id!==ownerKey(drop));
  expect(await admin.pruneGrants(exported)).toBeGreaterThanOrEqual(1);
  expect(await admin.hasGrant(keep)).toBe(true);
  expect(await admin.hasGrant(drop)).toBe(false);
});

it('marks the single owner as the asker in OIDC/development vaults',async()=>{
  const f=await fixture(admin);
  f.ai.extractions.push(extraction(f.vault,[{predicate:'favorite_color',value:'green',domain:'preferences',quote:'green',value_quote:'green'}]));
  await f.memory.remember(f.actor,'My favorite color is green',context,randomUUID());
  await f.memory.recall(f.actor,'What is my favorite color?',1);
  expect((f.ai.answerRecords[0] as any).entities.filter((e:any)=>e.is_self).map((e:any)=>e.id)).toEqual([f.vault]);
  await f.db.close();
});

it('does not replay another member\'s result for a reused request UUID',async()=>{
  const a=memberActor(await admin.addMember(`UuidA-${randomUUID()}`)),b=memberActor(await admin.addMember(`UuidB-${randomUUID()}`));
  const aSelf=(await memory.snapshot(a,'')).entities.find(e=>e.is_self)!.id,key=randomUUID();
  ai.extractions.push(extraction(aSelf,[{predicate:'favorite_drink',value:'tea',domain:'preferences',quote:'tea',value_quote:'tea'}]));
  await memory.remember(a,'My favorite drink is tea',context,key);
  await expect(memory.remember(b,'My favorite drink is tea',context,key)).rejects.toMatchObject({code:'idempotency_conflict'});
});

it('restore invalidates family-vault capture secrets even without receipts',async()=>{
  const forms=new FormService(memory),actor=memberActor(await admin.addMember(`Restore-${randomUUID()}`));
  const started=await forms.start(actor,'Restored form','https://forms.example');
  expect(await invalidateRestoredFamilyVault(admin)).toBe(true);
  await expect(forms.pair(started.pairing_code,'https://forms.example')).rejects.toMatchObject({code:'invalid_capture_secret'});
});

it('stores only a hashed member key, not the name, on member records',async()=>{
  const name=`Secret-${randomUUID()}`,actor=memberActor(await admin.addMember(name));
  const grant=await admin.read(admin.directory,ownerKey(actor),ownerKey(actor));
  expect(JSON.stringify(grant)).not.toContain(name);
  const self=(await memory.snapshot(actor,'')).entities.find(e=>e.is_self) as any;
  expect(self.member_key).not.toContain(name.toLowerCase());
  expect(await admin.removeMember(name)).toBe(1);
});

it('refuses family-vault form sessions that have no member grant',async()=>{
  const actor=memberActor(await admin.addMember(`Legacy-${randomUUID()}`)),forms=new FormService(memory);
  const started=await forms.start(actor,'Legacy form','https://forms.example');
  await db.withVault(actor,true,tx=>tx.set('form_sessions',started.session_id,{grant:null}));
  await expect(forms.pair(started.pairing_code,'https://forms.example')).rejects.toMatchObject({code:'invalid_capture_secret'});
});
