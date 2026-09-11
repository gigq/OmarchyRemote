import {test,expect} from '@playwright/test';
const card=(p,k)=>p.locator(`[data-workspace="${k}"]`).last();
async function expo(p){await p.locator('#touch-shell > div').first().locator('[data-dc-tpl="10"]').last().click();await expect(p.locator('#touch-shell')).toHaveClass(/expo-mode/);await p.waitForTimeout(500)}
async function drag(p,from,to,hold=0){await p.mouse.move(from.x,from.y);await p.mouse.down();if(hold)await p.waitForTimeout(hold);await p.mouse.move(to.x,to.y,{steps:10});await p.mouse.up();await p.waitForTimeout(550)}
const center=async el=>{const r=await el.boundingBox();return{x:r.x+r.width/2,y:r.y+r.height/2}};
test('Home-only startup, toss dismissal, long press reorder and protected Home',async({page:p})=>{
 await p.route('**/api/**',r=>r.abort());await p.goto('/native/');
 await expect(card(p,'terminal')).toHaveCSS('opacity','0');await expect(card(p,'firefox')).toHaveCount(0);await expect(card(p,'phone')).toHaveCount(0);
 await p.getByText('settings',{exact:true}).first().click();await expo(p);
 let a=await center(card(p,'settings'));await drag(p,a,{x:a.x,y:a.y-30});await expect(card(p,'settings')).toHaveCSS('opacity','1');await drag(p,a,{x:a.x,y:a.y-115});await expect(card(p,'settings')).toHaveCSS('opacity','0');await expect(p.locator('#touch-shell')).toHaveClass(/expo-mode/);
 a=await center(card(p,'home'));await drag(p,a,{x:a.x,y:a.y-115});await expect(card(p,'home')).toHaveCSS('opacity','1');
 await card(p,'home').click();await p.getByText('files',{exact:true}).first().click();await expo(p);await card(p,'home').click();await p.getByText('settings',{exact:true}).first().click();await expo(p);
 const files=await center(card(p,'files')),settings=await center(card(p,'settings'));
 await p.mouse.move(settings.x,settings.y);await p.mouse.down();await p.waitForTimeout(500);await p.mouse.move(files.x,files.y,{steps:10});await p.locator('#touch-shell').dispatchEvent('pointercancel');await p.mouse.up();await p.waitForTimeout(550);
 await expect.poll(async()=>Math.round((await center(card(p,'settings'))).y)).toBe(Math.round(settings.y));
 await drag(p,settings,files,500);
 await expect.poll(async()=>Math.round((await card(p,'settings').boundingBox()).x)).toBe(Math.round(files.x-(await card(p,'settings').boundingBox()).width/2));
 await card(p,'settings').click();await expect(p.locator('#touch-shell')).not.toHaveClass(/expo-mode/);await expect(p.locator('.theme-settings')).toBeVisible();
});
test('dismissing Terminal closes its session and reopening starts a fresh shell',async({page:p})=>{
 await p.goto('/native/');await p.getByText('terminal',{exact:true}).first().click();await expect(p.locator('#remote-terminal-app')).toContainText('· connected');
 const first=await p.evaluate(()=>localStorage.getItem('omarchy-terminal-id'));
 try{
  await expo(p);const a=await center(card(p,'terminal'));await drag(p,a,{x:a.x,y:a.y-120});
  await expect(card(p,'terminal')).toHaveCSS('opacity','0');await expect.poll(()=>p.evaluate(()=>localStorage.getItem('omarchy-terminal-id'))).toBeNull();
  await card(p,'home').click();await p.getByText('terminal',{exact:true}).first().click();await expect(p.locator('#remote-terminal-app')).toContainText('· connected');
  expect(await p.evaluate(()=>localStorage.getItem('omarchy-terminal-id'))).not.toBe(first);
 }finally{
  const id=await p.evaluate(()=>localStorage.getItem('omarchy-terminal-id'));for(const key of new Set([first,id].filter(Boolean)))await p.request.post(`/api/terminal/${key}/close`,{headers:{'X-Hyprland-Client':'1'},data:{}});
 }
});
