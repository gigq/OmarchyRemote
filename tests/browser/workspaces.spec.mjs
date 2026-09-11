import {test,expect} from '@playwright/test';
test('ten workspaces keep five fixed-size numbers per row and fit in Expo',async({page:p})=>{
 await p.route('**/api/**',r=>r.abort());await p.goto('/native/');
 const pills=p.locator('.workspace-switcher:visible .workspace-pill');
 const apps=['terminal','files','settings','herdr','btop','services','lazydocker','dua','lnav'];
 for(const [i,app] of apps.entries()){
  if(i)await pills.first().click();
  await p.getByText(app,{exact:true}).first().click();
  await expect(pills).toHaveCount(i+2);
 }
 const boxes=await pills.evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,font:getComputedStyle(n).fontSize}}));
 for(let i=0;i<10;i++){expect(boxes[i].w).toBe(20);expect(boxes[i].font).toBe('11px');expect(boxes[i].y).toBe(boxes[i<5?0:5].y)}
 expect(boxes[5].y).toBeGreaterThan(boxes[0].y);expect(boxes[5].x).toBe(boxes[0].x);
 await p.waitForTimeout(550);await p.screenshot({path:'artifacts/browser/workspaces-ten.png'});
 await pills.nth(5).click();await expect(p.locator('[data-workspace="btop"]').last()).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
 await pills.nth(5).click();await expect(p.locator('#touch-shell')).toHaveClass(/expo-mode/);await p.waitForTimeout(550);
 const last=await p.locator('[data-workspace="lnav"]').last().boundingBox();expect(last.y+last.height).toBeLessThan(874);
 await p.screenshot({path:'artifacts/browser/workspaces-expo-ten.png'});
});
