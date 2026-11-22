import { CosmosClient, VectorIndexType,VectorEmbeddingDataType,VectorEmbeddingDistanceFunction, type Container, type OperationInput } from '@azure/cosmos';
import { DefaultAzureCredential } from '@azure/identity';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { gzipSync,gunzipSync } from 'node:zlib';
import type { Actor } from './models.js';
import { MemoryError,requireThat } from './errors.js';

export type Kind='entities'|'claims'|'sources'|'claim_evidence'|'form_sessions'|'form_fields'|'form_revisions'|'proposals'|'operations'|'deletion_receipts'|'field_tombstones';
type Row=Record<string,any>;
type Filters=Record<string,unknown|unknown[]>;
export type Query={where?:Filters;or?:Filters[];terms?:string[];asOf?:string;relationshipsOnly?:boolean;orderBy?:string;descending?:boolean;limit?:number};
type Head={id:'vault';vault_id:string;owner_key:string;revision:number;active:boolean;maintenance?:{job_id:string;next:number};_etag?:string};
export type DatabaseOptions={endpoint:string;database?:string;container?:string;directoryContainer?:string;key?:string;batchSize?:number};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const memberActor=(token:string):Actor=>({issuer:'family-token',subject:digest(token),clientId:`member-${digest(token).slice(0,16)}`});
// Hashed so a member's name doesn't stay readable on stored records after it is forgotten.
const memberKey=(name:string)=>digest(`member:${name.normalize('NFKC').trim().toLowerCase()}`);
export const ownerKey=(actor:Pick<Actor,'issuer'|'subject'>)=>digest(JSON.stringify([actor.issuer,actor.subject]));
export const fieldId=(session:string,key:string)=>digest(JSON.stringify([session,key]));
const itemId=(kind:Kind,id:string)=>`${kind}_${id}`;
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const pack=(value:unknown)=>gzipSync(JSON.stringify(value)).toString('base64');
const unpack=(value:string)=>JSON.parse(gunzipSync(Buffer.from(value,'base64'),{maxOutputLength:32*1024*1024}).toString());
const encode=(kind:Kind,data:Row)=>kind==='proposals'&&data.payload?{...data,payload:undefined,payload_gzip:pack(data.payload)}:data;
const decode=(kind:Kind,data:Row)=>{const copy=structuredClone(data);if(kind==='proposals'&&copy.payload_gzip){copy.payload=unpack(copy.payload_gzip);delete copy.payload_gzip;}return copy;};
export const tokens=(text:string)=>[...new Set(text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[])].slice(0,2000);
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const match=(data:Row,filters:Filters={})=>Object.entries(filters).every(([key,value])=>Array.isArray(value)?value.some(v=>equal(data[key],v)):equal(data[key],value));
function matches(data:Row,query:Query){return match(data,query.where)&&(!query.or?.length||query.or.some(f=>match(data,f)))&&
  (!query.terms?.length||query.terms.some(term=>data.search_tokens?.includes(term)))&&
  (!query.asOf||((!data.valid_from||data.valid_from<=query.asOf)&&(!data.valid_to||data.valid_to>query.asOf)))&&(!query.relationshipsOnly||data.object_id!=null);}
function predicate(kind:Kind,vault:string,query:Query){
  const parameters:{name:string;value:any}[]=[{name:'@kind',value:kind},{name:'@vault',value:vault}];
  const param=(value:unknown)=>{const name=`@p${parameters.length}`;parameters.push({name,value});return name;};
  const path=(field:string)=>{requireThat(/^[a-z_]+$/.test(field),'invalid_query','Unsupported internal query field.');return `c.data.${field}`;};
  const filters=(values:Filters)=>Object.entries(values).map(([key,value])=>Array.isArray(value)?`ARRAY_CONTAINS(${param(value)},${path(key)})`:`${path(key)}=${param(value)}`).join(' AND ')||'true';
  const parts=['c.kind=@kind','c.vault_id=@vault',filters(query.where??{})];
  if(query.or?.length)parts.push(`(${query.or.map(f=>`(${filters(f)})`).join(' OR ')})`);
  if(query.terms?.length)parts.push(`(${query.terms.map(term=>`ARRAY_CONTAINS(c.data.search_tokens,${param(term)})`).join(' OR ')})`);
  if(query.asOf){const date=param(query.asOf);parts.push(`(IS_NULL(c.data.valid_from) OR c.data.valid_from<=${date}) AND (IS_NULL(c.data.valid_to) OR c.data.valid_to>${date})`);}
  if(query.relationshipsOnly)parts.push('NOT IS_NULL(c.data.object_id)');
  return {parameters,where:parts.join(' AND '),order:query.orderBy?` ORDER BY ${path(query.orderBy)} ${query.descending?'DESC':'ASC'}`:''};
}

