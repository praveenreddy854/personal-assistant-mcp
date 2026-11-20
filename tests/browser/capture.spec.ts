import { test,expect,chromium,type BrowserContext,type Page,type Worker } from '@playwright/test';
import { mkdtemp,cp,readFile,writeFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import type { Database } from '../../src/db.js';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { cosmosEnv,context as sourceContext,extraction,fixture,setupDatabase,rows } from '../helpers.js';

let browser:BrowserContext,popup:Page,worker:Worker,admin:Database,f:Awaited<ReturnType<typeof fixture>>,apiServer:Server,webServer:Server,base:string,origin:string,temp:string,offline=false;
const listen=async(app:ReturnType<typeof express>)=>{const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));return server;};
const url=(server:Server)=>`http://127.0.0.1:${(server.address() as any).port}`;
test.beforeAll(async()=>{
  admin=await setupDatabase();f=await fixture(admin);
  const config=loadConfig({NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1:3000',...cosmosEnv,AUTH_MODE:'development',DEV_TOKEN:'x'.repeat(40)});
  const api=express();api.use((req,res,next)=>{if(offline&&req.path==='/api/capture/events')res.status(503).json({message:'Test network interruption'});else next();});
  api.use(createApp(config,f.memory,{authenticate:async()=>f.actor}));apiServer=await listen(api);base=url(apiServer);config.PUBLIC_URL=base;
  const site=express();site.get('/intake',(_req,res)=>res.send(`<!doctype html><html><body><h1>Medical intake fixture</h1><form id="intake">
    <label for="name">Full name</label><input id="name" name="name"><label for="birth">Date of birth</label><input id="birth">
    <label for="count">Dependents</label><input id="count" type="number" value="0">
    <label><input id="smokes" type="checkbox">Smokes</label>
    <label for="choice">Preferred contact</label><select id="choice"><option value="email">Email</option><option value="phone">Phone</option></select>
    <label for="notes">Notes</label><textarea id="notes"></textarea>
    <input id="secret" type="password" value="do-not-capture-password"><input id="csrf" type="hidden" value="do-not-capture-hidden">
    <div id="shadow-host"></div><iframe src="/contact"></iframe></form>
    <script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<label for="sleep">Sleep hours</label><input id="sleep" type="number" value="7">';</script>
    </body></html>`));
  site.get('/contact',(_req,res)=>res.send('<label for="phone">Contact phone</label><input id="phone" type="tel">'));
  webServer=await listen(site);origin=url(webServer);
  temp=await mkdtemp(join(tmpdir(),'personal-memory-browser-'));const extension=join(temp,'extension');await cp(resolve('extension'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  // Test-only permissions avoid automating Chrome's native permission dialog.
  manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  browser=await chromium.launchPersistentContext(join(temp,'profile'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  worker=browser.serviceWorkers()[0]??await browser.waitForEvent('serviceworker');
  const id=new URL(worker.url()).host;popup=await browser.newPage();await popup.goto(`chrome-extension://${id}/popup.html`);
});
test.afterAll(async()=>{
  await browser?.close();if(apiServer)await new Promise<void>(r=>apiServer.close(()=>r()));if(webServer)await new Promise<void>(r=>webServer.close(()=>r()));
  await f?.db.close();await admin?.close();if(temp)await rm(temp,{recursive:true,force:true});
});
async function begin(){
  const page=await browser.newPage();await page.goto(origin+'/intake');
  const session=await f.forms.start(f.actor,'Medical intake',origin);
  const tabId=await worker.evaluate(async pageUrl=>(await chrome.tabs.query({url:pageUrl})).at(-1).id,origin+'/intake');
  const response=await popup.evaluate(data=>chrome.runtime.sendMessage({type:'capture:start',...data}),{server:base,code:session.pairing_code,tabId,pageOrigin:origin});
  expect(response).toEqual({ok:true});return {page,session};
}
test('real extension captures manual, programmatic, shadow-root and same-origin frame changes; buffers offline and checkpoints final values',async()=>{
  const {page,session}=await begin();
  await page.locator('#name').fill('Alex');await page.locator('#notes').fill('Sleep follow-up');
  await page.locator('#choice').selectOption('phone');await page.locator('#smokes').check();
  await page.locator('#sleep').fill('8');await page.frameLocator('iframe').locator('#phone').fill('555-0100');
  await expect.poll(async()=>(await f.forms.get(f.actor,session.session_id)).fields.find(x=>x.label==='Full name')?.value).toBe('Alex');
  await expect.poll(async()=>(await f.forms.get(f.actor,session.session_id)).fields.find(x=>x.label==='Contact phone')?.value).toBe('555-0100');
  const fields=(await f.forms.get(f.actor,session.session_id)).fields;
  expect(fields.some(x=>x.value==='do-not-capture-password'||x.value==='do-not-capture-hidden')).toBe(false);
  expect(fields.find(x=>x.label==='Dependents')?.value).toBe('0');expect(fields.find(x=>x.label==='Sleep hours')?.value).toBe('8');
  const unrelated=await browser.newPage();await unrelated.goto(origin+'/intake');await unrelated.locator('#name').fill('Other tab private');
  await page.evaluate(()=>{(document.getElementById('notes') as HTMLTextAreaElement).value='Programmatic change';});
  await expect.poll(async()=>(await f.forms.get(f.actor,session.session_id)).fields.find(x=>x.label==='Notes')?.value).toBe('Programmatic change');
  expect(JSON.stringify((await f.forms.get(f.actor,session.session_id)).fields)).not.toContain('Other tab private');
  offline=true;await page.locator('#name').fill('Alexandra');
  await expect.poll(()=>popup.evaluate(()=>chrome.runtime.sendMessage({type:'capture:status'})).then(s=>s.pending)).toBeGreaterThan(0);
  offline=false;
  await expect.poll(async()=>(await f.forms.get(f.actor,session.session_id)).fields.find(x=>x.label==='Full name')?.value,{timeout:12000}).toBe('Alexandra');
  expect((await f.forms.finalize(f.actor,session.session_id,sourceContext,randomUUID()) as any).status).toBe('awaiting_final_snapshot');
  await expect.poll(async()=>await f.db.withVault(f.actor,false,async tx=>{const s=await tx.get('form_sessions',session.session_id);return s.checkpoint_revision===s.revision;}),{timeout:12000}).toBe(true);
  const name=(await f.forms.get(f.actor,session.session_id)).fields.find(x=>x.label==='Full name')!;
  f.ai.extractions.push(extraction(f.vault,[{predicate:'name',value:'Alexandra',quote:`Full name [${name.field_key}]: "Alexandra"`,value_quote:'Alexandra'}]));
  expect((await f.forms.finalize(f.actor,session.session_id,sourceContext,randomUUID()) as any).status).toBe('saved');
  await page.close();await unrelated.close();
});
test('propagates forgetting into the offline capture queue and prevents the active page from reintroducing that field',async()=>{
  f.ai.extractions.push(extraction(f.vault,[{predicate:'date_of_birth',value:'May 12',quote:'Birthday May 12',value_quote:'May 12'}]));
  const saved=await f.memory.remember(f.actor,'Birthday May 12',sourceContext,randomUUID()) as any;
  const {page,session}=await begin();await page.locator('#birth').fill('May 12');
  await expect.poll(async()=>(await f.forms.get(f.actor,session.session_id)).fields.find(x=>x.label==='Date of birth')?.value).toBe('May 12');
  offline=true;await page.locator('#birth').fill('May 21');
  await expect.poll(()=>popup.evaluate(()=>chrome.runtime.sendMessage({type:'capture:status'})).then(s=>s.pending)).toBeGreaterThan(0);
  const proposal=await f.memory.proposeForget(f.actor,saved.claim_ids,'Forget birthday');await f.memory.decide(f.actor,proposal.proposal_id,'approve','Forget birthday');
  await expect.poll(()=>popup.evaluate(()=>chrome.runtime.sendMessage({type:'capture:status'})).then(s=>s.pending),{timeout:12000}).toBe(0);
  offline=false;await page.locator('#birth').fill('May 30');await page.locator('#notes').fill('Still capture unrelated fields');
  await expect.poll(async()=>(await f.forms.get(f.actor,session.session_id)).fields.find(x=>x.label==='Notes')?.value,{timeout:12000}).toBe('Still capture unrelated fields');
  expect((await f.forms.get(f.actor,session.session_id)).fields.some(x=>x.label==='Date of birth')).toBe(false);
  await popup.evaluate(()=>chrome.runtime.sendMessage({type:'capture:stop'}));await page.close();
});
