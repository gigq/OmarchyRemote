import {test,expect} from '@playwright/test';
const key=async(page,label)=>page.locator('button.touch-key').filter({hasText:new RegExp('^'+label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$')}).click();

test('custom keyboard drives the real shell and resumes after page reload',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/native/');await page.getByText('terminal',{exact:true}).first().click();
 await expect(page.locator('#remote-terminal-app')).toContainText('HOST · connected');
 await page.locator('.remote-terminal').click();
 for(const k of ['e','c','h','o','space','h','e','l','l','o','⏎'])await key(page,k);
 await expect(page.locator('.remote-terminal')).toContainText('hello');
 await page.screenshot({path:'artifacts/browser/terminal-live.png'});
 const id=await page.evaluate(()=>localStorage.getItem('omarchy-terminal-id'));
 await page.reload();await page.getByText('terminal',{exact:true}).first().click();await expect(page.locator('#remote-terminal-app')).toContainText('HOST · connected');
 expect(await page.evaluate(()=>localStorage.getItem('omarchy-terminal-id'))).toBe(id);
 await expect(page.locator('.remote-terminal')).toContainText('hello');
 await page.locator('.remote-terminal').click();for(const k of ['e','x','i','t','⏎'])await key(page,k);
 await expect(page.locator('#remote-terminal-app')).toContainText('Shell exited');
 await page.reload();await page.getByText('terminal',{exact:true}).first().click();await expect(page.locator('#remote-terminal-app')).toContainText('Shell exited');
 await page.getByRole('button',{name:'New shell',exact:true}).click();await expect(page.locator('#remote-terminal-app')).toContainText('HOST · connected');
 await page.locator('.remote-terminal').click();for(const k of ['e','x','i','t','⏎'])await key(page,k);await expect(page.locator('#remote-terminal-app')).toContainText('Shell exited');
 expect(errors).toEqual([]);
});

test('Herdr lists real workspaces and opens output without sending input',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const response=await page.request.get('/api/herdr/snapshot',{headers:{'X-Hyprland-Client':'1'}});const snap=await response.json();
 await page.goto('/native/');await page.getByText('herd',{exact:true}).first().click();
 await expect(page.locator('.herdr-pane')).toHaveCount(snap.panes.length);
 await page.screenshot({path:'artifacts/browser/herdr-list.png'});
 await page.locator('.herdr-pane').first().click();await expect(page.locator('.herdr-detail')).toBeVisible();await expect(page.locator('.herdr-canvas .xterm-rows')).not.toBeEmpty();
 await page.waitForTimeout(600);await page.screenshot({path:'artifacts/browser/herdr-pane.png'});
 const wide=await page.locator('.herdr-output').evaluate(el=>el.scrollWidth>el.clientWidth);
 if(wide){const cdp=await page.context().newCDPSession(page);await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:300,y:400}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:100,y:400}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await expect.poll(()=>page.locator('.herdr-output').evaluate(el=>el.scrollLeft)).toBeGreaterThan(0);await cdp.detach()}

 await page.getByRole('button',{name:'⌨ Keyboard',exact:true}).click();await expect(page.locator('#remote-herdr-app')).toHaveClass(/with-keyboard/);
 await page.getByRole('button',{name:'‹ All panes'}).click();await expect(page.locator('.herdr-list')).toBeVisible();expect(errors).toEqual([]);
});