/** Scoped unit of work. Queries always carry the authenticated vault's full partition key. */
export class Tx {
  readonly vault:string;revision:number;
  /** Entity ID of the signed-in family member; undefined for single-owner vaults. */
  self?:string;
  /** Directory grant of the signed-in family member, used to revoke capture credentials. */
  grant?:string;
  private cache=new Map<string,Row|null>();
  private existing=new Set<string>();
  readonly changes=new Map<string,OperationInput>();
  constructor(private db:Database,readonly head:Head){this.vault=head.vault_id;this.revision=head.revision;}
  async get(kind:Kind,id:string):Promise<any|undefined>{
    const key=itemId(kind,id);if(this.cache.has(key))return structuredClone(this.cache.get(key)??undefined);
    const resource=await this.db.read(this.db.container,key,this.vault);
    const data=resource?decode(kind,resource.data):null;
    this.cache.set(key,data);if(resource)this.existing.add(key);return structuredClone(data??undefined);
  }
  async find(kind:Kind,query:Query={}):Promise<any[]>{
    const q=predicate(kind,this.vault,query),limit=query.limit?query.limit+this.changes.size:50001;
    const response=await this.db.container.items.query<any>({query:`SELECT TOP ${limit} c.data FROM c WHERE ${q.where}${q.order}`,parameters:q.parameters},
      {partitionKey:this.vault,consistencyLevel:'Strong',maxItemCount:100}).fetchAll();
    requireThat(query.limit||response.resources.length<=50000,'scope_too_large','This operation exceeds the 50000-record review limit. Narrow the scope.');
    const rows=new Map<string,Row>();
    for(const row of response.resources){const data=decode(kind,row.data),key=itemId(kind,data.id);if(!this.cache.has(key))this.cache.set(key,data);this.existing.add(key);rows.set(key,data);}
    for(const [key,data] of this.cache)if(key.startsWith(kind+'_')){if(data)rows.set(key,data);else rows.delete(key);}
    let result=[...rows.values()].filter(data=>matches(data,query));
    if(query.orderBy){const field=query.orderBy,direction=query.descending?-1:1;result.sort((a,b)=>(a[field]<b[field]?-1:a[field]>b[field]?1:0)*direction);}
    if(query.limit)result=result.slice(0,query.limit);return structuredClone(result);
  }
  async put(kind:Kind,id:string,data:Row,embedding?:number[]){
    const key=itemId(kind,id),value={...data,id};this.cache.set(key,value);
    this.changes.set(key,{operationType:'Upsert',resourceBody:{id:key,vault_id:this.vault,kind,data:encode(kind,value),...(embedding?{embedding}:{})}});
  }
  async set(kind:Kind,id:string,updates:Row){
    const old=await this.get(kind,id);requireThat(old,'not_found','The record does not exist in this vault.',404);
    const data={...old,...updates},key=itemId(kind,id),pending=this.changes.get(key);
    this.cache.set(key,data);
    if(pending?.operationType==='Upsert')pending.resourceBody.data=encode(kind,data);
    else this.changes.set(key,{operationType:'Patch',id:key,resourceBody:{operations:[{op:'set',path:'/data',value:encode(kind,data)}]}});
  }
  async remove(kind:Kind,id:string){
    if(!await this.get(kind,id))return;
    const key=itemId(kind,id);this.cache.set(key,null);
    if(this.existing.has(key))this.changes.set(key,{operationType:'Delete',id:key});else this.changes.delete(key);
  }
  async semantic(embedding:number[],version:string,query:Query,limit=60){
    const q=predicate('claims',this.vault,{...query,where:{...query.where,embedding_version:version}});
    const response=await this.db.container.items.query<any>({query:`SELECT TOP ${limit} c.data FROM c WHERE ${q.where} AND IS_ARRAY(c.embedding) ORDER BY VectorDistance(c.embedding,@embedding)`,
      parameters:[...q.parameters,{name:'@embedding',value:embedding}]},{partitionKey:this.vault,consistencyLevel:'Strong',maxItemCount:100}).fetchAll();
    return response.resources.map(row=>row.data);
  }
}

