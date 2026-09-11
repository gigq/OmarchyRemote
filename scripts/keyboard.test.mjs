import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const source=html.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
function terminal(){
  const ctx=vm.createContext({DCLogic:class {props={};setState(p){Object.assign(this.state,p)}},requestAnimationFrame:f=>f(),document:{getElementById:()=>null},setTimeout,clearTimeout,setInterval,clearInterval});
  const c=vm.runInContext(source+';new Component()',ctx); c.openApp('terminal');c.set({kb:true});return c;
}
function type(c,text){for(const ch of text)c.type(ch===' '?'space':ch)}
test('typing, one-shot shift, middle insertion and Unicode deletion',()=>{
 const c=terminal();type(c,'echo ');c.type('⇧');type(c,'hello');assert.equal(c.state.input,'echo Hello');
 c.type('←');c.type('⌫');assert.equal(c.state.input,'echo Helo');c.type('end');type(c,'😀');c.type('⌫');assert.equal(c.state.input,'echo Helo');
});
test('Return echoes safe local output and history restores unfinished draft',()=>{
 const c=terminal();type(c,'echo hello 123');c.type('⏎');assert.equal(c.state.transcript.at(-1),'hello 123');assert.equal(c.state.input,'');
 type(c,'draft');c.type('↑');assert.equal(c.state.input,'echo hello 123');c.type('↓');assert.equal(c.state.input,'draft');
 c.edit('',0);type(c,'clear');c.type('⏎');assert.equal(c.state.transcript.length,0);
});
test('control editing and hide/reopen keep input',()=>{
 const c=terminal();type(c,'hello world');c.set({ctl:true});c.type('a');assert.equal(c.state.cursor,0);c.type('→');c.set({ctl:true});c.type('k');assert.equal(c.state.input,'h');
 c.renderVals().kbOff();c.renderVals().kbOn();assert.equal(c.state.input,'h');
 c.set({ctl:true});c.type('c');assert.equal(c.state.input,'');assert.equal(c.state.transcript.at(-1),'~ ❯ h^C');
});
test('launcher and super routing remain functional',()=>{
 const c=terminal();c.set({launch:true});type(c,'term');assert.equal(c.state.query,'term');assert.equal(c.state.input,'');c.type('⏎');assert.equal(c.cur(),'terminal');
 c.set({sup:true});const w=c.renderVals().kbRows.flatMap(r=>r.keys).find(k=>k.l==='files');w.on();assert.equal(c.cur(),'files');
});
test('held delete repeats and pointer cancellation stops it',async()=>{
 const c=terminal();type(c,'abcdefghij');const event={button:0,pointerId:1,preventDefault(){},stopPropagation(){},currentTarget:{setPointerCapture(){}}};
 c.pressKey(event,()=>c.type('⌫'),true);assert.equal(c.state.input,'abcdefghi');await new Promise(r=>setTimeout(r,550));c.keyEnd();const count=c.state.input.length;assert.ok(count<9);await new Promise(r=>setTimeout(r,100));assert.equal(c.state.input.length,count);
});

test('shifted symbols are inserted and shift resets',()=>{const c=terminal();c.type('⇧');c.type('1');c.type('2');assert.equal(c.state.input,'!2');c.type('⇧');c.type('/');assert.equal(c.state.input,'!2?')});

test('bottom swipes favor expo while keyboard stays in the outer corners',()=>{
  for(const width of [375,402,440]){
    for(const fraction of [.15,.25,.33,.5,.67,.75,.85]){
      const c=terminal();c.set({kb:false});
      c.ptr={x:width*fraction,y:870,cx:width*fraction,cy:870,w:width,h:874};
      c.up({clientX:width*.5,clientY:700});
      assert.equal(c.state.ov,true,'expo at '+fraction);assert.equal(c.state.kb,false);
    }
    for(const fraction of [.10,.90]){
      const c=terminal();c.set({kb:false});
      c.ptr={x:width*fraction,y:870,cx:width*fraction,cy:870,w:width,h:874};
      c.up({clientX:width*fraction,clientY:700});
      assert.equal(c.state.kb,true);assert.equal(c.state.sup,fraction>.5);assert.equal(c.state.ov,false);
    }
  }
});


test('workspace limit preserves existing navigation and permits opening after close',async()=>{
 const c=terminal();for(const key of Object.keys(c.APPS))c.openApp(key);
 assert.equal(c.state.open.length,10);
 c.APPS.extra={n:'extra'};c.openApp('extra');assert.equal(c.state.open.length,10);assert.ok(!c.state.open.includes('extra'));
 c.openApp('files');assert.equal(c.cur(),'files');
 await c.closeApp('files');c.openApp('extra');assert.equal(c.state.open.length,10);assert.equal(c.cur(),'extra');
});
