import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.js';
import { authenticator } from './auth.js';
import { ContextSchema, FieldSchema, type Actor } from './models.js';
import { MemoryService } from './memory.js';
import { FormService } from './forms.js';
import { MemoryError, requireThat } from './errors.js';

const requestKey=z.uuid();
function toolError(error:unknown) {
  if(error instanceof MemoryError) return {code:error.code,message:error.message,retryable:['concurrent_change','stale_proposal','ai_unavailable','stale_form'].includes(error.code)};
  if(error instanceof z.ZodError) return {code:'invalid_input',message:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')};
  return {code:'internal_error',message:'The operation could not be completed. No success is implied; retry idempotent writes with the same key.'};
}
export function createMcp(actor:Actor,memory:MemoryService,forms:FormService) {
  const server=new McpServer({name:'personal-memory',version:'0.1.0'}, {instructions:`Private personal memory with shared access across authorized agents.
Use remember only for explicit memory requests. Pass original user wording, its timestamp/timezone, and relevant context. Never manufacture source evidence.
New facts save automatically. Existing facts and deletion require a concrete proposal. A direct user instruction counts as approval only when it explicitly covers the target and exact change. Otherwise show the preview and ask. Relay the actual human message with decide_change; never generate approval yourself.
Recall returns evidence-backed answers; preserve missing information, conflicts, dates, and uncertainty. Do not treat L0/L1 summaries as exact form facts.
For form filling, start_form and pair the browser integration so manual edits are captured. Drafts do not establish personal facts. Finalize when the user says answers are final, independent of submission. Await the extension's final snapshot and any required edit approval.`});
  const run=async (fn:()=>Promise<unknown>)=>{
    try { const result=await fn(); return {content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result as Record<string,unknown>}; }
    catch(error) { return {isError:true,content:[{type:'text' as const,text:JSON.stringify(toolError(error))}]}; }
  };
  server.registerTool('whoami',{
    description:'Show the verified memory identity for pilot invitation. This does not expose a token or any vault contents.',
    inputSchema:{},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },()=>run(async()=>({issuer:actor.issuer,subject:actor.subject,instruction:'The pilot administrator can invite this stable identity with the invite command.'})));
  server.registerTool('remember',{
    description:'Remember an original user statement. Service interprets it and saves supported new facts. Edits return an exact approval proposal; pending facts are excluded from recall. Reuse the same idempotency key when retrying.',
    inputSchema:{text:z.string().min(1).max(100000),context:ContextSchema,idempotency_key:requestKey},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },args=>run(()=>memory.remember(actor,args.text,args.context,args.idempotency_key)));
  server.registerTool('recall',{
    description:'Answer a memory question with supporting claims, source quotations, dates, conflicts, and gaps. L0=overview, L1=domain context, L2=exact records for forms. Use include_corrections only for an explicit revision-history request. Returns claim IDs for precisely scoped edits/forgetting.',
    inputSchema:{question:z.string().min(1).max(4000),level:z.number().int().min(0).max(2).default(2),domain:z.string().max(80).optional(),as_of:z.iso.date().optional(),include_corrections:z.boolean().default(false)},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },args=>run(()=>memory.recall(actor,args.question,args.level,args)));
  server.registerTool('forget',{
    description:'Propose forgetting precisely selected claim IDs, including their corrected versions and source value spans. Resolve scope through recall first. Always inspect the preview; a broader proposal than the original user instruction needs separate permission. Does not delete until decide_change approves.',
    inputSchema:{claim_ids:z.array(z.uuid()).min(1).max(100),user_request:z.string().min(1).max(4000)},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
  },args=>run(()=>memory.proposeForget(actor,args.claim_ids,args.user_request)));
  server.registerTool('decide_change',{
    description:'Relay the human decision for an existing proposal from this same client. A fully specified direct user edit/forget instruction counts as approval; otherwise first show the preview and ask. Supply the actual user message. This channel trusts the authorized agent to convey human intent faithfully. You cannot alter the approved payload.',
    inputSchema:{proposal_id:z.uuid(),decision:z.enum(['approve','reject']),user_message:z.string().min(1).max(4000)},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:true,openWorldHint:false}
  },args=>run(()=>memory.decide(actor,args.proposal_id,args.decision,args.user_message)));
  server.registerTool('discard_form',{
    description:'Propose deleting an entire captured form and its revisions, including unclassified drafts. Facts supported exclusively by this form are included in the preview; independently supported facts remain. Requires chat approval through decide_change.',
    inputSchema:{session_id:z.uuid(),user_request:z.string().min(1).max(4000)},
    annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:false}
  },args=>run(()=>memory.proposeDiscardForm(actor,args.session_id,args.user_request)));
  server.registerTool('start_form',{
    description:'Begin explicit capture for one form, one subject, and one exact website origin. Returns a one-use pairing code for the capture extension; no website submission occurs. Subject defaults to the vault owner.',
    inputSchema:{title:z.string().min(1).max(500),page_origin:z.url(),subject_id:z.uuid().optional()},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },args=>run(()=>forms.start(actor,args.title,args.page_origin,args.subject_id)));
  server.registerTool('record_form_fields',{
    description:'Checkpoint field changes made through the agent into an existing draft form. Browser integration captures manual changes as well. Use unique event IDs and increasing per-device sequence numbers. Blanks remain captured but never erase personal facts.',
    inputSchema:{session_id:z.uuid(),events:z.array(FieldSchema).min(1).max(100)},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },args=>run(()=>forms.captureFromAgent(actor,args.session_id,{events:args.events})));
  server.registerTool('pair_form',{
    description:'Issue a new one-use pairing code to resume capture of an existing draft form after a browser restart or expired pairing code. Pairing replaces the previous capture token.',
    inputSchema:{session_id:z.uuid()},annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}
  },args=>run(()=>forms.pairAgain(actor,args.session_id)));
  server.registerTool('get_form',{
    description:'Retrieve captured values and draft/final status for a form session in this vault. Draft entries are not reusable personal facts.',
    inputSchema:{session_id:z.uuid()},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },args=>run(()=>forms.get(actor,args.session_id)));
  server.registerTool('finalize_form',{
    description:'The user says form answers are final. First requests an extension snapshot; retry after checkpoint. Promote supported facts from finalized fields. Existing-fact changes return an approval proposal. Completion does not submit the form. Retry with the same idempotency key.',
    inputSchema:{session_id:z.uuid(),context:ContextSchema,idempotency_key:requestKey},
    annotations:{readOnlyHint:false,destructiveHint:false,idempotentHint:true,openWorldHint:false}
  },args=>run(()=>forms.finalize(actor,args.session_id,args.context,args.idempotency_key)));
  return server;
}

