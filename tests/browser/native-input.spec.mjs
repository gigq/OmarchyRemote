import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{
 await page.goto('/native-input.js');
 await page.setContent('<div id="input"></div>');
 await page.addScriptTag({url:'/native-input.js'});
 await page.evaluate(()=>{window.sent=[];window.keys=[];window.input=new NativeInput(document.getElementById('input'),{message:true,send:(text,enter)=>{if(window.offline)return false;sent.push({text,enter});return true},key:(key,mods)=>keys.push({key,mods}),focus:()=>{},hide:()=>{}});input.focus()});
});
test('message edits remain local, retain failed drafts and stay with their pane',async({page})=>{
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
 await expect(field).toHaveAttribute('autocorrect','off');
 await field.pressSequentially('abc');await field.press('Backspace');await field.press('Enter');
 await page.getByRole('button',{name:'Ctrl',exact:true}).click();await field.press('c');
 await field.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart'));el.value='\u200b日本';el.dispatchEvent(new InputEvent('input',{data:'日本',isComposing:true}));el.dispatchEvent(new CompositionEvent('compositionend',{data:'日本'}));el.dispatchEvent(new InputEvent('input',{data:'日本',inputType:'insertText'}))});
 expect(await page.evaluate(()=>sent.map(s=>s.text).join(''))).toBe('abc日本');
 expect(await page.evaluate(()=>keys)).toEqual([{key:'⌫',mods:{}},{key:'⏎',mods:{}},{key:'c',mods:{ctrl:true}}]);
});
