import { it,expect,vi } from 'vitest';
import { AzureAI } from '../src/ai.js';
import { loadConfig } from '../src/config.js';
import { context,cosmosEnv } from './helpers.js';
const config=()=>loadConfig({NODE_ENV:'test',PUBLIC_URL:'http://localhost:3000',...cosmosEnv,AUTH_MODE:'development',DEV_TOKEN:'x'.repeat(40),
  AZURE_OPENAI_ENDPOINT:'https://memory-example.openai.azure.com',AZURE_OPENAI_CHAT_DEPLOYMENT:'memory-reasoning',AZURE_OPENAI_EMBEDDING_DEPLOYMENT:'memory-embedding',AZURE_OPENAI_API_KEY:'unit-test-key-not-a-secret'});
it('decodes extensible JSON values through a fixed structured-output wire contract',async()=>{
  const response={clarification:null,entities:[],claims:[{subject_ref:'self',predicate:'sleep',object_ref:null,value_json:'{"hours":7,"unit":"hours"}',domain:'health',valid_from:null,valid_to:null,modality:'asserted',qualifiers_json:'{}',quote:'I sleep 7 hours',value_quote:'7 hours',change:'add',replaces:[]}]};
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(response)}}]}),{status:200}));
  const ai=new AzureAI(config(),fetcher as any);
  const result=await ai.extract('I sleep 7 hours',context,{revision:0,entities:[],claims:[],truncated:false});
  expect(result.claims[0]?.value).toEqual({hours:7,unit:'hours'});
  const [url,request]=fetcher.mock.calls[0] as any;
  expect(url).toBe('https://memory-example.openai.azure.com/openai/v1/chat/completions');
  const body=JSON.parse(request.body);expect(body.response_format.json_schema.strict).toBe(true);
  expect(JSON.stringify(body.response_format.json_schema.schema)).not.toContain('$defs');
});
it('batches embeddings, restores response ordering, and rejects missing vectors',async()=>{
  const a=Array(1536).fill(0),b=Array(1536).fill(0);a[0]=1;b[1]=1;
  const fetcher=vi.fn(async()=>new Response(JSON.stringify({data:[{index:1,embedding:b},{index:0,embedding:a}]})));
  const ai=new AzureAI(config(),fetcher as any);
  expect(await ai.embedMany(['first','second'])).toEqual([a,b]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse((fetcher.mock.calls[0] as any)[1].body).input).toEqual(['first','second']);
  await expect(ai.embedMany(['only one'])).rejects.toMatchObject({code:'ai_invalid_embedding'});
});
it('refuses external model endpoints and returns sanitized provider failures',async()=>{
  expect(()=>new AzureAI({...config(),AZURE_OPENAI_ENDPOINT:'https://api.external.example'})).toThrow('Azure-hosted');
  const ai=new AzureAI(config(),(async()=>new Response('sensitive provider error',{status:429})) as any);
  await expect(ai.embed('query')).rejects.toMatchObject({code:'ai_unavailable',status:503});
});
it('rejects truncated model responses instead of committing partial extraction',async()=>{
  const ai=new AzureAI(config(),(async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{"claims":['}}]}))) as any);
  await expect(ai.extract('A statement',context,{revision:0,entities:[],claims:[],truncated:false})).rejects.toMatchObject({code:'ai_incomplete'});
});