export function createApp(config:Config,memory:MemoryService,options:{authenticate?:(req:Request)=>Promise<Actor>}={}) {
  const app=express(),forms=new FormService(memory),authenticate=options.authenticate??authenticator(config);
  app.disable('x-powered-by');
  app.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});next();});
  app.use(express.json({limit:'2mb'}));
  const origins=new Set([config.PUBLIC_URL,...config.ALLOWED_ORIGINS.split(',').filter(Boolean)]);
  app.use((req,res,next)=>{
    const origin=req.header('Origin');
    if(origin && origins.has(origin)) res.set({'Access-Control-Allow-Origin':origin,'Vary':'Origin','Access-Control-Allow-Headers':'Authorization,Content-Type,MCP-Protocol-Version,Mcp-Session-Id','Access-Control-Allow-Methods':'GET,POST,OPTIONS,DELETE'});
    if(req.method==='OPTIONS') {res.status(origin && !origins.has(origin)?403:204).end();return;}
    next();
  });
  app.get('/healthz',(_req,res)=>res.json({status:'ok'}));
  app.get(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp'],(_req,res)=>{
    requireThat(config.AUTH_MODE==='development'||config.AUTHORIZATION_SERVER,'serving_paused','OAuth configuration is pending; memory serving remains paused.',503);
    res.json({
    resource:`${config.PUBLIC_URL}/mcp`,authorization_servers:[config.AUTHORIZATION_SERVER??'https://example.invalid/local-only'],
    scopes_supported:[config.AUTH_REQUEST_SCOPE??config.AUTH_SCOPE],bearer_methods_supported:['header'],resource_name:'Private personal memory'
    });
  });
  app.use((_req,_res,next)=>{
    try {requireThat(config.servingEnabled,'serving_paused','Memory serving is paused for initialization or restore verification.',503);next();}catch(error){next(error);}
  });
  const captureToken=(req:Request)=>{
    const token=/^Bearer (\S+)$/.exec(req.header('Authorization')??'')?.[1];
    requireThat(token,'unauthorized','A session-scoped capture token is required.',401);return token;
  };
  app.post('/api/capture/pair',async(req,res)=>{
    const input=z.object({pairing_code:z.string().min(40).max(128),page_origin:z.url()}).parse(req.body);
    res.json(await forms.pair(input.pairing_code,input.page_origin));
  });
  app.post('/api/capture/events',async(req,res)=>res.json(await forms.capture(captureToken(req),req.body)));
  app.get('/api/capture/status',async(req,res)=>res.json(await forms.status(captureToken(req))));
  app.post('/api/capture/checkpoint',async(req,res)=>{
    const input=z.object({challenge:z.uuid(),pending_count:z.number().int().nonnegative()}).parse(req.body);
    res.json(await forms.checkpoint(captureToken(req),input.challenge,input.pending_count));
  });
  const identity=async(req:Request,res:Response,next:NextFunction)=>{
    try {
      const origin=req.header('Origin');
      requireThat(!origin || origins.has(origin),'origin_forbidden','This browser origin is not allowed.',403);
      res.locals.actor=await authenticate(req); next();
    } catch(error) {next(error);}
  };
  app.get('/api/identity',identity,(req,res)=>res.json({issuer:res.locals.actor.issuer,subject:res.locals.actor.subject,
    instruction:'Give this stable identity to the pilot administrator for invitation. No vault data is available until invited.'}));
  app.use('/mcp',identity);
  app.post('/mcp',async(req,res,next)=>{
    const server=createMcp(res.locals.actor,memory,forms);
    const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
    res.on('close',()=>{void transport.close();void server.close();});
    try {await server.connect(transport);await transport.handleRequest(req,res,req.body);} catch(error) {next(error);}
  });
  app.all('/mcp',(_req,res)=>res.status(405).set('Allow','POST').json({error:'This endpoint uses stateless Streamable HTTP POST requests.'}));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(res.headersSent) return;
    const status=error instanceof MemoryError?error.status:error instanceof z.ZodError?400:500;
    if((status===401 || status===403) && config.AUTH_MODE==='oidc') res.set('WWW-Authenticate',`Bearer resource_metadata="${config.PUBLIC_URL}/.well-known/oauth-protected-resource/mcp", scope="${config.AUTH_REQUEST_SCOPE??config.AUTH_SCOPE}"`);
    res.status(status).json(toolError(error));
  });
  return app;
}
