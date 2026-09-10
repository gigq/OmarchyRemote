import {test,expect} from '@playwright/test';
import net from 'node:net';
async function herdr(method,params){return new Promise((resolve,reject)=>{const s=net.createConnection(`${process.env.HOME}/.config/herdr/herdr.sock`);let text='';s.setTimeout(8000);s.on('connect',()=>s.write(JSON.stringify({id:'mobile-scroll-test',method,params})+'\n'));s.on('data',chunk=>{text+=chunk;if(text.includes('\n')){s.end();const r=JSON.parse(text.split('\n')[0]);r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result)}});s.on('error',reject);s.on('timeout',()=>{s.destroy();reject(Error('Herdr timeout'))})})}
import {captureTerminals,visibleText,exitShell} from './terminal-helper.mjs';
async function state(page){return page.evaluate(()=>{const t=window.qaTerms[0],b=t.buffer.active;return{top:b.viewportY,bottom:b.baseY,first:b.getLine(b.viewportY)?.translateToString(true),last:b.getLine(b.length-1)?.translateToString(true)}})}
async function drag(page,from,to){const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:from}]});for(let i=1;i<=6;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y:from+(to-from)*i/6}]});await page.waitForTimeout(20)}await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach()}
async function stopCoast(page){const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:400}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach()}
async function key(page,label){const field=page.locator('.native-input:visible');if(label==='⏎')await field.press('Enter');else await field.pressSequentially(label==='space'?' ':label)}

test('Terminal touch drags read history without opening the keyboard',async({page})=>{
 await captureTerminals(page);await page.goto('/native/');await page.getByText('terminal',{exact:true}).first().click();await expect(page.locator('#remote-terminal-app')).toContainText('HOST · connected');
 try{
  await page.evaluate(()=>qaTerms[0].input('seq 1 160\r'));
  await expect.poll(async()=>(await state(page)).bottom).toBeGreaterThan(90);
  await drag(page,300,550);
  await page.waitForTimeout(250);
  const pixels=await page.locator('.remote-terminal .native-terminal-scroll').evaluate(el=>{const before=el.scrollTop;el.scrollTop=before-5;return {before,after:el.scrollTop}});expect(pixels.before-pixels.after).toBeCloseTo(5,0);
  await expect.poll(async()=>{const s=await state(page);return s.bottom-s.top}).toBeGreaterThan(10);
  await expect(page.locator('#remote-terminal-app')).not.toHaveClass(/with-keyboard/);
  await expect(page.getByRole('button',{name:'↓ Latest'})).toBeVisible();
  const before=(await state(page)).top;await drag(page,650,450);await expect.poll(async()=>(await state(page)).top).toBeGreaterThan(before);
  await page.getByRole('button',{name:'↓ Latest'}).click();await page.waitForTimeout(250);await expect.poll(async()=>{const s=await state(page);return s.bottom-s.top}).toBe(0);
 }finally{await exitShell(page);await expect(page.locator('#remote-terminal-app')).toContainText('Shell exited')}
});

test('Herdr touch history stays anchored during updates and typed text is visible',async({page})=>{
 let workspace;
 try{
  const created=await herdr('workspace.create',{label:'Mobile scrolling test',cwd:'/tmp',focus:false});workspace=created.workspace.workspace_id;
  const snap=(await herdr('session.snapshot',{})).snapshot;const pane=snap.panes.find(p=>p.workspace_id===workspace).pane_id;
  await herdr('pane.send_input',{pane_id:pane,text:'seq 1 160',keys:['Enter']});
  await captureTerminals(page);await page.goto('/native/');await page.getByText('herd',{exact:true}).first().click();await page.locator('.herdr-group').filter({hasText:'Mobile scrolling test'}).locator('.herdr-pane').click();
  await expect.poll(async()=>(await state(page)).bottom).toBeGreaterThan(90);
  await drag(page,300,650);await expect.poll(async()=>{const s=await state(page);return s.bottom-s.top}).toBeGreaterThan(10);
  await expect(page.locator('#remote-herdr-app')).not.toHaveClass(/with-keyboard/);
  await stopCoast(page);
  const anchor=(await state(page)).first;
  const held=await page.context().newCDPSession(page);
  await held.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:400}]});
  const heldBottom=(await state(page)).bottom;
  await herdr('pane.send_input',{pane_id:pane,text:'seq 161 240',keys:['Enter']});await page.waitForTimeout(1000);
  expect((await state(page)).bottom).toBe(heldBottom);
  await held.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});await held.detach();
  await expect.poll(async()=>(await state(page)).bottom).toBeGreaterThan(heldBottom);

  expect((await state(page)).first).toBe(anchor);
  await page.getByRole('button',{name:'⌨ Keyboard'}).click();
  await page.getByRole('button',{name:'Switch typing mode'}).click();
  for(const k of ['e','c','h','o','space','h','e','l','l','o'])await key(page,k);
  await expect.poll(async()=>(await state(page)).last).toContain('echo hello');
  await expect.poll(async()=>{const s=await state(page);return s.bottom-s.top}).toBe(0);
  expect(await page.locator('.herdr-output').evaluate(el=>el.querySelector('.xterm-screen').getBoundingClientRect().bottom<=el.getBoundingClientRect().bottom)).toBe(true);
  await expect.poll(()=>visibleText(page)).toContain('echo hello');
  await key(page,'⏎');await expect.poll(async()=>{const r=await herdr('pane.read',{pane_id:pane,source:'recent',lines:5,format:'text'});return r.read.text}).toContain('\nhello');
  const fitting=page.getByRole('button',{name:'Fit to Phone',exact:true});
  await expect(fitting).toHaveAttribute('aria-pressed','true');
  await fitting.click();await expect(fitting).toHaveText('Original Columns');
  expect(await page.evaluate(()=>localStorage.getItem('omarchy-herdr-fit'))).toBe('false');
  await fitting.click();await expect(fitting).toHaveText('Fit to Phone');
  expect(await page.evaluate(()=>localStorage.getItem('omarchy-herdr-fit'))).toBe('true');
  await page.screenshot({path:'artifacts/browser/herdr-input-visible.png'});
 }finally{if(workspace)await herdr('workspace.close',{workspace_id:workspace})}
});
