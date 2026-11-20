import 'dotenv/config';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const base=(process.env.PUBLIC_URL??'http://localhost:7071').replace(/\/$/,'');
const token=process.env.MCP_ACCESS_TOKEN??process.env.DEV_TOKEN;
if(!token)throw new Error('Set MCP_ACCESS_TOKEN, or DEV_TOKEN for a local-only smoke test.');
assert.equal((await fetch(base+'/healthz')).status,200);
const metadata=await(await fetch(base+'/.well-known/oauth-protected-resource/mcp')).json();
assert.equal(metadata.resource,base+'/mcp');
const client=new Client({name:'functions-host-smoke',version:'1.0.0'});
try{
  await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
  const tools=(await client.listTools()).tools;
  assert(tools.some(tool=>tool.name==='remember'));assert(tools.some(tool=>tool.name==='decide_change'));
  const result=await client.callTool({name:'whoami',arguments:{}});
  assert(!result.isError);
  console.log(`Functions host verified: health, OAuth discovery, SDK initialization, ${tools.length} tools, verified identity tool.`);
}finally{await client.close();}
