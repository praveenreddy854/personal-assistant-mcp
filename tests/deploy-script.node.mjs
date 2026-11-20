import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm,readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deploy,parseOptions,initializationEnvironment } from '../scripts/deploy-azure.mjs';
async function withParameters(run){const dir=await mkdtemp(join(tmpdir(),'memory-deploy-'));try{const file=join(dir,'params.json');await writeFile(file,JSON.stringify({parameters:{location:{value:'eastus2'},modelResourceName:{value:'existing-model'},modelResourceGroup:{value:'model-rg'},authAudience:{value:'private-value'}}}));return await run(file);}finally{await rm(dir,{recursive:true,force:true});}}
function runner(calls,overrides={}){return (command,args,options)=>{
  calls.push({command,args,options});
  if(overrides[args[0]])return overrides[args[0]](args);
  if(args[0]==='provider')return 'Registered';
  if(args[0]==='deployment'&&args[2]==='create')return JSON.stringify({functionAppName:{value:'memory-func'},mcpUrl:{value:'https://memory-func.azurewebsites.net/mcp'},cosmosEndpoint:{value:'https://memory.documents.azure.com/'}});
  if(args.includes('defaultHostName'))return 'memory-func.azurewebsites.net';return '';
};}
test('dry run executes nothing and does not print parameter values',()=>withParameters(async file=>{
  const logs=[];await deploy(['--resource-group','memory-test','--parameters',file,'--dry-run'],{runner(){throw new Error('executed command');},log:line=>logs.push(line)});
  assert(logs.join('\n').includes('config-zip'));assert(!logs.join('\n').includes('private-value'));
}));
test('full deployment validates and uses Cosmos outputs before publishing with serving paused',()=>withParameters(async file=>{
  const calls=[];const result=await deploy(['--resource-group','rg','--parameters',file,'--subscription','sub-1','--location','centralus','--skip-tests'],{runner:runner(calls),log(){},verifyArchive:async()=>{}});
  assert.equal(result.cosmosEndpoint,'https://memory.documents.azure.com/');
  const validate=calls.findIndex(c=>c.args[0]==='deployment'&&c.args[2]==='validate'),create=calls.findIndex(c=>c.args[0]==='deployment'&&c.args[2]==='create');
  assert(validate>=0&&validate<create);assert(calls[create].args.includes('location=centralus'));assert(calls[validate].args.includes('location=centralus'));
  assert(calls.find(c=>c.args[0]==='cognitiveservices').args.includes('model-rg'));
  assert(calls.filter(c=>c.command==='az').every(c=>c.args.includes('sub-1')));
  assert(calls.find(c=>c.args.includes('config-zip')).args.includes('memory-func'));
  assert(!calls.some(c=>c.args.includes('SERVING_ENABLED=true')||c.args.includes('postgres')));
}));
test('code-only leaves infrastructure and serving unchanged',async()=>{
  const calls=[];await deploy(['--resource-group','rg','--code-only','--function-app','memory-func','--skip-tests'],{runner:runner(calls),log(){},verifyArchive:async()=>{}});
  assert(!calls.some(c=>c.args[0]==='deployment'||c.args.includes('appsettings')));assert(calls.some(c=>c.args.includes('config-zip')));
});
test('enabling requires explicit readiness; initialization requires a verified remote endpoint',()=>{
  assert.throws(()=>parseOptions(['--resource-group','rg','--code-only','--function-app','app','--enable-serving']),/store-ready/);
  assert.throws(()=>parseOptions(['--resource-group','rg','--code-only','--function-app','app','--initialize']),/cosmos-endpoint/);
  assert.throws(()=>initializationEnvironment({},'http://localhost:8081',{}),/HTTPS/);
  assert.throws(()=>initializationEnvironment({},'https://memory.documents.azure.com/',{COSMOS_ENDPOINT:'http://localhost:8081'}),/must target/);
  assert.throws(()=>initializationEnvironment({},'https://memory.documents.azure.com/',{COSMOS_KEY:'secret'}),/Entra/);
});
test('initialization runs before publishing and serving is enabled only at the end',()=>withParameters(async file=>{
  const calls=[];await deploy(['--resource-group','rg','--parameters',file,'--initialize','--enable-serving','--skip-tests'],{env:{},runner:runner(calls),log(){},verifyArchive:async()=>{}});
  const init=calls.findIndex(c=>c.args.includes('db:initialize')),publish=calls.findIndex(c=>c.args.includes('config-zip')),enable=calls.findIndex(c=>c.args.includes('SERVING_ENABLED=true'));
  assert(init>=0&&init<publish&&publish<enable);assert.equal(calls[init].options.env.COSMOS_ENDPOINT,'https://memory.documents.azure.com/');
}));
test('unregistered Functions provider stops before builds or mutations',()=>withParameters(async file=>{
  const calls=[];await assert.rejects(deploy(['--resource-group','rg','--parameters',file],{runner:runner(calls,{provider:()=> 'NotRegistered'}),log(){}}),/Register Microsoft.App/);
  assert(!calls.some(c=>c.command==='npm'||c.args[0]==='group'||c.args[0]==='deployment'));
}));
test('region change refuses an in-place move of existing networking',()=>withParameters(async file=>{
  const calls=[];await assert.rejects(deploy(['--resource-group','rg','--parameters',file,'--location','centralus'],{runner:runner(calls,{group:()=> 'true',resource:()=>JSON.stringify([{name:'personalmemory-vnet',type:'Microsoft.Network/virtualNetworks',location:'eastus2'}])}),log(){}}),/cannot be moved/);
  assert(!calls.some(c=>c.command==='npm'||c.args[0]==='deployment'));
}));
test('Cosmos infrastructure enforces private keyless storage and scoped runtime permissions',async()=>{
  const template=await readFile(new URL('../infra/main.bicep',import.meta.url),'utf8');
  for(const required of ["name: 'EnableServerless'","name: 'EnableNoSQLVectorSearch'","defaultConsistencyLevel: 'Strong'","disableLocalAuth: true","publicNetworkAccess: 'Disabled'","scope: '${cosmos.id}/dbs/${database.name}/colls/${vaults.name}'","scope: '${cosmos.id}/dbs/${database.name}/colls/${identities.name}'","paths: ['/vault_id']","dimensions: 1536"])assert(template.includes(required),required);
  assert(!template.includes('postgresAdminPassword'));assert(!template.includes('Microsoft.KeyVault'));
});
