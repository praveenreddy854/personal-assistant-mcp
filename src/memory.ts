import { createHash,randomUUID } from 'node:crypto';
import { Database,date,tokens,fieldId,type Tx,type Query } from './db.js';
import { MemoryError,requireThat } from './errors.js';
import { ExtractionSchema,type Actor,type Claim,type Context,type Entity,type Evidence,type MemoryAI,type Plan,type PlannedClaim,type Snapshot,type SourceInput } from './models.js';

export const canonical=(value:string)=>{
  const key=value.normalize('NFKC').toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu,'_').replace(/^_|_$/g,'');
  return ({dob:'date_of_birth',birthday:'date_of_birth',birth_date:'date_of_birth',birthday_date:'date_of_birth',dateofbirth:'date_of_birth',current_address:'residence',home_address:'residence',current_city:'residence',address:'residence'} as Record<string,string>)[key]??key;
};
const json=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const hash=(value:unknown)=>createHash('sha256').update(json(value)).digest('hex');
const now=()=>new Date().toISOString();
const claimRow=(row:any):Claim=>({id:row.id,subject_id:row.subject_id,predicate:row.predicate,object_id:row.object_id,value:row.value,domain:row.domain,
  valid_from:date(row.valid_from),valid_to:date(row.valid_to),modality:row.modality,qualifiers:row.qualifiers,status:row.status,lineage_id:row.lineage_id,version:row.version,
  search_text:row.search_text,recorded_at:row.recorded_at,superseded_at:row.superseded_at??null});
const unique=<T>(values:T[])=>[...new Set(values)];
/** In a family vault, "I/me" is the signed-in member. */
const markSelf=(tx:Tx,entities:any[])=>tx.self?entities.map(e=>({...e,is_self:e.id===tx.self})):entities;

