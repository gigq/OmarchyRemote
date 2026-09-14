import {test,expect} from './fixtures.mjs';
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

for(const [name,width,height,radius,expoRadius] of [['phone',402,874,'24px','26px'],['iPad',1194,834,'18px','28px']]){
 test(name+' app frames share Home corner radius in normal and Expo views',async({page:p})=>{
  await p.setViewportSize({width,height});await p.route('**/api/**',r=>r.abort());await p.goto('/native/');
  const frames=p.locator('#touch-shell [data-workspace]');
  await expect(frames.first()).toBeAttached();
  const radii=()=>frames.evaluateAll(nodes=>nodes.map(n=>({app:n.dataset.workspace,radius:getComputedStyle(n,'::after').borderTopLeftRadius})));
  if(name==='iPad'){for(const border of await frames.evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).borderTopWidth)))expect(border).toBe('0px')}
  const normal=await radii();expect(normal.length).toBeGreaterThan(5);
  for(const frame of normal)expect(frame.radius,frame.app).toBe(radius);
  if(name==='iPad')await p.keyboard.press('Meta+e');
  else await p.locator('#touch-shell > div').first().locator('[data-dc-tpl="10"]').last().click();
  await expect(p.locator('#touch-shell')).toHaveClass(/expo-mode/);
  for(const frame of await radii())expect(frame.radius,frame.app).toBe(expoRadius);
 });
}
