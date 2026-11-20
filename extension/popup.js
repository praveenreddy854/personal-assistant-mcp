const byId=id=>document.getElementById(id);
async function refresh(){
  const state=await chrome.runtime.sendMessage({type:'capture:status'});
  if(!byId('server').value) byId('server').value=state.server??'http://localhost:3000';
  byId('status').textContent=state.active?'Capturing paired form':'Not capturing';
  byId('details').textContent=state.error??state.pageOrigin??'Start a form session through your agent to get a pairing code.';
  byId('pending').textContent=state.pending?`${state.pending} field changes waiting to upload`:'All queued changes uploaded';
  byId('stop').hidden=!state.active;
}
byId('pair-form').addEventListener('submit',async event=>{
  event.preventDefault();byId('start').disabled=true;
  try{
    const server=new URL(byId('server').value);
    if(server.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(server.hostname)) throw new Error('Use HTTPS for the memory server.');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const page=new URL(tab.url);
    if(!['http:','https:'].includes(page.protocol)) throw new Error('Open a supported website form in the active tab.');
    const permissions={origins:[`${server.origin}/*`,`${page.origin}/*`]};
    if(!await chrome.permissions.contains(permissions) && !await chrome.permissions.request(permissions)) throw new Error('Website access was not granted.');
    const result=await chrome.runtime.sendMessage({type:'capture:start',server:server.origin,code:byId('code').value.trim(),tabId:tab.id,pageOrigin:page.origin});
    if(result.error) throw new Error(result.error);
    byId('code').value='';await refresh();
  }catch(error){byId('status').textContent='Capture did not start';byId('details').textContent=error.message;}
  finally{byId('start').disabled=false;}
});
byId('stop').addEventListener('click',async()=>{await chrome.runtime.sendMessage({type:'capture:stop'});await refresh();});
void refresh();setInterval(()=>void refresh(),1500);
