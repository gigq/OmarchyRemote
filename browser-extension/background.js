/* Vivaldi adapter. This extension never reads cookies or page contents. */
let connecting=false;
let port=null,reconnect=null,refreshTimer=null,settings=null,queue=Promise.resolve();
const ext=t=>{try{return JSON.parse(t.vivExtData||'{}')}catch{return{}}};
async function snapshot(){
 if(!port)return;
 const windows=await chrome.windows.getAll({populate:true});const workspaces=new Map();
 const data=windows.filter(w=>!w.incognito).map(w=>({id:w.id,type:w.type,focused:w.focused,tabs:(w.tabs||[]).filter(t=>!t.incognito).map(t=>{
  const v=ext(t),workspace=v.workspaceId||0;if(workspace)workspaces.set(workspace,{id:workspace,name:'Workspace '+workspace});
  return {id:t.id,title:v.fixedTitle||t.title||'New tab',url:t.pendingUrl||t.url||'',index:t.index,active:t.active,pinned:t.pinned,muted:!!t.mutedInfo?.muted,audible:!!t.audible,discarded:!!t.discarded,workspace_id:workspace,stack_id:v.group||null};
 })}));
 port?.postMessage({type:'snapshot',adapter:'vivaldi',profile_id:settings.profileId,label:settings.label||'Vivaldi',profile_folder:settings.profileFolder||'Default',workspace_write:windows.some(w=>(w.tabs||[]).some(t=>Object.hasOwn(t,'vivExtData'))),windows:data,workspaces:[...workspaces.values()]});
}
function refresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(()=>snapshot().catch(()=>{}),120)}
async function command(q){
 if(q.expires<Date.now())throw Error('Action expired; refresh the tab list');
 const tabs=await chrome.tabs.query({});const tab=q.action==='create'?null:tabs.find(t=>t.id===q.tab_id&&!t.incognito);
 if(q.action!=='create'&&!tab)throw Error('Tab is no longer open');
 if(q.action==='create'){
  const url=new URL(q.url);if(!['https:','http:'].includes(url.protocol))throw Error('Use an http or https URL');
  if(q.new_window){const w=await chrome.windows.create({url:url.href,focused:false});return {window_id:w.id}}
  const options={url:url.href,active:false};if(q.window_id!=null)options.windowId=q.window_id;
  if(q.workspace_id)options.vivExtData=JSON.stringify({workspaceId:q.workspace_id});
  const created=await chrome.tabs.create(options);return {tab_id:created.id};
 }
 switch(q.action){
  case 'close':await chrome.tabs.remove(tab.id);break;
  case 'focus':await chrome.tabs.update(tab.id,{active:true});await chrome.windows.update(tab.windowId,{focused:true});break;
  case 'reload':await chrome.tabs.reload(tab.id);break;
  case 'pin':await chrome.tabs.update(tab.id,{pinned:!!q.value});break;
  case 'mute':await chrome.tabs.update(tab.id,{muted:!!q.value});break;
  case 'move':{
   if(q.workspace_id!=null&&!Object.hasOwn(tab,'vivExtData'))throw Error('Workspace changes are not supported by this Vivaldi extension API');
   if(q.window_id!==tab.windowId)await chrome.tabs.move(tab.id,{windowId:q.window_id,index:-1});
   if(q.workspace_id!=null){const current=await chrome.tabs.get(tab.id);const data=ext(current);if(q.workspace_id) data.workspaceId=q.workspace_id;else delete data.workspaceId;await chrome.tabs.update(tab.id,{vivExtData:JSON.stringify(data)})}
   if(Number.isInteger(q.index))await chrome.tabs.move(tab.id,{index:q.index});
   break;
  }
  default:throw Error('Unsupported browser action');
 }
 return{};
}
async function connect(){
 if(port||connecting)return;connecting=true;try{settings=await chrome.storage.local.get(['profileId','profileFolder','label']);
 if(!settings.profileId){settings.profileId=crypto.randomUUID();await chrome.storage.local.set({profileId:settings.profileId})}
 const current=chrome.runtime.connectNative('com.omarchy.remote_browser');port=current;
 current.onDisconnect.addListener(()=>{void chrome.runtime.lastError;if(port===current)port=null;chrome.action.setBadgeText({text:'!'});clearTimeout(reconnect);reconnect=setTimeout(connect,3000)});
 current.onMessage.addListener(q=>{if(q.type!=='command')return;
  // Serialize changes; commands expire rather than replaying after an outage.
  queue=queue.then(async()=>{try{const result=await command(q);await snapshot();current.postMessage({type:'reply',id:q.id,ok:true,result})}catch(e){try{current.postMessage({type:'reply',id:q.id,ok:false,error:e.message})}catch{}}await snapshot().catch(()=>{})});
 });
 chrome.action.setBadgeText({text:''});await snapshot().catch(()=>{});
 }finally{connecting=false}
}
for(const event of [chrome.tabs.onCreated,chrome.tabs.onRemoved,chrome.tabs.onUpdated,chrome.tabs.onMoved,chrome.tabs.onAttached,chrome.tabs.onDetached,chrome.tabs.onActivated,chrome.windows.onCreated,chrome.windows.onRemoved,chrome.windows.onFocusChanged])event.addListener(refresh);
chrome.storage.onChanged.addListener(async()=>{settings=await chrome.storage.local.get(['profileId','profileFolder','label']);refresh()});
chrome.alarms.onAlarm.addListener(()=>{if(port)refresh();else connect()});chrome.alarms.create('connection',{periodInMinutes:.5});
chrome.runtime.onStartup.addListener(connect);chrome.runtime.onInstalled.addListener(connect);connect();

setInterval(()=>{if(port)snapshot().catch(()=>{})},5000);
