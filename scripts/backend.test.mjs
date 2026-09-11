import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { WebSocket } from 'ws';
const base=process.env.REMOTE_TEST_URL||'http://127.0.0.1:4187';
async function api(path,body){const r=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Hyprland-Client':'1','Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();assert.equal(r.status,200,JSON.stringify(value));return value;}
function herdr(method,params){return new Promise((resolve,reject)=>{const s=net.createConnection(process.env.OMARCHY_HERDR_SOCKET||`${process.env.HOME}/.config/herdr/herdr.sock`);s.setTimeout(8000);let buffer='';s.on('connect',()=>s.write(JSON.stringify({id:'omarchy-integration-test',method,params})+'\n'));s.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){s.end();const r=JSON.parse(buffer.split('\n')[0]);r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result)}});s.on('error',reject);s.on('timeout',()=>{s.destroy();reject(Error('Herdr timeout'))})})}
async function connect(path){const ws=new WebSocket(base.replace(/^http/,'ws')+'/api/'+path,{origin:base});const messages=[];ws.on('message',data=>messages.push(JSON.parse(data)));await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});return{ws,messages,send:v=>ws.send(JSON.stringify(v)),wait:async predicate=>{const until=Date.now()+10000;while(Date.now()<until){const found=messages.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,30))}throw Error('WebSocket message timeout')}}}

test('host gateway rejects cross-site requests and unknown hosts',async()=>{
 assert.equal((await fetch(base+'/api/capabilities')).status,403);
 assert.equal((await fetch(base+'/api/capabilities',{headers:{'X-Hyprland-Client':'1',Origin:'https://attacker.invalid'}})).status,403);
 assert.equal(await new Promise(resolve=>http.get(base+'/api/capabilities',{headers:{'X-Hyprland-Client':'1',Host:'attacker.invalid'}},r=>{r.resume();resolve(r.statusCode)})),403);
 const status=await new Promise(resolve=>{const ws=new WebSocket(base.replace(/^http/,'ws')+'/api/herdr/ws',{origin:'https://attacker.invalid'});ws.on('unexpected-response',(_,r)=>{resolve(r.statusCode);r.resume();ws.terminate()});ws.on('error',()=>{})});assert.equal(status,403);
 assert.equal((await api('capabilities')).apps.length,2);
});

test('persistent real shell accepts input, resizes, and reconnects',async()=>{
 const session=await api('terminal/session',{});let c=await connect(`terminal/${session.id}/ws`);
 try{
  await c.wait(m=>m.type==='screen');c.send({type:'resize',cols:60,rows:20});
  // Wait until interactive shell initialization has finished before submitting.
  await new Promise(r=>setTimeout(r,700));
  c.send({type:'input',data:"printf '\\nMOBILE_REAL_SHELL\\n'; stty size\r"});
  await c.wait(()=>c.messages.filter(m=>m.type==='output').map(m=>Buffer.from(m.data).toString()).join('').includes('20 60'));
  c.ws.close();c=await connect(`terminal/${session.id}/ws`);const screen=await c.wait(m=>m.type==='screen');
  assert.ok(Buffer.from(screen.data).toString().includes('MOBILE_REAL_SHELL'));assert.equal(screen.cols,60);assert.equal(screen.rows,20);
  assert.equal((await api('terminal/session',{id:session.id})).resumed,true);
  c.send({type:'input',data:'exit\r'});await c.wait(m=>m.type==='exit');
  assert.equal((await api(`terminal/${session.id}/close`,{})).closed,true);
 }finally{c.ws.close()}
});

test('real Herdr snapshot, selected pane output, literal input and Return',async()=>{
 let workspace;
 try{
  const created=await herdr('workspace.create',{label:'Omarchy automated test',cwd:'/tmp',focus:false});
  workspace=created.workspace?.workspace_id||created.workspace_id;assert.ok(workspace,JSON.stringify(created));
  const snap=await api('herdr/snapshot');const pane=snap.panes.find(p=>p.workspace_id===workspace);assert.ok(pane);
  const c=await connect('herdr/ws');
  try{
   await c.wait(m=>m.type==='snapshot');c.send({type:'select',pane_id:pane.pane_id});await c.wait(m=>m.type==='pane');
   c.send({type:'input',id:'test-input',pane_id:pane.pane_id,text:"printf 'HERDR_MOBILE_%s\\n' OK",keys:['Enter']});
   await c.wait(m=>m.type==='ack'&&m.id==='test-input');
   await c.wait(m=>m.type==='pane'&&m.read.text.includes('HERDR_MOBILE_OK'));
   const read=await api('herdr/panes/'+encodeURIComponent(pane.pane_id));assert.ok(read.text.includes('HERDR_MOBILE_OK'));
   c.send({type:'select',pane_id:null});c.send({type:'input',id:'wrong-pane',pane_id:pane.pane_id,text:'DO_NOT_SEND',keys:[]});
   await c.wait(m=>m.type==='input_error'&&m.id==='wrong-pane');
  }finally{c.ws.close()}
 }finally{if(workspace)await herdr('workspace.close',{workspace_id:workspace})}
});

test('closing an app-owned shell ends it without affecting another session',async()=>{
 const first=await api('terminal/session',{}),second=await api('terminal/session',{});
 const a=await connect(`terminal/${first.id}/ws`),b=await connect(`terminal/${second.id}/ws`);
 try{
  await a.wait(m=>m.type==='screen');await b.wait(m=>m.type==='screen');
  assert.equal((await api(`terminal/${first.id}/close`,{})).closed,true);await a.wait(m=>m.type==='exit');
  assert.equal((await api('terminal/session',{id:second.id})).resumed,true);
  assert.equal((await api(`terminal/${first.id}/close`,{})).closed,true);
 }finally{await api(`terminal/${first.id}/close`,{});await api(`terminal/${second.id}/close`,{});a.ws.close();b.ws.close()}
});
