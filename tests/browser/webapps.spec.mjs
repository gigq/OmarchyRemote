import {test,expect} from '@playwright/test';
const boot=async p=>{
 await p.route('**/api/**',r=>r.abort());
 await p.addInitScript(()=>{window.webCommands=[];window.webkit={messageHandlers:{browserDevice:{postMessage:async q=>{window.webCommands.push(q);return q.action==='capabilities'?{embedded:true,webApps:true}:{}}}}}});
 await p.goto('/native/');await p.getByText('settings',{exact:true}).first().click();
};
const install=async(p,name,url)=>{await p.getByRole('textbox',{name:'Web app name',exact:true}).fill(name);await p.getByRole('textbox',{name:'Web app URL',exact:true}).fill(url);await p.getByRole('button',{name:'Install web app',exact:true}).click();await expect(p.getByRole('button',{name:'Open '+name,exact:true})).toBeVisible()};
for(const viewport of [{width:402,height:874},{width:1194,height:834}])test(`web apps install, persist, tile without chrome and uninstall at ${viewport.width}px`,async({page:p})=>{
 await p.setViewportSize(viewport);await boot(p);await install(p,'Example','https://example.com/');await install(p,'Other','https://example.org/');
 await p.screenshot({path:`artifacts/browser/webapps-settings-${viewport.width}.png`});
 await p.reload();await p.getByText('settings',{exact:true}).first().click();await expect(p.getByRole('button',{name:'Open Example',exact:true})).toBeVisible();
 await p.getByRole('button',{name:'Open Example',exact:true}).click();
 const first=await p.evaluate(()=>window.webCommands.find(q=>q.action==='open'&&q.appID)?.appID);expect(first).toMatch(/^webapp-/);
 await expect.poll(()=>p.evaluate(id=>window.webCommands.filter(q=>q.appID===id&&q.action==='layout').at(-1)?.visible,first)).toBe(true);
 await expect(p.locator('.browser-chrome')).toHaveCount(0);
 const rect=await p.locator(`[data-workspace="${first}"] .webapp-app`).boundingBox();const card=await p.locator(`[data-workspace="${first}"]`).boundingBox();const frame=await p.locator(`[data-workspace="${first}"]`).evaluate(e=>{
  const css=getComputedStyle(e,'::after'),card=getComputedStyle(e);
  return ['left','right'].reduce((sum,edge)=>sum+parseFloat(css[edge])+parseFloat(css.getPropertyValue(`border-${edge}-width`))+parseFloat(card.getPropertyValue(`border-${edge}-width`)),0);
 });expect(Math.abs(rect.width-(card.width-frame))).toBeLessThan(1);
 if(viewport.width>600){
  await p.keyboard.press('Meta+Comma');await p.getByRole('button',{name:'Open Other',exact:true}).click();
  const ids=await p.evaluate(()=>window.webCommands.filter(q=>q.action==='open'&&q.appID).map(q=>q.appID));expect(new Set(ids).size).toBe(2);
  for(const id of ids)await expect.poll(()=>p.evaluate(id=>window.webCommands.filter(q=>q.appID===id&&q.action==='layout').at(-1)?.visible,id)).toBe(true);
  await p.keyboard.press('Meta+e');for(const id of ids)await expect.poll(()=>p.evaluate(id=>window.webCommands.filter(q=>q.appID===id&&q.action==='layout').at(-1)?.visible,id)).toBe(false);
  await p.keyboard.press('Escape');await p.keyboard.press('Meta+w');expect(await p.evaluate(()=>window.webCommands.filter(q=>q.action==='close').length)).toBe(1);
  await p.keyboard.press('Meta+Comma');
 }else{await p.keyboard.press('Meta+Comma')}
 await p.getByRole('button',{name:'Remove Example',exact:true}).click();await expect(p.getByRole('button',{name:'Open Example',exact:true})).toHaveCount(0);
 expect(await p.evaluate(()=>JSON.parse(localStorage.getItem('omarchy-webapps')).map(a=>a.name))).toEqual(['Other']);
 await expect(p.locator(`[data-workspace="${first}"]`)).toHaveCount(0);
});
test('web apps reject unsafe URLs and do not consume ordinary browser events',async({page:p})=>{
 await boot(p);await p.getByRole('textbox',{name:'Web app name',exact:true}).fill('Bad');await p.getByRole('textbox',{name:'Web app URL',exact:true}).fill('javascript://alert(1)');await p.getByRole('button',{name:'Install web app',exact:true}).click();await expect(p.getByRole('region',{name:'Web apps'})).toContainText('http or https URL');
 await install(p,'Example','example.com');await p.getByRole('button',{name:'Open Example',exact:true}).click();
 await p.evaluate(()=>window.dispatchEvent(new CustomEvent('host-browser-state',{detail:{error:'Browser-only failure'}})));
 await expect(p.locator('.webapp-status')).not.toContainText('Browser-only failure');
 const id=await p.evaluate(()=>window.webCommands.find(q=>q.action==='open'&&q.appID).appID);
 const state=detail=>p.evaluate(detail=>window.dispatchEvent(new CustomEvent('host-browser-state',{detail})),{appID:id,...detail});
 await state({error:'Offline',loading:false});await expect(p.getByRole('button',{name:'Retry',exact:true})).toBeVisible();
 await state({loading:false});await expect(p.getByRole('button',{name:'Retry',exact:true})).toBeVisible();
 await p.getByRole('button',{name:'Retry',exact:true}).click();await state({loading:false});await expect(p.locator('.webapp-status')).toBeEmpty();

});
