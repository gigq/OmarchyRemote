import {test,expect} from '@playwright/test';
import {captureTerminals,visibleText} from './terminal-helper.mjs';
for(const app of ['lazydocker','dua','lnav'])test(`${app} opens real host output, controls and restores its session`,async({page:p})=>{
 await captureTerminals(p);let id;
 if(app==='lnav')await p.route('**/api/terminal/session',async route=>{const response=await route.fetch();await p.waitForTimeout(2000);await route.fulfill({response})});
 try{
  await p.goto('/native/');await p.getByText(app,{exact:true}).first().click();
  const root=p.locator(`#remote-${app}-app`);await expect(root).toContainText('HOST · connected');
  id=await p.evaluate(app=>localStorage.getItem(`omarchy-${app}-id`),app);expect(id).toBeTruthy();
  await expect.poll(()=>visibleText(p),{timeout:15000}).toMatch(app==='lazydocker'?/Containers/:app==='dua'?/Scanning|Total|total|entries|items/:/systemd|host|kernel|Started/);
  expect(await visibleText(p)).not.toContain('unknown command');
  await p.waitForTimeout(800);await p.screenshot({path:`artifacts/browser/${app}.png`});
  if(app==='lnav'){await root.getByRole('button',{name:'Wrap',exact:true}).click();await p.waitForTimeout(300);await p.screenshot({path:'artifacts/browser/lnav-toggle-wrap.png'})}
  if(app!=='lazydocker'){await root.getByRole('button',{name:'Help',exact:true}).click();await p.waitForTimeout(200);await p.screenshot({path:`artifacts/browser/${app}-help.png`});await root.getByRole('button',{name:'Help',exact:true}).click()}
  await p.reload();await p.getByText(app,{exact:true}).first().click();await expect(root).toContainText('HOST · connected');
  expect(await p.evaluate(app=>localStorage.getItem(`omarchy-${app}-id`),app)).toBe(id);
  await p.waitForTimeout(500);await p.screenshot({path:`artifacts/browser/${app}-resume.png`});
 }finally{if(id)await p.request.post(`/api/terminal/${id}/close`,{headers:{'X-Hyprland-Client':'1'},data:{}})}
});
