(()=>{
  if(globalThis.__personalMemorySnapshot)return;
  const deviceId=crypto.randomUUID(),seen=new Map(),forgotten=new Set();let sequence=0,scanning=null,rerun=false;
  const all=(root,selector)=>{
    const found=[...root.querySelectorAll(selector)];
    for(const element of root.querySelectorAll('*'))if(element.shadowRoot)found.push(...all(element.shadowRoot,selector));
    return found;
  };
  const label=element=>(element.getAttribute('aria-label')||[...(element.labels??[])].map(l=>l.textContent).join(' ')||element.closest('label')?.textContent||element.getAttribute('name')||element.id||'Unlabeled field').trim().slice(0,500);
  const opaque=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  async function scan(origin='snapshot'){
    if(scanning){rerun=true;await scanning;if(rerun){rerun=false;return scan(origin);}return;}
    scanning=(async()=>{
      const context=await chrome.runtime.sendMessage({type:'capture:get-context'});if(!context)return;
      const elements=all(document,'input,textarea,select'),events=[],radioSeen=new Set();
      for(const [index,element] of elements.entries()){
        const type=(element.type??element.tagName).toLowerCase();
        if(['password','hidden','file','submit','button','reset','image'].includes(type)||['one-time-code','current-password','new-password'].includes(element.autocomplete)||element.disabled)continue;
        const form=element.form,formIndex=form?[...document.forms].indexOf(form):-1;
        let shadowPath='',node=element;
        while(node.getRootNode().host){node=node.getRootNode().host;shadowPath=`${node.tagName}#${node.id}|`+shadowPath;}
        const identity=`${location.pathname}|${context.frameId}|${shadowPath}|${form?.id||form?.getAttribute('name')||formIndex}|${(type==='radio'?element.name:null)||element.id||element.name||label(element)||index}|${type}`;
        let fieldLabel=label(element),value;
        if(type==='radio'){
          if(radioSeen.has(identity))continue;radioSeen.add(identity);
          const group=elements.filter(e=>e.type==='radio'&&e.name===element.name&&e.form===form);
          value=group.find(e=>e.checked)?.value??null;
          fieldLabel=element.closest('fieldset')?.querySelector('legend')?.textContent?.trim()||element.name||fieldLabel;
        }else if(type==='checkbox')value=element.checked;
        else if(element.tagName==='SELECT'&&element.multiple)value=[...element.selectedOptions].map(option=>option.value);
        else value=element.value;
        const key=await opaque(identity+(type==='checkbox'?`|${element.value}|${fieldLabel}`:''));
        if(forgotten.has(key))continue;
        const serialized=JSON.stringify({value,label:fieldLabel});
        if(seen.get(key)===serialized)continue;
        events.push({event_id:crypto.randomUUID(),device_id:deviceId,sequence:++sequence,field_key:key,label:fieldLabel.slice(0,500),value,
          input_type:type,observed_at:new Date().toISOString(),page_path:location.pathname.slice(0,1000),origin});
      }
      for(let offset=0;offset<events.length;offset+=100){
        const batch=events.slice(offset,offset+100),result=await chrome.runtime.sendMessage({type:'capture:events',events:batch});
        if(result?.error)throw new Error(result.error);
        if(result?.queued)for(const event of batch)seen.set(event.field_key,JSON.stringify({value:event.value,label:event.label}));
      }
      return {fields:elements.length,changes:events.length};
    })();
    try{return await scanning;}finally{scanning=null;}
  }
  let timer;
  const changed=()=>{clearTimeout(timer);timer=setTimeout(()=>void scan('user').catch(()=>{}),120);};
  document.addEventListener('input',changed,true);document.addEventListener('change',changed,true);
  document.addEventListener('focusout',()=>void scan('user').catch(()=>{}),true);
  globalThis.__personalMemorySnapshot=()=>scan('snapshot');
  globalThis.__personalMemoryForgetFields=keys=>{for(const key of keys){forgotten.add(key);seen.delete(key);}};
  setInterval(()=>void scan('programmatic').catch(()=>{}),1000);
  void scan().catch(()=>{});
})();
