import {test,expect} from './fixtures.mjs';
test.beforeEach(async({page})=>{
 await page.goto('/native-input.js');
 await page.setContent('<div id="input"></div>');
 await page.addScriptTag({url:'/native-input.js'});
 await page.evaluate(()=>{window.sent=[];window.keys=[];window.input=new NativeInput(document.getElementById('input'),{message:true,send:(text,enter)=>{if(window.offline)return false;sent.push({text,enter});return true},key:(key,mods)=>keys.push({key,mods}),focus:()=>{},hide:()=>{}});input.focus()});
});
test('message edits remain local, retain failed drafts and stay with their pane',async({page})=>{
 await expect(page.locator('.native-input-tools')).toBeHidden();
 const field=page.locator('.native-input');await page.evaluate(()=>input.select('pane-one'));
 await field.fill('helo');await field.fill('hello');expect(await page.evaluate(()=>sent)).toEqual([]);
 await page.evaluate(()=>input.select('pane-two'));await expect(field).toHaveValue('');await field.fill('second pane');
 await page.evaluate(()=>input.select('pane-one'));await expect(field).toHaveValue('hello');
 await page.evaluate(()=>window.offline=true);await field.press('Enter');await expect(field).toHaveValue('hello');
 await page.evaluate(()=>window.offline=false);await field.press('Enter');expect(await page.evaluate(()=>sent)).toEqual([{text:'hello',enter:true}]);await expect(field).toHaveValue('');
 await expect(field).toHaveAttribute('autocorrect','on');
});
test('direct keys, delete, Ctrl and IME commit are sent once',async({page})=>{
 await page.getByRole('button',{name:'Switch typing mode'}).click();const field=page.locator('.native-input');
 await expect(page.locator('.native-input-tools')).toBeVisible();
 await expect(field).toHaveAttribute('autocorrect','off');
 await field.pressSequentially('abc');await field.press('Backspace');await field.press('Enter');
 await page.getByRole('button',{name:'Ctrl',exact:true}).click();await field.press('c');
 await field.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart'));el.value='\u200b日本';el.dispatchEvent(new InputEvent('input',{data:'日本',isComposing:true}));el.dispatchEvent(new CompositionEvent('compositionend',{data:'日本'}));el.dispatchEvent(new InputEvent('input',{data:'日本',inputType:'insertText'}))});
 expect(await page.evaluate(()=>sent.map(s=>s.text).join(''))).toBe('abc日本');
 expect(await page.evaluate(()=>keys)).toEqual([{key:'⌫',mods:{}},{key:'⏎',mods:{}},{key:'c',mods:{ctrl:true}}]);
});
test('image paths append to the original draft without sending or replacing text',async({page})=>{
 const field=page.locator('.native-input');await page.evaluate(()=>input.select('one'));await field.fill('Look at this');
 await page.evaluate(()=>input.select('two'));await field.fill('Other draft');
 await page.evaluate(()=>input.attachImage('one','/tmp/image-one.png'));await expect(field).toHaveValue('Other draft');
 await page.evaluate(()=>input.select('one'));await expect(field).toHaveValue('Look at this\nImage: /tmp/image-one.png\n');
 await page.evaluate(()=>input.attachImage('one','/tmp/image-two.png'));expect(await page.evaluate(()=>sent)).toEqual([]);
 await page.evaluate(()=>input.submit.disabled=true);await field.press('Enter');expect(await page.evaluate(()=>sent)).toEqual([]);
 await page.evaluate(()=>input.submit.disabled=false);await field.press('Enter');
 expect(await page.evaluate(()=>sent)).toEqual([{text:'Look at this\nImage: /tmp/image-one.png\nImage: /tmp/image-two.png\n',enter:true}]);
});
for(const trigger of ['button','keyboard','beforeinput'])test(`Herd dismisses after ${trigger} send but retains failed drafts`,async({page})=>{
 await page.evaluate(()=>{input.dismissOnSend=true;window.hiddenCount=0;input.onHide=()=>{hiddenCount++;input.show(false)}});
 const field=page.locator('.native-input');await field.fill('Keep this draft');await page.evaluate(()=>window.offline=true);
 const submit=()=>trigger==='button'?page.getByRole('button',{name:'Send',exact:true}).click():trigger==='keyboard'?field.press('Enter'):field.evaluate(el=>el.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertLineBreak',bubbles:true,cancelable:true})));
 await submit();await expect(field).toBeFocused();await expect(field).toHaveValue('Keep this draft');expect(await page.evaluate(()=>hiddenCount)).toBe(0);
 await page.evaluate(()=>window.offline=false);await submit();await expect(field).toBeHidden();await expect(field).not.toBeFocused();expect(await page.evaluate(()=>hiddenCount)).toBe(1);
 expect(await page.evaluate(()=>sent)).toEqual([{text:'Keep this draft',enter:true}]);await expect(field).toHaveValue('');
});

test('Herd drafts survive page reload per pane, including composition and background image attachments',async({page})=>{
 const mount=async()=>{
  await page.setContent('<div id="input"></div>');
  await page.addScriptTag({url:'/util.js'});await page.addScriptTag({url:'/native-input.js'});
  await page.evaluate(()=>{window.sent=[];window.input=new NativeInput(document.getElementById('input'),{message:true,draftStore:'omarchy-herdr-drafts-v1',send:text=>{if(window.offline)return false;sent.push(text);return true},key:()=>{},focus:()=>{},hide:()=>{}});input.select('agent-a');input.focus()});
 };
 await mount();const field=page.locator('.native-input');await field.fill('First unfinished message');
 await page.evaluate(()=>input.select('agent-b'));await field.fill('Second message');
 await page.evaluate(()=>input.attachImage('agent-a','/tmp/attached.png'));
 // Simulate termination without dispose/pagehide: persistence must happen on input itself.
 await page.reload();await mount();await expect(field).toHaveValue('First unfinished message\nImage: /tmp/attached.png\n');
 await page.evaluate(()=>{input.select('agent-b');window.offline=true});await field.press('Enter');await expect(field).toHaveValue('Second message');
 await page.reload();await mount();await page.evaluate(()=>input.select('agent-b'));await expect(field).toHaveValue('Second message');
 await field.press('Enter');await page.reload();await mount();await page.evaluate(()=>input.select('agent-b'));await expect(field).toHaveValue('');
 await field.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart'));el.value='日本';el.dispatchEvent(new InputEvent('input',{data:'日本',isComposing:true}))});
 await page.reload();await mount();await page.evaluate(()=>input.select('agent-b'));await expect(field).toHaveValue('日本');
 await field.fill('');await page.reload();await mount();await page.evaluate(()=>input.select('agent-b'));await expect(field).toHaveValue('');
 await page.evaluate(()=>input.select('agent-a'));await expect(field).toHaveValue('First unfinished message\nImage: /tmp/attached.png\n');
});

test('unavailable draft storage warns without losing or sending the current text',async({page})=>{
 await page.addScriptTag({url:'/util.js'});
 await page.evaluate(()=>{input.draftStore='omarchy-herdr-drafts-v1';input.select('agent-a');Storage.prototype.setItem=function(){throw Error('Quota exceeded')}});
 await page.locator('.native-input').fill('Keep this unsaved text');
 await expect(page.getByRole('status')).toContainText('Draft could not be saved');
 await expect(page.locator('.native-input')).toHaveValue('Keep this unsaved text');
 await page.evaluate(()=>{input.select('agent-b');input.select('agent-a')});
 await expect(page.locator('.native-input')).toHaveValue('Keep this unsaved text');expect(await page.evaluate(()=>sent)).toEqual([]);
});
