import { it,expect } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { MemoryService } from '../src/memory.js';
const environment={NODE_ENV:'production',PUBLIC_URL:'https://memory.example',COSMOS_ENDPOINT:'https://memory.documents.azure.com/',AUTH_MODE:'oidc'};
it('exposes health during bootstrap while blocking every memory/capture path and incomplete OAuth discovery',async()=>{
  const config=loadConfig({...environment,SERVING_ENABLED:'false',AUTH_ISSUER:'',AUTH_AUDIENCE:'',AUTH_JWKS_URL:'',AUTHORIZATION_SERVER:''});
  const app=createApp(config,new Proxy({} as MemoryService,{get(){throw new Error('Paused server touched memory');}}));
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
  try{
    const base=`http://127.0.0.1:${(server.address() as any).port}`;
    expect((await fetch(base+'/healthz')).status).toBe(200);
    for(const [method,path] of [['POST','/mcp'],['GET','/api/identity'],['POST','/api/capture/pair'],['POST','/api/capture/events'],['GET','/api/capture/status'],['POST','/api/capture/checkpoint'],['GET','/.well-known/oauth-protected-resource/mcp']]){
      const response=await fetch(base+path,{method,headers:{Authorization:'Bearer forged'}});
      expect(response.status,path).toBe(503);expect((await response.json()).code).toBe('serving_paused');
    }
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('still requires complete trusted OIDC configuration before enabling serving',()=>{
  expect(()=>loadConfig({...environment,SERVING_ENABLED:'true'})).toThrow('AUTH_ISSUER is required');
  expect(()=>loadConfig({...environment,SERVING_ENABLED:'false',AUTH_JWKS_URL:'http://insecure.example/keys'})).toThrow('AUTH_JWKS_URL must use HTTPS');
});
