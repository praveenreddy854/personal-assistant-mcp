import { beforeAll,afterAll,it,expect } from 'vitest';
import type { Server } from 'node:http';
import type { Database } from '../src/db.js';
import { randomUUID } from 'node:crypto';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { authenticator } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { context,extraction,fixture,setupDatabase,cosmosEnv } from './helpers.js';
let admin:Database,f:Awaited<ReturnType<typeof fixture>>,server:Server,base:string,token:string,sign:(aud?:string,scope?:string)=>Promise<string>;
beforeAll(async()=>{
  admin=await setupDatabase();f=await fixture(admin,'https://identity.example');
  const keys=await generateKeyPair('RS256'),jwk=await exportJWK(keys.publicKey);jwk.kid='test';
  sign=(aud='memory-api',scope='memory.access')=>new SignJWT({oid:f.actor.subject,azp:f.actor.clientId,scp:scope}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(f.actor.issuer).setAudience(aud).setSubject('pairwise-subject').setIssuedAt().setExpirationTime('10m').sign(keys.privateKey);
  token=await sign();
  const config=loadConfig({NODE_ENV:'test',PUBLIC_URL:'http://127.0.0.1:3000',...cosmosEnv,AUTH_MODE:'oidc',AUTH_ISSUER:f.actor.issuer,AUTH_AUDIENCE:'memory-api',AUTH_JWKS_URL:'https://identity.example/keys',AUTHORIZATION_SERVER:f.actor.issuer});
  const app=createApp(config,f.memory,{authenticate:authenticator(config,createLocalJWKSet({keys:[jwk]}))});
  server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${(server.address() as any).port}`;config.PUBLIC_URL=base;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await f.db.close();await admin.close();});
it('publishes discovery, rejects missing or invalid tokens and enforces the audience/scope',async()=>{
  const discovery=await fetch(base+'/.well-known/oauth-protected-resource/mcp');
  expect(discovery.status).toBe(200);expect((await discovery.json()).resource).toBe(base+'/mcp');
  const unauthorized=await fetch(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  expect(unauthorized.status).toBe(401);expect(unauthorized.headers.get('www-authenticate')).toContain('resource_metadata');
  expect((await fetch(base+'/api/identity',{headers:{Authorization:'Bearer forged'}})).status).toBe(401);
  expect((await fetch(base+'/api/identity',{headers:{Authorization:`Bearer ${await sign('wrong-audience')}`}})).status).toBe(401);
  expect((await fetch(base+'/api/identity',{headers:{Authorization:`Bearer ${await sign('memory-api','other')}`}})).status).toBe(403);
});
it('uses the stable verified owner ID and rejects unapproved browser origins',async()=>{
  expect(await (await fetch(base+'/api/identity',{headers:{Authorization:`Bearer ${token}`}})).json()).toMatchObject({issuer:f.actor.issuer,subject:f.actor.subject});
  expect((await fetch(base+'/api/identity',{headers:{Authorization:`Bearer ${token}`,Origin:'https://evil.example'}})).status).toBe(403);
});
it('serves real SDK initialization, tool discovery, remember and recall over Streamable HTTP',async()=>{
  const client=new Client({name:'integration-client',version:'1.0.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  try{
    expect((await client.listTools()).tools.map(tool=>tool.name)).toContain('finalize_form');
    f.ai.extractions.push(extraction(f.vault,[{predicate:'name',value:'Alex',quote:'Name Alex',value_quote:'Alex'}]));
    const result=await client.callTool({name:'remember',arguments:{text:'Name Alex',context,idempotency_key:randomUUID()}}) as any;
    expect(result.isError).not.toBe(true);expect(result.structuredContent.status).toBe('saved');
    const recalled=await client.callTool({name:'recall',arguments:{question:'What is my name?',level:0}}) as any;
    expect(recalled.structuredContent.evidence).toHaveLength(1);
    expect(recalled.structuredContent.claims[0].value).toBe('Alex');
    expect(JSON.stringify(recalled)).not.toContain('embedding');
  }finally{await client.close();}
});
it('does not permit development auth in a production or public deployment',()=>{
  expect(()=>loadConfig({PUBLIC_URL:'https://memory.example',...cosmosEnv,AUTH_MODE:'development',DEV_TOKEN:'x'.repeat(40)})).toThrow('Development authentication');
});
