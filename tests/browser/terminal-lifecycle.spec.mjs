import {test,expect} from '@playwright/test';
test('active terminal accepts typing immediately and exited tabs/windows disappear',async({page:p})=>{
 await p.setViewportSize({width:1194,height:834});let next=0;const sockets=[],inputs=[];
 await p.route('**/api/**',r=>r.fulfill({json:r.request().url().endsWith('/session')?{id:'qa-'+(++next)}:{ok:true}}));
 let releaseClose,holdClose=false;await p.route('**/api/terminal/*/close',async r=>{if(holdClose)await new Promise(resolve=>{releaseClose=resolve});await r.fulfill({json:{ok:true}})});
 await p.routeWebSocket('**/api/terminal/*/ws',ws=>{sockets.push(ws);ws.send(JSON.stringify({type:'screen',cols:80,rows:24,data:[36,32]}));ws.onMessage(raw=>{const m=JSON.parse(raw);if(m.type==='input')inputs.push(m.data)})});
 await p.goto('/native/');await p.evaluate(()=>{window.__HYPRLAND_HARDWARE_KEYBOARD__=true;dispatchEvent(new Event('hyprland-hardware-keyboard'))});
 await p.keyboard.press('Meta+Enter');await expect(p.locator('.native-input:focus')).toHaveCount(1);await expect(p.locator('#remote-terminal-app .remote-status')).toHaveText(/connected/);await p.keyboard.type('hello');await expect.poll(()=>inputs.join('')).toBe('hello');
 await p.keyboard.press('Meta+t');await expect.poll(()=>sockets.length).toBe(2);await expect(p.locator('.terminal-tab:not([hidden]) .native-input')).toBeFocused();
 // Closing an inactive shell must preserve the focused shell.
 sockets[0].send(JSON.stringify({type:'exit'}));await expect(p.locator('.terminal-tab')).toHaveCount(1);await expect(p.locator('.terminal-tab .native-input')).toBeFocused();
 await p.keyboard.press('Meta+Digit1');await p.keyboard.press('Meta+Digit2');await expect(p.locator('.terminal-tab .native-input')).toBeFocused();
 holdClose=true;sockets[1].send(JSON.stringify({type:'exit'}));await expect.poll(()=>!!releaseClose).toBe(true);await expect(p.getByRole('button',{name:'New shell',exact:true})).toBeHidden();await expect(p.locator('#remote-terminal-app')).not.toContainText('Shell exited');releaseClose();await expect(p.locator('.terminal-tab')).toHaveCount(0);
 expect(await p.evaluate(()=>localStorage.getItem('omarchy-terminal-tabs'))).toBeNull();
});
