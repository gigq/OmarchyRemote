import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {WebSocket} from 'ws';
import net from 'node:net';
const root=path.resolve(import.meta.dirname,'..');
const wait=async fn=>{let last;for(let n=0;n<100;n++){const value=await fn().catch(e=>{last=e;return null});if(value)return value;await new Promise(r=>setTimeout(r,100))}throw Error('Timed out waiting for browser bridge: '+(last?.message||''))};

test('real isolated Vivaldi mirrors windows/workspaces and acknowledges tab changes',{timeout:60000},async()=>{
 const temp=await mkdtemp(path.join(tmpdir(),'omarchy-browser-'));let backend,context,vivaldi;
 const token=randomBytes(32).toString('hex'),socket=path.join(temp,'bridge.sock');
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const env={...process.env,OMARCHY_PROXY_TOKEN:token,OMARCHY_API_PORT:String(port),OMARCHY_BROWSER_SOCKET:socket};
 const api=async(route,data)=>{const r=await fetch(`http://127.0.0.1:${port}/api/browser/${route}`,{method:data?'POST':'GET',headers:{'X-Omarchy-Proxy':token,'X-Hyprland-Client':'1','Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});return {status:r.status,body:await r.json()}};
 try{
  backend=spawn(root+'/backend/target/release/omarchy-remote',[],{env,stdio:['ignore','pipe','pipe']});let logs='';backend.stderr.on('data',b=>logs+=b);await wait(async()=>{if(backend.exitCode!==null)throw Error(logs);return (await api('snapshot')).status===200});
  const profile=path.join(temp,'profile');await mkdir(profile+'/NativeMessagingHosts',{recursive:true});
  const wrapper=path.join(temp,'native-host');await writeFile(wrapper,`#!/bin/sh\nexport OMARCHY_BROWSER_SOCKET='${socket}'\nexport OMARCHY_VIVALDI_DATA_DIR='${profile}'\nexec '${root}/backend/target/release/omarchy-remote' --browser-bridge "$@"\n`,{mode:0o700});
  const id=(await readFile(root+'/browser-extension/extension-id.txt','utf8')).trim();await writeFile(profile+'/NativeMessagingHosts/com.omarchy.remote_browser.json',JSON.stringify({name:'com.omarchy.remote_browser',description:'Isolated test',path:wrapper,type:'stdio',allowed_origins:[`chrome-extension://${id}/`]}));
  const config=path.join(temp,'config');await mkdir(config+'/vivaldi/NativeMessagingHosts',{recursive:true});await writeFile(config+'/vivaldi/NativeMessagingHosts/com.omarchy.remote_browser.json',await readFile(profile+'/NativeMessagingHosts/com.omarchy.remote_browser.json'));
  vivaldi=spawn('/usr/bin/vivaldi',['--user-data-dir='+profile,'--enable-unsafe-extension-debugging','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--running-vivaldi','--ozone-platform=headless','--disable-gpu','--no-sandbox','--no-first-run','about:blank'],{env:{...env,XDG_CONFIG_HOME:config},stdio:['ignore','pipe','pipe']});
  let browserLog='';vivaldi.stderr.on('data',b=>browserLog+=b);
  const debugPort=await wait(async()=>{if(vivaldi.exitCode!==null)throw Error(browserLog.slice(-1500));return (await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0]});
  const version=await(await fetch('http://127.0.0.1:'+debugPort+'/json/version')).json();
  const ws=new WebSocket(version.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});let sequence=0;const pending=new Map();
  ws.on('message',data=>{const m=JSON.parse(data);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}});
  const cdp=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},5000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params,sessionId}))});
  context={close:async()=>{await cdp('Browser.close').catch(()=>{});ws.close()}};
  console.log('Isolated debugger connected');await cdp('Extensions.loadUnpacked',{path:root+'/browser-extension'});
  const workerTarget=await wait(async()=>(await cdp('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.includes(id)));
  const session=(await cdp('Target.attachToTarget',{targetId:workerTarget.targetId,flatten:true})).sessionId;
  const worker={evaluate:async(fn,arg)=>{const result=await cdp('Runtime.evaluate',{expression:'('+fn.toString()+')('+JSON.stringify(arg)+')',awaitPromise:true,returnByValue:true},session);if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));return result.result.value}};
  let first=await wait(async()=>{const d=(await api('snapshot')).body;return d.instances?.[0]});
  console.log('Native bridge connected');const create=await api('action',{instance_id:first.id,action:'create',url:'https://example.com/',new_window:true});assert.equal(create.status,200,JSON.stringify(create.body));
  const tab=await wait(async()=>{const d=(await api('snapshot')).body.instances[0];return d.windows.flatMap(w=>w.tabs).find(t=>t.url==='https://example.com/')});
  let snap=(await api('snapshot')).body.instances[0];assert.ok(snap.windows.length>=2);
  const target=snap.windows.find(w=>!w.tabs.some(t=>t.id===tab.id));
  // The internal Vivaldi context creates fixture metadata; the ordinary extension
  // must obtain grouping through the native read-only session adapter instead.
  const core=(await cdp('Target.getTargets')).targetInfos.find(t=>t.type==='app'&&t.url.endsWith('/main.html'));
  const coreSession=(await cdp('Target.attachToTarget',{targetId:core.targetId,flatten:true})).sessionId;
  const metadata=await cdp('Runtime.evaluate',{expression:`chrome.tabs.update(${tab.id},{vivExtData:JSON.stringify({workspaceId:991122})})`,awaitPromise:true,returnByValue:true},coreSession);
  assert.equal(metadata.exceptionDetails,undefined,JSON.stringify(metadata.exceptionDetails));
  await wait(async()=>(await api('snapshot')).body.instances[0].workspaces.some(w=>w.id===991122));
  assert.equal((await api('snapshot')).body.instances[0].id,first.id,'Native connection stays stable across periodic snapshots');
  for(const action of [{action:'pin',value:true},{action:'mute',value:true},{action:'move',window_id:target.id,index:0}]){const result=await api('action',{instance_id:first.id,tab_id:tab.id,...action});assert.equal(result.status,200,JSON.stringify({action,...result}));}
  snap=(await api('snapshot')).body.instances[0];const moved=snap.windows.find(w=>w.id===target.id).tabs.find(t=>t.id===tab.id);assert.ok(moved);assert.equal(moved.workspace_id,991122);assert.equal(moved.muted,true);
  assert.equal((await api('action',{instance_id:first.id,action:'close',tab_id:tab.id})).status,200);
  await wait(async()=>!(await api('snapshot')).body.instances[0].windows.flatMap(w=>w.tabs).some(t=>t.id===tab.id));
  assert.equal((await api('action',{instance_id:first.id,action:'close',tab_id:tab.id})).status,400);
  await context.close();context=null;await wait(async()=>(await api('snapshot')).body.instances.length===0);
 }finally{await context?.close();if(vivaldi&&vivaldi.exitCode===null){vivaldi.kill('SIGTERM');await Promise.race([new Promise(r=>vivaldi.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);if(vivaldi.exitCode===null)vivaldi.kill('SIGKILL');}if(backend&&backend.exitCode===null){backend.kill('SIGTERM');await Promise.race([new Promise(r=>backend.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);if(backend.exitCode===null)backend.kill('SIGKILL')}await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200})}
});
