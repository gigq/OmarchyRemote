import {test,expect} from '@playwright/test';
import {captureTerminals,visibleText} from './terminal-helper.mjs';
test('Services lists host units, searches, opens actions and reconnects',async({page:p})=>{
 await captureTerminals(p);let id;
 try{
  await p.goto('/native/');await p.getByText('services',{exact:true}).first().click();
  const app=p.locator('#remote-services-app');await expect(app).toContainText('HOST · connected');
  id=await p.evaluate(()=>localStorage.getItem('omarchy-services-id'));expect(id).toBeTruthy();
  await expect.poll(()=>visibleText(p)).toContain('.service');
  await p.waitForTimeout(500);await p.screenshot({path:'artifacts/browser/services.png'});
  await app.getByRole('button',{name:'Search',exact:true}).click();
  await p.evaluate(()=>qaTerms[0].input('hyprland-touch-dev'));
  await expect.poll(()=>visibleText(p)).toContain('hyprland-touch-dev');
  await app.getByRole('button',{name:'Back',exact:true}).click();
  await app.getByRole('button',{name:'Select',exact:true}).click();
  await expect.poll(()=>visibleText(p)).toContain('Restart');
  await p.screenshot({path:'artifacts/browser/services-actions.png'});
  // Inspect the menu only; never operate existing host services during QA.
  await app.getByRole('button',{name:'Back',exact:true}).click();
  await p.reload();await p.getByText('services',{exact:true}).first().click();
  await expect(app).toContainText('HOST · connected');
  expect(await p.evaluate(()=>localStorage.getItem('omarchy-services-id'))).toBe(id);
  await expect.poll(()=>visibleText(p)).toContain('hyprland-touch-dev');
  await p.screenshot({path:'artifacts/browser/services-resume.png'});
 }finally{if(id)await p.request.post(`/api/terminal/${id}/close`,{headers:{'X-Hyprland-Client':'1'},data:{}})}
});