export class Database {
  readonly client:CosmosClient;readonly container:Container;readonly directory:Container;
  private batchSize:number;
  constructor(readonly options:DatabaseOptions){
    this.client=new CosmosClient({endpoint:options.endpoint,...(options.key?{key:options.key}:{aadCredentials:new DefaultAzureCredential()}),
      consistencyLevel:'Strong',connectionPolicy:{enableEndpointDiscovery:!options.key,retryOptions:{maxRetryAttemptCount:5,maxWaitTimeInSeconds:20}}});
    const database=this.client.database(options.database??'memory');
    this.container=database.container(options.container??'vaults');this.directory=database.container(options.directoryContainer??'identities');
    this.batchSize=Math.min(options.batchSize??98,98);
  }
  async read(container:Container,id:string,partition:string){
    try{return (await container.item(id,partition).read<any>({consistencyLevel:'Strong'})).resource;}
    catch(error:any){if(error.code===404||error.statusCode===404)return undefined;throw error;}
  }
  private clean(head:Head):Head{return {id:'vault',vault_id:head.vault_id,owner_key:head.owner_key,revision:head.revision,active:head.active,...(head.maintenance?{maintenance:head.maintenance}:{})};}
  private async batch(vault:string,operations:OperationInput[]){
    let response;
    try{response=await this.container.items.batch(operations,vault,{contentResponseOnWriteEnabled:false});}
    catch(error:any){if([409,412].includes(Number(error.code??error.statusCode)))throw new MemoryError('concurrent_change','The vault changed. Retry the same request.',409);throw error;}
    const failures=response.result?.filter(result=>result.statusCode>=400)??[];
    if(response.code===412||failures.some(result=>[409,412].includes(result.statusCode)))throw new MemoryError('concurrent_change','The vault changed during this operation. Retry with the same request ID.',409);
    requireThat((response.code??500)<300&&!failures.length,'store_unavailable',`Cosmos DB could not commit this change (${failures.find(r=>r.statusCode!==424)?.statusCode??response.code}). Retry the same request.`,503);
  }
  /** Journal large changes before touching records; every request finishes a pending journal before entering a vault. */
  async recover(vault:string):Promise<Head|undefined>{
    const deadline=Date.now()+20000;
    for(let collision=0;Date.now()<deadline;){
      const head=await this.read(this.container,'vault',vault) as Head|undefined;
      if(!head?.maintenance)return head;
      const job=await this.read(this.container,head.maintenance.job_id,vault);
      requireThat(job,'store_integrity','A pending journal is missing; keep serving disabled and repair the store.',503);
      const actions=unpack(job.payload) as OperationInput[];
      requireThat(Array.isArray(actions)&&actions.length===job.action_count,'store_integrity','The pending journal failed validation.',503);
      const chunk:OperationInput[]=[];let size=2048;
      for(const action of actions.slice(head.maintenance.next)){
        const length=bytes(action);requireThat(length<1800000,'change_too_large','An individual record exceeds the supported write size.');
        if(chunk.length&&(chunk.length>=this.batchSize||size+length>1800000))break;
        chunk.push(action);size+=length;
      }
      const next=head.maintenance.next+chunk.length,finished=next>=actions.length;
      const updated=this.clean(head);if(finished)delete updated.maintenance;else updated.maintenance={job_id:job.id,next};
      try{await this.batch(vault,[{operationType:'Replace',id:'vault',ifMatch:head._etag,resourceBody:updated},...chunk,...(finished?[{operationType:'Delete' as const,id:job.id}]:[])]);}
      catch(error){if(error instanceof MemoryError&&error.code==='concurrent_change'&&collision++<10)continue;throw error;}
    }
    throw new MemoryError('vault_maintenance','A journaled change is still finishing. Retry this request; partial data is not exposed.',503);
  }
  async withVaultId<T>(vault:string,write:boolean,run:(tx:Tx)=>Promise<T>,expectedOwner?:string,allowInactive=false):Promise<T>{
    for(let attempt=0;attempt<4;attempt++){
      const head=await this.recover(vault);
      requireThat(head&&(head.active||allowInactive)&&(!expectedOwner||head.owner_key===expectedOwner),'not_invited','This identity has not been invited, or its access was revoked.',403);
      const tx=new Tx(this,head),result=await run(tx),actions=[...tx.changes.values()];
      try{
        if(!write||(!actions.length&&tx.revision===head.revision)){
          requireThat(!actions.length,'read_only_transaction','A read operation attempted to change the store.',500);
          const latest=await this.read(this.container,'vault',vault);
          requireThat(latest?._etag===head._etag,'concurrent_change','The vault changed during the read. Retry.',409);return result;
        }
        for(const action of actions)requireThat(bytes(action)<1750000,'change_too_large','An individual record exceeds the supported write size. No partial data was saved.');
        const updated=this.clean({...head,revision:tx.revision});
        if(actions.length<=this.batchSize&&bytes(actions)<1700000)
          await this.batch(vault,[{operationType:'Replace',id:'vault',ifMatch:head._etag,resourceBody:updated},...actions]);
        else{
          const payload=pack(actions);requireThat(payload.length<1750000&&bytes(actions)<32*1024*1024,'change_too_large','This change exceeds the journal size limit. Narrow the operation; no partial data was saved.');
          const id=`journal_${randomUUID()}`;updated.maintenance={job_id:id,next:0};
          await this.batch(vault,[{operationType:'Replace',id:'vault',ifMatch:head._etag,resourceBody:updated},
            {operationType:'Create',resourceBody:{id,vault_id:vault,kind:'journal',payload,action_count:actions.length}}]);
          await this.recover(vault);
        }
        return result;
      }catch(error){if(error instanceof MemoryError&&error.code==='concurrent_change'&&attempt<3)continue;throw error;}
    }
    throw new MemoryError('concurrent_change','The vault is busy; retry this request.',409);
  }
  async withVault<T>(actor:Actor,write:boolean,run:(tx:Tx)=>Promise<T>){
    const owner=ownerKey(actor),mapping=await this.read(this.directory,owner,owner);
    requireThat(mapping,'not_invited','This identity has not been invited, or its access was revoked.',403);
    // Family members share a vault; the directory mapping is the access grant.
    if(mapping.self_id)return this.withVaultId(mapping.vault_id,write,tx=>{tx.self=mapping.self_id;tx.grant=owner;return run(tx);});
    return this.withVaultId(mapping.vault_id,write,run,owner);
  }
  async hasGrant(actor:Actor){const owner=ownerKey(actor);return Boolean(await this.read(this.directory,owner,owner));}
  async addMember(name:string){
    const token=randomBytes(32).toString('base64url'),owner=ownerKey(memberActor(token));
    let family=await this.read(this.directory,'family','family');
    if(!family){
      const vault=randomUUID();
      await this.batch(vault,[{operationType:'Create',resourceBody:{id:'vault',vault_id:vault,owner_key:'family',revision:0,active:true}}]);
      try{await this.directory.items.create({id:'family',vault_id:vault});}
      catch(error:any){if(error.code!==409)throw error;}
      family=await this.read(this.directory,'family','family');
    }
    // A stable member key (not the editable display name) maps re-invitations to the same person,
    // and an existing non-member person with exactly this name is promoted instead of duplicated.
    const key=memberKey(name);
    const self=await this.withVaultId(family.vault_id,true,async tx=>{
      const member=(await tx.find('entities',{where:{member_key:key},limit:1}))[0];
      if(member)return member.id as string;
      const named=(await tx.find('entities',{where:{kind:'person',name},limit:2})).filter(e=>!e.member);
      if(named.length===1){await tx.set('entities',named[0].id,{member:true,member_key:key});tx.revision++;return named[0].id as string;}
      const id=randomUUID();
      await tx.put('entities',id,{id,kind:'person',name,aliases:[],is_self:false,member:true,member_key:key,search_tokens:tokens(name)});tx.revision++;
      return id;
    });
    await this.directory.items.create({id:owner,vault_id:family.vault_id,self_id:self,member_key:key});
    return token;
  }
  async removeMember(name:string){
    const rows=await this.directory.items.query<{id:string}>({query:'SELECT c.id FROM c WHERE c.member_key=@key OR c.member_name=@name',parameters:[{name:'@key',value:memberKey(name)},{name:'@name',value:name}]}).fetchAll();
    for(const row of rows.resources)await this.directory.item(row.id,row.id).delete();
    return rows.resources.length;
  }
  /** Current family token grants, exported with deletion receipts so a restore can't revive removed members. */
  async memberGrants(){return (await this.directory.items.query<{id:string}>('SELECT c.id FROM c WHERE IS_DEFINED(c.self_id)').fetchAll()).resources.map(r=>r.id);}
  async pruneGrants(keep:string[]){
    const allowed=new Set(keep),removed=(await this.memberGrants()).filter(id=>!allowed.has(id));
    for(const id of removed)await this.directory.item(id,id).delete();
    return removed.length;
  }
  async bump(tx:Tx){tx.revision++;}
  async withSessionSecret<T>(secret:string,pair:boolean,run:(tx:Tx,session:any)=>Promise<T>){
    const [vault,id,entropy,...rest]=secret.split('.');
    requireThat(!rest.length&&/^[0-9a-f-]{36}$/i.test(vault??'')&&/^[0-9a-f-]{36}$/i.test(id??'')&&/^[\w-]{40,}$/.test(entropy??''),'invalid_capture_secret','Invalid or expired capture token.',401);
    return this.withVaultId(vault!,true,async tx=>{
      const session=await tx.get('form_sessions',id!),hash=pair?'pair_hash':'capture_hash',expires=pair?'pair_expires':'capture_expires';
      requireThat(session&&session.status==='draft'&&session[hash]===digest(secret)&&Date.parse(session[expires])>Date.now(),'invalid_capture_secret','The pairing code or capture token is invalid, expired, or revoked.',401);
      // Family forms stop accepting capture once the member who started them is removed.
      // In the family vault every session must belong to a current member; sessions without a grant are refused.
      const family=session.grant?undefined:await this.read(this.directory,'family','family');
      requireThat(session.grant?await this.read(this.directory,session.grant,session.grant):family?.vault_id!==vault,'invalid_capture_secret','The pairing code or capture token is invalid, expired, or revoked.',401);
      return run(tx,session);
    });
  }
  async initialize(){
    const local=['localhost','127.0.0.1','[::1]'].includes(new URL(this.options.endpoint).hostname);
    if(local&&this.options.key){
      const {database}=await this.client.databases.createIfNotExists({id:this.options.database??'memory'});
      await database.containers.createIfNotExists({id:this.options.directoryContainer??'identities',partitionKey:{paths:['/id']}});
      await database.containers.createIfNotExists({id:this.options.container??'vaults',partitionKey:{paths:['/vault_id']},
        indexingPolicy:{indexingMode:'consistent',automatic:true,includedPaths:[{path:'/*'}],excludedPaths:[{path:'/embedding/*'},{path:'/payload/?'},{path:'/data/payload_gzip/?'}],vectorIndexes:[{path:'/embedding',type:VectorIndexType.DiskANN}]},
        vectorEmbeddingPolicy:{vectorEmbeddings:[{path:'/embedding',dataType:VectorEmbeddingDataType.Float32,distanceFunction:VectorEmbeddingDistanceFunction.Cosine,dimensions:1536}]}});
    }
    if(!local){const account=await this.client.getDatabaseAccount();requireThat(String(account.resource?.consistencyPolicy)==='Strong','store_configuration','This service requires Strong Cosmos consistency for coherent reads and forgetting.');}
    const [vaults,directory]=await Promise.all([this.container.read(),this.directory.read()]);
    requireThat(vaults.resource?.partitionKey?.paths?.[0]==='/vault_id'&&directory.resource?.partitionKey?.paths?.[0]==='/id','store_configuration','Cosmos containers have incompatible partition keys.');
    // The local vNext emulator omits vectorEmbeddingPolicy in read responses.
    const vector=vaults.resource?.vectorEmbeddingPolicy?.vectorEmbeddings?.find(v=>v.path==='/embedding');
    requireThat((local&&this.options.key||vector?.dimensions===1536&&vector.distanceFunction==='cosine')&&vaults.resource?.indexingPolicy?.vectorIndexes?.some(v=>v.path==='/embedding'),'store_configuration','The memory container requires a 1536-dimensional cosine vector index.');
  }
  async invite(actor:Pick<Actor,'issuer'|'subject'>,email?:string){
    const owner=ownerKey(actor),mapping=await this.read(this.directory,owner,owner);
    if(mapping){
      const head=await this.recover(mapping.vault_id);requireThat(head&&head.owner_key===owner,'store_integrity','The identity mapping is inconsistent.');
      await this.batch(head.vault_id,[{operationType:'Replace',id:'vault',ifMatch:head._etag,resourceBody:{...this.clean(head),active:true}}]);return head.vault_id;
    }
    const vault=randomUUID();
    await this.batch(vault,[{operationType:'Create',resourceBody:{id:'vault',vault_id:vault,owner_key:owner,revision:0,active:true}},
      {operationType:'Create',resourceBody:{id:itemId('entities',vault),vault_id:vault,kind:'entities',data:{id:vault,kind:'person',name:'Me',aliases:['me','I','myself'],is_self:true}}}]);
    try{await this.directory.items.create({id:owner,vault_id:vault,issuer:actor.issuer,subject:actor.subject,display_email:email??null});}
    catch(error:any){if(error.code!==409)throw error;const existing=await this.read(this.directory,owner,owner);requireThat(existing,'store_integrity','Invitation race could not be resolved.');return existing.vault_id;}
    return vault;
  }
  async close(){this.client.dispose();}
}

export const date=(value:unknown):string|null=>value==null?null:value instanceof Date?value.toISOString().slice(0,10):String(value);
