import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Actor, Context, Field, SourceInput } from './models.js';
import { CaptureSchema } from './models.js';
import { MemoryService } from './memory.js';
import { requireThat } from './errors.js';
import { fieldId,type Tx } from './db.js';
const now=()=>new Date().toISOString();
const secret=(vault:string,id:string)=>`${vault}.${id}.${randomBytes(32).toString('base64url')}`;

const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
export class FormService {
  constructor(public memory: MemoryService) {}
  async start(actor: Actor,title: string,pageOrigin: string,subjectId?:string) {
    const url=new URL(pageOrigin);
    requireThat(url.origin===pageOrigin && (url.protocol==='https:' || ['localhost','127.0.0.1'].includes(url.hostname)),
      'invalid_origin','Use an exact HTTPS page origin, or localhost for development.');
    return this.memory.db.withVault(actor,true,async tx=>{
      const subject=subjectId??tx.self??(await tx.find('entities',{where:{is_self:true},limit:1}))[0]?.id;
      requireThat(subject&&await tx.get('entities',subject),'not_found','The form subject is not in this vault.',404);
      const id=randomUUID(),pair=secret(tx.vault,id);
      await tx.put('form_sessions',id,{subject_id:subject,grant:tx.grant??null,title,page_origin:pageOrigin,pair_hash:digest(pair),pair_expires:new Date(Date.now()+600000).toISOString(),capture_hash:null,capture_expires:null,status:'draft',revision:0,checkpoint_revision:null,checkpoint_at:null,snapshot_challenge:null,submission_status:'unknown'});
      return {session_id:id,pairing_code:pair,pairing_expires_in_seconds:600,
        instruction:'Open the capture extension on this form tab, enter the server URL and this one-time pairing code, and start capture. Only this origin and tab are captured. Finalize when the user says the answers are final.'};
    });
  }
  async pair(code:string,pageOrigin:string) {
    return this.memory.db.withSessionSecret(code,true,async (tx,session)=>{
      requireThat(session.page_origin===pageOrigin,'wrong_origin','This pairing code belongs to a different website.',403);
      const token=secret(tx.vault,session.id);
      await tx.set('form_sessions',session.id,{pair_hash:null,capture_hash:digest(token),capture_expires:new Date(Date.now()+86400000).toISOString()});
      return {session_id:session.id,capture_token:token,page_origin:session.page_origin,expires_in_seconds:86400};
    });
  }
  async pairAgain(actor:Actor,id:string) {
    return this.memory.db.withVault(actor,true,async tx=>{
      const session=await tx.get('form_sessions',id);
      requireThat(session?.status==='draft','not_found','Only an existing draft form can be paired again.',404);
      const code=secret(tx.vault,id);
      // Re-pairing hands a family draft to the member doing it and invalidates the previous capture token.
      await tx.set('form_sessions',id,{pair_hash:digest(code),pair_expires:new Date(Date.now()+600000).toISOString(),
        ...(tx.grant?{grant:tx.grant,capture_hash:null,capture_expires:null}:{})});
      return {session_id:id,pairing_code:code,pairing_expires_in_seconds:600};
    });
  }
  private async writeEvents(tx:Tx,session:any,events:Field[]) {
    let revision=session.revision as number,accepted=0;
    for(const event of events){
      const id=fieldId(session.id,event.field_key);
      requireThat(!await tx.get('field_tombstones',id),'forgotten_field','This field was forgotten. Old capture events cannot restore it; begin a new session for an explicit reintroduction.',409);
      const replay=await tx.get('form_revisions',event.event_id);
      if(replay){
        requireThat(replay.session_id===session.id&&replay.field_key===event.field_key&&replay.device_id===event.device_id&&replay.sequence===event.sequence&&JSON.stringify(replay.value)===JSON.stringify(event.value),'event_conflict','A capture event ID was reused for different data.',409);continue;
      }
      const old=await tx.get('form_fields',id);
      requireThat(!old||event.sequence>Number(old.clocks[event.device_id]??-1),'out_of_order','An older capture event cannot replace newer field data.',409);
      if(!old||JSON.stringify(old.value)!==JSON.stringify(event.value)||old.label!==event.label)revision++;
      await tx.put('form_fields',id,{session_id:session.id,field_key:event.field_key,label:event.label,value:event.value,input_type:event.input_type,page_path:event.page_path,origin:event.origin,clocks:{...old?.clocks,[event.device_id]:event.sequence},revision,observed_at:event.observed_at});
      await tx.put('form_revisions',event.event_id,{session_id:session.id,field_key:event.field_key,event_id:event.event_id,device_id:event.device_id,sequence:event.sequence,value:event.value,origin:event.origin,observed_at:event.observed_at});accepted++;
    }
    await tx.set('form_sessions',session.id,{revision,...(revision!==session.revision?{checkpoint_revision:null}:{})});
    return {status:'captured',accepted,revision};
  }
  async capture(token:string,input:unknown) {
    const {events}=CaptureSchema.parse(input);
    return this.memory.db.withSessionSecret(token,false,(tx,session)=>this.writeEvents(tx,session,events));
  }
  async captureFromAgent(actor:Actor,id:string,input:unknown) {
    const {events}=CaptureSchema.parse(input);
    return this.memory.db.withVault(actor,true,async tx=>{
      const session=await tx.get('form_sessions',id);
      requireThat(session?.status==='draft','not_found','The draft form session does not exist in this vault.',404);
      return this.writeEvents(tx,session,events);
    });
  }
  async status(token:string) {
    return this.memory.db.withSessionSecret(token,false,async (tx,session)=>({session_id:session.id,revision:session.revision,snapshot_challenge:session.snapshot_challenge,forgotten_field_keys:(await tx.find('field_tombstones',{where:{session_id:session.id}})).map(row=>row.field_key)}));
  }
  async checkpoint(token:string,challenge:string,pending:number) {
    requireThat(pending===0,'pending_capture','Flush every queued capture event before acknowledging the final snapshot.',409);
    return this.memory.db.withSessionSecret(token,false,async (tx,session)=>{
      requireThat(session.snapshot_challenge===challenge,'stale_snapshot','The final-snapshot request changed.',409);
      await tx.set('form_sessions',session.id,{checkpoint_revision:session.revision,checkpoint_at:now(),snapshot_challenge:null});
      return {status:'checkpointed',revision:session.revision};
    });
  }
  async get(actor:Actor,id:string) {
    return this.memory.db.withVault(actor,false,async tx=>{
      const row=await tx.get('form_sessions',id);requireThat(row,'not_found','The form session does not exist in this vault.',404);
      const {subject_id,title,page_origin,status,revision,submission_status}=row;
      const fields=(await tx.find('form_fields',{where:{session_id:id},orderBy:'field_key'})).map(({field_key,label,value,input_type,revision,observed_at,origin})=>({field_key,label,value,input_type,revision,observed_at,origin}));
      return {session:{id,subject_id,title,page_origin,status,revision,submission_status},fields};
    });
  }
  async finalize(actor:Actor,id:string,context:Context,key:string) {
    const prepared=await this.memory.db.withVault(actor,true,async tx=>{
      const session=await tx.get('form_sessions',id);
      requireThat(session,'not_found','The form session does not exist in this vault.',404);
      if(session.status==='finalized') return {done:true};
      const fresh=session.checkpoint_revision===session.revision && session.checkpoint_at && Date.now()-new Date(session.checkpoint_at).getTime()<30000;
      if(!fresh) {
        const challenge=session.snapshot_challenge??randomUUID();
        await tx.set('form_sessions',id,{snapshot_challenge:challenge});
        return {waiting:true,paired:!!session.capture_hash};
      }
      const rows=await tx.find('form_fields',{where:{session_id:id},orderBy:'field_key'});
      const subject=await tx.get('entities',session.subject_id);
      requireThat(rows.length,'empty_form','No field entries have been captured yet.');
      let text=`Form: ${session.title}\nWebsite: ${session.page_origin}\nSubject: ${subject?.name??'Unknown'} (${session.subject_id})\n`;
      const fields: NonNullable<SourceInput['fields']>=[];
      for(const row of rows) {
        const prefix=`${row.label} [${row.field_key}]: `, value=JSON.stringify(row.value);
        const start=text.length+prefix.length;
        text+=prefix+value+'\n'; fields.push({key:row.field_key,label:row.label,value:row.value,start,end:start+value.length});
      }
      return {source:{text,context,kind:'form' as const,form_session_id:id,form_revision:session.revision,fields}};
    });
    if('done' in prepared) return {status:'already_finalized',session_id:id};
    if('waiting' in prepared) return {status:'awaiting_final_snapshot',session_id:id,
      instruction:prepared.paired?'The extension is flushing and checkpointing the latest fields. Retry finalize_form after it acknowledges the snapshot.':'Pair the capture extension with this form before finalizing so manual edits are included.'};
    return this.memory.ingest(actor,prepared.source,key);
  }
}
