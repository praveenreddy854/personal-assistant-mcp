let queueLock=Promise.resolve(),flushPromise=null,lastError=null;
const locked=fn=>{const result=queueLock.then(fn);queueLock=result.catch(()=>{});return result;};
const binding=async()=>(await chrome.storage.session.get('binding')).binding;
const queue=async()=>(await chrome.storage.local.get('pending')).pending??[];
async function api(state,path,body){
  const response=await fetch(state.server+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${state.token}`},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();if(!response.ok){const error=new Error(result.message??`Capture request failed (${response.status})`);error.code=result.code;throw error;}return result;
}
async function flush(){
  if(flushPromise) return flushPromise;
  flushPromise=(async()=>{
    const state=await binding();if(!state)return;
    while(true){
      const batch=(await queue()).filter(item=>item.sessionId===state.sessionId).slice(0,100);
      if(!batch.length)return;
      await api(state,'/api/capture/events',{events:batch.map(item=>item.event)});
      const ids=new Set(batch.map(item=>item.event.event_id));
      await locked(async()=>{await chrome.storage.local.set({pending:(await queue()).filter(item=>!ids.has(item.event.event_id))});});
      lastError=null;
    }
  })().catch(error=>{lastError=error.message;}).finally(()=>{flushPromise=null;});
  return flushPromise;
}
async function frames(state){
  const all=await chrome.webNavigation.getAllFrames({tabId:state.tabId});
  return (all??[]).filter(frame=>{try{return new URL(frame.url).origin===state.pageOrigin;}catch{return false;}}).map(frame=>frame.frameId);
}
async function inject(state){
  const frameIds=await frames(state);if(!frameIds.length)throw new Error('The paired tab is no longer on its selected website.');
  await chrome.scripting.executeScript({target:{tabId:state.tabId,frameIds},files:['capture.js']});
  return frameIds;
}
let ticking=false;
async function tick(){
  if(ticking)return;ticking=true;
  try{
    const state=await binding();if(!state)return;
    const status=await api(state,'/api/capture/status');
    if(status.forgotten_field_keys?.length){
      const removed=new Set(status.forgotten_field_keys);
      await locked(async()=>{await chrome.storage.local.set({pending:(await queue()).filter(item=>item.sessionId!==state.sessionId||!removed.has(item.event.field_key))});});
      const frameIds=await frames(state);
      if(frameIds.length)await chrome.scripting.executeScript({target:{tabId:state.tabId,frameIds},func:keys=>globalThis.__personalMemoryForgetFields?.(keys),args:[status.forgotten_field_keys]});
    }
    await flush();
    if(status.snapshot_challenge){
      const frameIds=await inject(state);
      await chrome.scripting.executeScript({target:{tabId:state.tabId,frameIds},func:async()=>{
        if(!globalThis.__personalMemorySnapshot)throw new Error('Form capture is unavailable in this frame.');
        return globalThis.__personalMemorySnapshot();
      }});
      await flush();
      const pending=(await queue()).filter(item=>item.sessionId===state.sessionId).length;
      if(!pending)await api(state,'/api/capture/checkpoint',{challenge:status.snapshot_challenge,pending_count:0});
    }
  }catch(error){
    lastError=error.message;
    if(error.code==='invalid_capture_secret'){await chrome.storage.session.remove('binding');lastError='Capture ended or expired. Use your agent to re-pair an unfinished form.';}
  }finally{ticking=false;}
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  (async()=>{
    if(message.type==='capture:start'){
      const tab=await chrome.tabs.get(message.tabId);
      if(new URL(tab.url).origin!==message.pageOrigin)throw new Error('The active page changed before pairing.');
      const server=new URL(message.server);
      if(server.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(server.hostname))throw new Error('Use an HTTPS memory server.');
      const response=await fetch(server.origin+'/api/capture/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pairing_code:message.code,page_origin:message.pageOrigin})});
      const result=await response.json();if(!response.ok)throw new Error(result.message??'Pairing failed.');
      const state={server:server.origin,token:result.capture_token,sessionId:result.session_id,pageOrigin:result.page_origin,tabId:message.tabId};
      await chrome.storage.session.set({binding:state});await chrome.storage.local.set({server:state.server});
      await inject(state);lastError=null;await chrome.alarms.create('memory-capture',{periodInMinutes:0.5});void tick();
      return {ok:true};
    }
    if(message.type==='capture:get-context'){
      const state=await binding();
      return state&&sender.tab?.id===state.tabId&&new URL(sender.url).origin===state.pageOrigin?{sessionId:state.sessionId,frameId:sender.frameId}:null;
    }
    if(message.type==='capture:events'){
      const state=await binding();
      if(!state||sender.tab?.id!==state.tabId||new URL(sender.url).origin!==state.pageOrigin)return {ignored:true};
      if(!Array.isArray(message.events)||message.events.length>100)throw new Error('Invalid field batch.');
      await locked(async()=>{
        const pending=await queue();if(pending.length+message.events.length>5000)throw new Error('Capture buffer is full. Reconnect before editing more fields.');
        await chrome.storage.local.set({pending:[...pending,...message.events.map(event=>({sessionId:state.sessionId,event}))]});
      });
      void flush();return {queued:true};
    }
    if(message.type==='capture:status'){
      const state=await binding();return {active:!!state,pageOrigin:state?.pageOrigin,server:(await chrome.storage.local.get('server')).server,pending:(await queue()).length,error:lastError};
    }
    if(message.type==='capture:stop'){await flush();await chrome.storage.session.remove('binding');await chrome.alarms.clear('memory-capture');return {ok:true};}
    return {error:'Unsupported capture message.'};
  })().then(reply,error=>reply({error:error.message}));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==='memory-capture')void tick();});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='complete')void binding().then(state=>{if(state?.tabId===tabId)return inject(state);}).catch(error=>{lastError=error.message;});});
// A service worker can stop between messages; alarms retain offline retry behavior.
setInterval(()=>void tick(),2000);
