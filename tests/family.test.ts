import { afterAll,beforeAll,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Database,memberActor } from '../src/db.js';
import { MemoryService } from '../src/memory.js';
import { ScriptedAI,context,extraction,options,setupDatabase } from './helpers.js';

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
