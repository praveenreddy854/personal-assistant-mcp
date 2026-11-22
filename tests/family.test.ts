import { afterAll,beforeAll,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database,memberActor } from '../src/db.js';
import { MemoryService } from '../src/memory.js';
import { ScriptedAI,context,extraction,options,setupDatabase,cosmosEnv } from './helpers.js';
import { FormService } from '../src/forms.js';
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