export class MemoryService {
  constructor(public db:Database,public ai:MemoryAI,public embeddingVersion:string){}
  async snapshot(actor:Actor,text:string):Promise<Snapshot>{
    return this.db.withVault(actor,false,async tx=>{
      const where={status:['active','historical']},terms=tokens(text).slice(0,32);
      const recent=await tx.find('claims',{where,orderBy:'recorded_at',descending:true,limit:501});
      const matching=terms.length?await tx.find('claims',{where,terms,limit:501}):[];
      const claims=[...new Map([...matching,...recent].map(c=>[c.id,c])).values()];
      const listed=await tx.find('entities',{orderBy:'is_self',descending:true,limit:1001});
      // Keep the signed-in member first so a large vault can't push "me" out of the bounded snapshot.
      const own=tx.self?await tx.get('entities',tx.self):undefined;
      const entities=own?[own,...listed.filter(e=>e.id!==own.id)]:listed;
      return {revision:tx.revision,claims:claims.slice(0,500).map(claimRow),entities:markSelf(tx,entities.slice(0,1000)),truncated:claims.length>500||entities.length>1000};
    });
  }
  private async reserve(actor:Actor,key:string,digest:string){
    requireThat(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key),'invalid_request_key','Generate an opaque UUID for each new user memory request.');
    return this.db.withVault(actor,true,async tx=>{
      const row=await tx.get('operations',key);
      requireThat(!row?.forgotten,'forgotten_request','This request was invalidated by forgetting. Reintroduction requires a new explicit user request and UUID.',409);
      if(row)requireThat(row.request_hash===digest,'idempotency_conflict','This UUID was used for different content.',409);
      if(row&&row.result?.status!=='processing')return row.result;
      requireThat(!row?.lease_until||Date.parse(row.lease_until)<=Date.now(),'operation_in_progress','The same request is still processing. Retry after completion.',409);
      await tx.put('operations',key,{request_key:key,request_hash:digest,result:{status:'processing'},forgotten:false,lease_until:new Date(Date.now()+120000).toISOString()});
      return undefined;
    });
  }
  async remember(actor:Actor,text:string,context:Context,key:string){return this.ingest(actor,{text,context,kind:'statement'},key);}
  async ingest(actor:Actor,source:SourceInput,key:string){
    requireThat(source.text.trim()&&source.text.length<=100000,'invalid_source','Provide 1–100000 characters of source information.');
    // In the shared family vault, bind the request UUID to the member so another member can't replay it.
    const digest=hash(actor.issuer==='family-token'?{source,member:actor.subject}:source),cached=await this.reserve(actor,key,digest);if(cached)return cached;
    try{
      let snapshot=await this.snapshot(actor,source.text);
      const extraction=ExtractionSchema.parse(await this.ai.extract(source.text,source.context,snapshot));
      if(extraction.clarification){
        const result={status:'needs_clarification',question:extraction.clarification};
        await this.db.withVault(actor,true,async tx=>{const row=await tx.get('operations',key);requireThat(row&&!row.forgotten,'forgotten_request','This in-flight request was invalidated by forgetting.',409);await tx.set('operations',key,{result,lease_until:null});});return result;
      }
      requireThat(extraction.claims.length||source.kind==='form','no_supported_claims','No source-supported facts could be extracted.');
      snapshot=await this.db.withVault(actor,false,async tx=>{
        const ids=unique(extraction.entities.flatMap(e=>e.existing_id?[e.existing_id]:[])),predicates=unique(extraction.claims.map(c=>canonical(c.predicate)));
        const existing=ids.length?await tx.find('claims',{where:{subject_id:ids,predicate:predicates,status:['active','historical']},limit:1001}):[];
        requireThat(existing.length<=1000,'review_scope_too_large','This change affects too many facts; narrow the scope.');
        const entities=ids.length?await tx.find('entities',{where:{id:ids}}):[];
        return {...snapshot,entities:markSelf(tx,[...new Map([...snapshot.entities,...entities].map(e=>[e.id,e])).values()]),claims:[...new Map([...snapshot.claims,...existing.map(claimRow)].map(c=>[c.id,c])).values()]};
      });
      const plan=await this.plan(source,snapshot,extraction);
      return await this.db.withVault(actor,true,async tx=>{
        const replay=await tx.get('operations',key);
        requireThat(replay&&!replay.forgotten,'forgotten_request','This in-flight request was invalidated by forgetting.',409);
        requireThat(replay.request_hash===digest,'idempotency_conflict','Idempotency key content changed.',409);
        if(replay.result.status!=='processing')return replay.result;
        requireThat(tx.revision===snapshot.revision,'concurrent_change','Memory changed during interpretation. Retry the same UUID.',409);
        await this.checkForm(tx,plan.source);
        let result;
        if(plan.claims.some(c=>c.targets.length>0||c.change!=='add')){
          const preview=plan.claims.map(c=>({subject:plan.entities.find(e=>e.id===c.subject_id)?.name??snapshot.entities.find(e=>e.id===c.subject_id)?.name,predicate:c.predicate,value:c.value,object:c.object_id,change:c.change,valid_from:c.valid_from,valid_to:c.valid_to,
            existing:snapshot.claims.filter(old=>c.targets.some(t=>t.id===old.id)).map(old=>({id:old.id,value:old.value,object_id:old.object_id,status:old.status})),quote:c.quote}));
          result=await this.proposal(tx,actor,'edit',plan,preview,'Show this exact proposal. A fully specified direct user edit counts as approval; otherwise ask. Relay the actual user message with decide_change.');
        }else result=await this.applyPlan(tx,plan);
        await tx.set('operations',key,{result,lease_until:null});return result;
      });
    }catch(error){
      await this.db.withVault(actor,true,async tx=>{const row=await tx.get('operations',key);if(row&&!row.forgotten&&row.result?.status==='processing')await tx.set('operations',key,{lease_until:now()});}).catch(()=>{});throw error;
    }
  }
  private async proposal(tx:Tx,actor:Actor,kind:string,payload:unknown,preview:unknown,instruction:string){
    const id=randomUUID();await tx.put('proposals',id,{client_id:actor.clientId,kind,base_revision:tx.revision,payload,preview,status:'pending',result:null,expires_at:new Date(Date.now()+900000).toISOString()});
    return {status:'approval_required',proposal_id:id,preview,expires_in_seconds:900,instruction};
  }
  private async plan(source: SourceInput,snapshot: Snapshot,extraction: ReturnType<typeof ExtractionSchema.parse>): Promise<Plan> {
    const references=new Map<string,string>(), entities: Entity[]=[];
    for (const entity of extraction.entities) {
      requireThat(!references.has(entity.ref),'invalid_extraction','Duplicate entity references.',503);
      if (entity.existing_id) {
        requireThat(snapshot.entities.some(e=>e.id===entity.existing_id),'invalid_entity','An entity reference is not in the authenticated vault context.',503);
        references.set(entity.ref,entity.existing_id);
      } else {
        const matches=snapshot.entities.filter(e=>e.kind===entity.kind && [e.name,...e.aliases].some(n=>n.toLowerCase()===entity.name.toLowerCase()));
        requireThat(matches.length===0,'identity_ambiguous',`A known entity already uses the label "${entity.name}". Clarify its identity before saving.`);
        requireThat(source.text.toLowerCase().includes(entity.name.toLowerCase()),'ungrounded_entity','New entity labels must occur in the source; no inferred names.',503);
        const id=randomUUID(); references.set(entity.ref,id);
        entities.push({id,kind:canonical(entity.kind),name:entity.name,aliases:entity.aliases.filter(a=>source.text.includes(a)),is_self:false});
      }
    }
    for(const entity of snapshot.entities) references.set(entity.id,entity.id);
    const claims: PlannedClaim[]=[];
    for(const draft of extraction.claims) {
      const subject=references.get(draft.subject_ref), object=draft.object_ref===null ? null : references.get(draft.object_ref);
      requireThat(subject && (draft.object_ref===null || object),'invalid_extraction','Unresolved claim entity reference.',503);
      requireThat((object!=null)!==(draft.value!=null),'invalid_extraction','Each claim needs either an entity object or a non-null JSON value.',503);
      requireThat(source.text.includes(draft.quote) && draft.quote.includes(draft.value_quote),'ungrounded_claim','Claim evidence must be verbatim source text, including the value span.',503);
      requireThat(!draft.valid_from || !draft.valid_to || draft.valid_to>=draft.valid_from,'invalid_interval','Invalid validity interval.',503);
      const predicate=canonical(draft.predicate), same=snapshot.claims.filter(c=>c.subject_id===subject && c.predicate===predicate && c.status==='active');
      requireThat(predicate && canonical(draft.domain),'invalid_extraction','A predicate and domain need meaningful names.',503);
      const exact=same.find(c=>c.object_id===(object??null) && json(c.value)===json(draft.value) && c.modality===draft.modality && json(c.qualifiers)===json(draft.qualifiers)
        && (!draft.valid_from || c.valid_from===draft.valid_from) && (!draft.valid_to || c.valid_to===draft.valid_to));
      const declared=draft.replaces.map(id=>{
        const target=snapshot.claims.find(c=>c.id===id);
        requireThat(target && target.subject_id===subject && target.predicate===predicate && ['active','historical'].includes(target.status),'invalid_change_target','A replacement must reference an approved current or historical claim for the same subject and meaning.',503);
        return target;
      });
      if (draft.change!=='add') requireThat(declared.length>0,'invalid_change_target','A correction, transition, or retraction needs an explicit existing target.',503);
      if (draft.change==='transition') requireThat(draft.valid_from,'missing_effective_date','A life transition needs a supported effective date.');
      const targets=exact && draft.change==='add' ? [] : (declared.length ? declared : same);
      const validFrom=draft.valid_from??(draft.change==='correction'?declared[0]?.valid_from??null:null);
      const validTo=draft.valid_to??(draft.change==='correction'?declared[0]?.valid_to??null:null);
      // Resolve names through entities and graph edges, rather than copying a
      // person's name into every unrelated fact's text and embedding.
      const search_text=`${predicate.replaceAll('_',' ')} ${object?'related entity':json(draft.value)} ${draft.domain}`;
      claims.push({...draft,valid_from:validFrom,valid_to:validTo,predicate,domain:canonical(draft.domain),id:exact && draft.change==='add' ? exact.id : randomUUID(),subject_id:subject,object_id:object??null,
        targets:targets.map(c=>({id:c.id,version:c.version})),lineage_id:draft.change==='correction'?(declared[0]?.lineage_id??randomUUID()):randomUUID(),embedding:[],search_text});
    }
    const identities=new Map<string,PlannedClaim>();
    for(const claim of claims){
      const key=json({subject:claim.subject_id,predicate:claim.predicate,object:claim.object_id,value:claim.value,from:claim.valid_from,to:claim.valid_to,qualifiers:claim.qualifiers,modality:claim.modality,change:claim.change,targets:claim.targets});
      const previous=identities.get(key);
      if(previous){claim.id=previous.id;claim.lineage_id=previous.lineage_id;}else identities.set(key,claim);
    }
    const fresh=[...new Map(claims.filter(c=>c.change!=='retraction' && !snapshot.claims.some(old=>old.id===c.id)).map(c=>[c.id,c])).values()];
    const embeddings=await this.ai.embedMany(fresh.map(c=>c.search_text));
    requireThat(embeddings.length===fresh.length,'invalid_embedding','An embedding batch was incomplete.',503);
    for(const [index,claim] of fresh.entries()) {
      const embedding=embeddings[index]!;
      requireThat(embedding.length===1536 && embedding.every(Number.isFinite) && embedding.some(x=>x!==0),'invalid_embedding','An embedding must contain 1536 finite values and have nonzero magnitude.',503);
      claim.embedding=embedding;
      for(const duplicate of claims.filter(c=>c.id===claim.id))duplicate.embedding=embedding;
    }
    return {entities,claims,source};
  }
  async checkForm(tx:Tx,source:SourceInput){
    if(!source.form_session_id)return;
    const row=await tx.get('form_sessions',source.form_session_id);
    requireThat(row&&row.status==='draft'&&row.revision===source.form_revision,'stale_form','The form changed or was finalized. Capture a new final snapshot.',409);
  }
  async applyPlan(tx:Tx,plan:Plan){
    await this.checkForm(tx,plan.source);
    for(const entity of plan.entities){
      const candidates=await tx.find('entities',{where:{kind:entity.kind}});
      requireThat(!candidates.some(e=>[e.name,...e.aliases].some((label:string)=>label.toLowerCase()===entity.name.toLowerCase())),'identity_ambiguous','A matching entity exists outside the interpretation context. Resolve its identity.',409);
      await tx.put('entities',entity.id,{...entity,search_tokens:tokens([entity.name,...entity.aliases].join(' '))});
    }
    const sourceId=randomUUID(),stamp=now();
    await tx.put('sources',sourceId,{kind:plan.source.kind,text:plan.source.text,context:{occurred_at:plan.source.context.occurred_at,timezone:plan.source.context.timezone},form_session_id:plan.source.form_session_id??null,recorded_at:stamp,redacted:false});
    const processed=new Set<string>();
    for(const claim of plan.claims){
      const start=plan.source.text.indexOf(claim.quote);
      const addEvidence=async(claimId:string,valueQuote:string,relation:string)=>{
        const valueStart=valueQuote?start+claim.quote.indexOf(valueQuote):start;
        const fields=valueQuote?(plan.source.fields??[]).filter(f=>valueStart>=f.start&&valueStart<f.end).map(f=>f.key):[];
        await tx.put('claim_evidence',randomUUID(),{claim_id:claimId,source_id:sourceId,quote:claim.quote,value_quote:valueQuote,quote_start:start,value_start:valueStart,field_keys:fields,relation});
      };
      for(const target of claim.targets){
        if(claim.change==='add')continue;
        if(!processed.has(claim.id)){
          const old=await tx.get('claims',target.id);
          requireThat(old&&old.version===target.version&&['active','historical'].includes(old.status),'stale_proposal','An affected fact changed; create a new proposal.',409);
          await tx.set('claims',target.id,{status:claim.change==='transition'?'historical':claim.change==='retraction'?'retracted':'corrected',
            valid_to:claim.change==='transition'?claim.valid_from:old.valid_to,version:old.version+1,superseded_at:stamp});
        }
        const oldValues=await tx.find('claim_evidence',{where:{claim_id:target.id,relation:'supports'}});
        const oldQuote=oldValues.map(row=>row.value_quote as string).find(value=>value&&claim.quote.includes(value))??'';
        await addEvidence(target.id,oldQuote,claim.change==='transition'?'ends':claim.change==='retraction'?'retracts':'corrects');
      }
      processed.add(claim.id);if(claim.change==='retraction')continue;
      const existing=await tx.get('claims',claim.id);
      if(!existing)await tx.put('claims',claim.id,{subject_id:claim.subject_id,predicate:claim.predicate,object_id:claim.object_id,value:claim.object_id?null:claim.value,
        domain:claim.domain,valid_from:claim.valid_from,valid_to:claim.valid_to,modality:claim.modality,qualifiers:claim.qualifiers,lineage_id:claim.lineage_id,
        search_text:claim.search_text,search_tokens:tokens(claim.search_text),embedding_version:this.embeddingVersion,version:1,recorded_at:stamp,superseded_at:null,
        status:claim.valid_to&&claim.valid_to<stamp.slice(0,10)?'historical':'active'},claim.embedding);
      await addEvidence(claim.id,claim.value_quote,'supports');
      if(claim.change==='correction'&&!existing)for(const target of claim.targets){
        const previous=await tx.find('claim_evidence',{where:{claim_id:target.id,relation:'supports'}});
        for(const item of previous)await tx.put('claim_evidence',randomUUID(),{claim_id:claim.id,source_id:item.source_id,quote:item.quote,value_quote:'',quote_start:item.quote_start,value_start:item.quote_start,field_keys:[],relation:'context'});
      }
    }
    if(plan.source.form_session_id)await tx.set('form_sessions',plan.source.form_session_id,{status:'finalized',capture_hash:null,pair_hash:null});
    await this.db.bump(tx);
    return {status:'saved',claim_ids:unique(plan.claims.filter(c=>c.change!=='retraction').map(c=>c.id)),source_id:sourceId};
  }
  async decide(actor:Actor,id:string,decision:'approve'|'reject',userMessage:string){
    requireThat(userMessage.trim(),'approval_message_required','Include the actual user instruction or confirmation, not generated approval.');
    return this.db.withVault(actor,true,async tx=>{
      const proposal=await tx.get('proposals',id);requireThat(proposal,'not_found','This proposal does not exist in the vault.',404);
      requireThat(proposal.client_id===actor.clientId,'wrong_client','Only the proposing client may relay this chat decision.',403);
      if(proposal.status==='applied')return proposal.result;
      requireThat(proposal.status==='pending','proposal_closed','This proposal is no longer pending.',409);
      requireThat(Date.parse(proposal.expires_at)>Date.now(),'proposal_expired','The proposal expired. Create a new proposal.',409);
      if(decision==='reject'){await tx.set('proposals',id,{status:'rejected',payload:{},preview:[]});return {status:'rejected',proposal_id:id};}
      requireThat(proposal.base_revision===tx.revision,'stale_proposal','The vault changed since the preview. Regenerate the proposal.',409);
      const result=proposal.kind==='forget'?await this.applyForget(tx,proposal.payload):proposal.kind==='discard_form'?await this.discardForm(tx,proposal.payload):await this.applyPlan(tx,proposal.payload);
      await tx.set('proposals',id,{status:'applied',result,payload:{},preview:[]});return result;
    });
  }
  async proposeForget(actor:Actor,claimIds:string[],reason:string){
    requireThat(claimIds.length>0&&claimIds.length<=100,'invalid_scope','Select 1–100 claim IDs to forget.');
    return this.db.withVault(actor,true,async tx=>{
      const selected=await tx.find('claims',{where:{id:claimIds}});
      requireThat(selected.length===unique(claimIds).length,'not_found','One or more claims do not exist in this vault.',404);
      const lineages=unique(selected.map(c=>c.lineage_id));
      const all=await tx.find('claims',{where:{lineage_id:lineages}});
      return this.proposal(tx,actor,'forget',{lineages},{action:'forget',includes_corrected_versions:true,claims:all.map(c=>({id:c.id,subject_id:c.subject_id,predicate:c.predicate,value:c.value,object_id:c.object_id,status:c.status,lineage_id:c.lineage_id})),reason},
        'Show the exact scope. A fully scoped direct forget instruction counts as approval; otherwise ask. Relay the user decision with decide_change.');
    });
  }
  private async hydrateEvidence(tx:Tx,items:any[]){
    const rows=[];for(const item of items){const source=await tx.get('sources',item.source_id);if(source)rows.push({...item,text:source.text,form_session_id:source.form_session_id,kind:source.kind,recorded_at:source.recorded_at,redacted:source.redacted});}return rows;
  }
  async removeClaims(tx:Tx,ids:string[]){
    if(!ids.length)return;
    for(const item of await tx.find('claim_evidence',{where:{claim_id:ids}}))await tx.remove('claim_evidence',item.id);
    for(const id of ids)await tx.remove('claims',id);
  }
  private async removeSources(tx:Tx,ids:string[]){
    if(!ids.length)return;
    for(const item of await tx.find('claim_evidence',{where:{source_id:ids}}))await tx.remove('claim_evidence',item.id);
    for(const id of ids)await tx.remove('sources',id);
  }
  async removeFields(tx:Tx,fields:{session_id:string;field_key:string}[]){
    for(const field of [...new Map(fields.map(f=>[fieldId(f.session_id,f.field_key),f])).values()]){
      const id=fieldId(field.session_id,field.field_key);
      for(const revision of await tx.find('form_revisions',{where:field}))await tx.remove('form_revisions',revision.id);
      await tx.remove('form_fields',id);await tx.put('field_tombstones',id,field);
      const session=await tx.get('form_sessions',field.session_id);if(session)await tx.set('form_sessions',session.id,{revision:session.revision+1,checkpoint_revision:null});
    }
  }
  private async cleanupEntities(tx:Tx,ids:string[]){
    for(const id of unique(ids.filter(Boolean))){
      const entity=await tx.get('entities',id);if(!entity||entity.is_self||entity.member)continue;
      const claims=await tx.find('claims',{or:[{subject_id:id},{object_id:id}],limit:1});
      const forms=await tx.find('form_sessions',{where:{subject_id:id},limit:1});
      if(!claims.length&&!forms.length)await tx.remove('entities',id);
    }
  }
  async invalidateCopies(tx:Tx){
    for(const proposal of await tx.find('proposals',{where:{status:'pending'}}))await tx.set('proposals',proposal.id,{status:'invalidated',payload:{},preview:[],result:null});
    const operations=await tx.find('operations',{where:{forgotten:false}});
    for(const operation of operations)await tx.set('operations',operation.id,{forgotten:true,request_hash:'',result:{},lease_until:null});
    return operations.map(row=>row.request_key);
  }
  async applyForget(tx:Tx,payload:{lineages:string[]}){
    const targets=await tx.find('claims',{where:{lineage_id:payload.lineages}});
    requireThat(targets.length,'not_found','The selected memories no longer exist.',404);
    const evidence=await this.hydrateEvidence(tx,await tx.find('claim_evidence',{where:{claim_id:targets.map(c=>c.id)}}));
    const labels=await tx.find('entities',{where:{id:unique(targets.map(t=>t.subject_id))}});
    const forgottenLabels=labels.flatMap(entity=>targets.filter(t=>t.subject_id===entity.id&&typeof t.value==='string'&&[entity.name,...entity.aliases].includes(t.value)).map(t=>({id:entity.id,value:t.value as string})));
    const labelClaims=forgottenLabels.length?await tx.find('claims',{or:[{subject_id:forgottenLabels.map(label=>label.id)},{object_id:forgottenLabels.map(label=>label.id)}]}):[];
    const labelEvidence=labelClaims.length?await this.hydrateEvidence(tx,await tx.find('claim_evidence',{where:{claim_id:labelClaims.map(c=>c.id)}})):[];
    const fields:{session_id:string;field_key:string}[]=[],sourceIds=unique([...evidence,...labelEvidence].map(e=>e.source_id as string));
    const removedIds=new Set(targets.map(c=>c.id));
    for(const sourceId of sourceIds){
      const rows=evidence.filter(e=>e.source_id===sourceId),labelRows=labelEvidence.filter(e=>e.source_id===sourceId);
      const original=(rows[0]??labelRows[0]).text as string;
      const spans=rows.map(e=>({start:e.value_start as number,end:e.value_start+(e.value_quote as string).length}));
      for(const literal of unique(evidence.map(e=>e.value_quote as string).filter(Boolean)))for(const row of rows){
        let offset=row.quote.indexOf(literal);while(offset>=0){spans.push({start:row.quote_start+offset,end:row.quote_start+offset+literal.length});offset=row.quote.indexOf(literal,offset+literal.length);}
      }
      for(const label of forgottenLabels)for(const row of labelRows){
        let offset=row.quote.indexOf(label.value);while(offset>=0){spans.push({start:row.quote_start+offset,end:row.quote_start+offset+label.value.length});offset=row.quote.indexOf(label.value,offset+label.value.length);}
      }
      const redacted=redact(original,spans);await tx.set('sources',sourceId,{text:redacted,redacted:true});
      const survivors=(await tx.find('claim_evidence',{where:{source_id:sourceId}})).filter(e=>!removedIds.has(e.claim_id));
      for(const survivor of survivors){
        const quote=redact(survivor.quote,spans.map(s=>({start:s.start-survivor.quote_start,end:s.end-survivor.quote_start})));
        const valueQuote=redact(survivor.value_quote,spans.map(s=>({start:s.start-survivor.value_start,end:s.end-survivor.value_start})));
        await tx.set('claim_evidence',survivor.id,{quote,value_quote:valueQuote,quote_start:Math.max(0,redacted.indexOf(quote)),value_start:Math.max(0,redacted.indexOf(valueQuote))});
      }
      for(const row of rows)if(row.form_session_id)for(const field_key of row.field_keys)fields.push({session_id:row.form_session_id,field_key});
    }
    const forms=await tx.find('form_sessions',{where:{subject_id:unique(targets.map(t=>t.subject_id))}});
    for(const form of forms)for(const field of await tx.find('form_fields',{where:{session_id:form.id}}))
      if(targets.some(t=>t.subject_id===form.subject_id&&t.predicate===canonical(field.label)))fields.push({session_id:form.id,field_key:field.field_key});
    await this.removeFields(tx,fields);await this.removeClaims(tx,targets.map(c=>c.id));
    for(const label of forgottenLabels){
      const entity=await tx.get('entities',label.id),name=entity.name===label.value?`[${entity.kind} ${entity.id.slice(0,8)}]`:entity.name,aliases=entity.aliases.filter((alias:string)=>alias!==label.value);
      await tx.set('entities',label.id,{name,aliases,search_tokens:tokens([name,...aliases].join(' '))});
    }
    for(const sourceId of sourceIds)if(!(await tx.find('claim_evidence',{where:{source_id:sourceId},limit:1})).length)await tx.remove('sources',sourceId);
    await this.cleanupEntities(tx,targets.flatMap(c=>[c.subject_id,c.object_id]));
    const invalidated=await this.invalidateCopies(tx),receipt=randomUUID();
    await tx.put('deletion_receipts',receipt,{vault_id:tx.vault,lineage_ids:payload.lineages,source_ids:sourceIds,field_refs:fields,removed_claims:targets.length,claim_ids:targets.map(c=>c.id),session_ids:[],request_keys:invalidated,created_at:now()});
    await this.db.bump(tx);
    return {status:'forgotten',receipt_id:receipt,removed_claims:targets.length,backup_note:'Backups expire under the configured retention policy. Replay deletion receipts before serving restored data.'};
  }
  private async formDependencies(tx:Tx,sources:string[]){
    if(!sources.length)return [];
    const evidence=await tx.find('claim_evidence',{where:{source_id:sources}}),ids=unique(evidence.map(e=>e.claim_id));if(!ids.length)return [];
    const all=await tx.find('claim_evidence',{where:{claim_id:ids}});
    const dependent=ids.filter(id=>all.filter(e=>e.claim_id===id).every(e=>sources.includes(e.source_id)));
    return dependent.length?tx.find('claims',{where:{id:dependent}}):[];
  }
  async proposeDiscardForm(actor:Actor,id:string,reason:string){
    return this.db.withVault(actor,true,async tx=>{
      const form=await tx.get('form_sessions',id);requireThat(form,'not_found','The form does not exist in this vault.',404);
      const fields=(await tx.find('form_fields',{where:{session_id:id}})).map(f=>({field_key:f.field_key,label:f.label}));
      const sources=(await tx.find('sources',{where:{form_session_id:id}})).map(s=>s.id),claims=await this.formDependencies(tx,sources);
      const preview={action:'discard_form',form:{id,title:form.title,revision:form.revision,status:form.status},fields,claims_losing_all_evidence:claims.map(c=>({id:c.id,predicate:c.predicate,value:c.value,status:c.status})),reason};
      return this.proposal(tx,actor,'discard_form',{session_id:id,revision:form.revision},preview,'Confirm this exact scope, including facts losing their only source. Independently supported facts remain. Relay the actual user message with decide_change.');
    });
  }
  async discardForm(tx:Tx,payload:{session_id:string;revision:number}){
    const form=await tx.get('form_sessions',payload.session_id);requireThat(form&&form.revision===payload.revision,'stale_form','The form changed since this deletion preview.',409);
    const sources=(await tx.find('sources',{where:{form_session_id:form.id}})).map(s=>s.id),dependent=await this.formDependencies(tx,sources);
    const fields=(await tx.find('form_fields',{where:{session_id:form.id}})).map(row=>({session_id:form.id,field_key:row.field_key}));
    await this.removeFields(tx,fields);await this.removeClaims(tx,dependent.map(c=>c.id));await this.removeSources(tx,sources);
    for(const revision of await tx.find('form_revisions',{where:{session_id:form.id}}))await tx.remove('form_revisions',revision.id);
    await tx.remove('form_sessions',form.id);await this.cleanupEntities(tx,dependent.flatMap(c=>[c.subject_id,c.object_id]));
    const invalidated=await this.invalidateCopies(tx),receipt=randomUUID();
    await tx.put('deletion_receipts',receipt,{vault_id:tx.vault,lineage_ids:[],source_ids:sources,field_refs:fields,removed_claims:dependent.length,claim_ids:dependent.map(c=>c.id),session_ids:[form.id],request_keys:invalidated,created_at:now()});
    await this.db.bump(tx);return {status:'form_forgotten',receipt_id:receipt,removed_claims:dependent.length};
  }
  async recall(actor:Actor,question:string,level:number,options:{domain?:string;as_of?:string;include_corrections?:boolean}={}){
    const embedding=await this.ai.embed(question),words=tokens(question).slice(0,32);
    const records=await this.db.withVault(actor,false,async tx=>{
      const status=options.include_corrections?{}:{status:['active','historical']};
      const filter:Query={where:{...status,...(options.domain?{domain:canonical(options.domain)}:{})},asOf:options.as_of};
      const keyword=words.length?await tx.find('claims',{...filter,terms:words,limit:200}):[];
      keyword.sort((a,b)=>words.filter(word=>b.search_tokens?.includes(word)).length-words.filter(word=>a.search_tokens?.includes(word)).length);
      const semantic=await tx.semantic(embedding,this.embeddingVersion,filter,60),scores=new Map<string,{claim:any;score:number}>();
      for(const list of [keyword.slice(0,60),semantic])for(const [index,claim] of list.entries()){const row=scores.get(claim.id)??{claim,score:0};row.score+=1/(61+index);scores.set(claim.id,row);}
      const seeds=[...scores.values()].sort((a,b)=>b.score-a.score).slice(0,80).map(row=>row.claim);
      const self=tx.self?[{id:tx.self}]:await tx.find('entities',{where:{is_self:true}}),named=words.length?await tx.find('entities',{terms:words,limit:100}):[];
      const mentioned=named.filter(e=>[e.name,...e.aliases].some((label:string)=>label.length>2&&question.toLowerCase().includes(label.toLowerCase())));
      const nodes=new Set<string>([...self,...mentioned].map(e=>e.id));for(const c of seeds){nodes.add(c.subject_id);if(c.object_id)nodes.add(c.object_id);}
      let frontier=[...nodes],truncated=false;
      for(let depth=0;depth<2&&frontier.length;depth++){
        const edges=await tx.find('claims',{where:status,or:[{subject_id:frontier},{object_id:frontier}],asOf:options.as_of,relationshipsOnly:true,limit:201});
        truncated ||= edges.length>200;const next:string[]=[];
        for(const edge of edges.slice(0,200))for(const id of [edge.subject_id,edge.object_id])if(id&&!nodes.has(id)){nodes.add(id);next.push(id);}
        frontier=next;
      }
      const neighbors=nodes.size?await tx.find('claims',{...filter,or:[{subject_id:[...nodes]},{object_id:[...nodes]}],orderBy:'recorded_at',descending:true,limit:201}):[];
      truncated ||= neighbors.length>200;
      const combined=[...new Map([...seeds,...neighbors.slice(0,200)].map(c=>[c.id,claimRow(c)])).values()];
      if(!combined.length)return {claims:[],evidence:[],entities:[],truncated:false,revision:tx.revision};
      const evidence=await this.hydrateEvidence(tx,await tx.find('claim_evidence',{where:{claim_id:combined.map(c=>c.id)}}));
      // Always include the asker (family member or single owner) so "I/me/my" resolves in every auth mode.
      const entities=await tx.find('entities',{where:{id:unique([...combined.flatMap(c=>[c.subject_id,c.object_id]),...self.map(e=>e.id)].filter(Boolean))}});
      return {claims:combined,evidence:evidence.map(e=>({claim_id:e.claim_id,source_id:e.source_id,quote:e.quote,relation:e.relation,kind:e.kind,recorded_at:e.recorded_at,redacted:e.redacted})) as Evidence[],entities:markSelf(tx,entities).map(e=>({id:e.id,kind:e.kind,name:e.name,is_self:Boolean(e.is_self)})),truncated,revision:tx.revision};
    });
    if(!records.claims.length)return {answer:'I do not have remembered information supporting an answer.',claims:[],evidence:[],missing_information:[question],conflicts:[],level,truncated:false};
    const answer=await this.ai.answer(question,level,[records]);
    await this.db.withVault(actor,false,async tx=>requireThat(tx.revision===records.revision,'concurrent_change','Memory changed while preparing the answer. Retry recall.',409));
    const known=new Set(records.claims.map(c=>c.id));requireThat(answer.used_claim_ids.every(id=>known.has(id)),'invalid_citation','The answer cited an unavailable memory.',503);
    requireThat(answer.used_claim_ids.length||answer.missing_information.length,'ungrounded_answer','The answer needs supporting claims or missing-information gaps.',503);
    const used=new Set(answer.used_claim_ids),claims=records.claims.filter(c=>used.has(c.id)),entities=new Set(claims.flatMap(c=>[c.subject_id,c.object_id]).filter(Boolean));
    return {...answer,level,claims:claims.map(({search_text,...c})=>c),evidence:records.evidence.filter(e=>used.has(e.claim_id)),entities:records.entities.filter(e=>entities.has(e.id)),truncated:records.truncated};
  }
}
export function redact(text: string,spans: {start:number;end:number}[]) {
  const ordered=spans.map(s=>({start:Math.max(0,s.start),end:Math.min(text.length,s.end)})).filter(s=>s.end>s.start).sort((a,b)=>a.start-b.start);
  const merged: {start:number;end:number}[]=[];
  for(const span of ordered) {
    const last=merged.at(-1);
    if(last && span.start<=last.end) last.end=Math.max(last.end,span.end); else merged.push({...span});
  }
  for(const span of merged.reverse()) text=text.slice(0,span.start)+'[forgotten]'+text.slice(span.end);
  return text;
}
