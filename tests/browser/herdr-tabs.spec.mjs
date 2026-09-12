import {test,expect} from '@playwright/test';
for(const viewport of [{width:1194,height:834},{width:402,height:874}]){
 test(`Herd pane tabs share the button row at ${viewport.width}px`,async({page:p})=>{
  await p.setViewportSize(viewport);await p.route('**/api/**',r=>r.abort());
  await p.routeWebSocket('**/api/herdr/ws',ws=>{
   ws.send(JSON.stringify({type:'snapshot',snapshot:{workspaces:[{workspace_id:'qa',label:'Tabs QA'}],tabs:[],panes:['one','two','three','four'].map(pane_id=>({pane_id,workspace_id:'qa',terminal_title_stripped:'Agent '+pane_id}))}}));
   ws.onMessage(raw=>{const m=JSON.parse(raw);if(m.type==='select'&&m.pane_id)ws.send(JSON.stringify({type:'pane',pane_id:m.pane_id,read:{pane_id:m.pane_id,text:'Output for '+m.pane_id}}))});
  });
  await p.goto('/native/');await p.keyboard.press('Meta+Shift+A');
  await p.locator('.herdr-pane').filter({hasText:'Agent one'}).click();
  const tabs=p.locator('.herdr-pane-tabs:visible');await expect(tabs).toBeVisible();
  const row=await tabs.boundingBox(),back=await p.getByRole('button',{name:'All panes',exact:true}).boundingBox(),fit=await p.getByRole('button',{name:'Fit to Phone',exact:true}).boundingBox();
  expect(row.x).toBeGreaterThanOrEqual(back.x+back.width);expect(row.x+row.width).toBeLessThanOrEqual(fit.x);
  expect(Math.abs(row.y+row.height/2-(back.y+back.height/2))).toBeLessThan(2);
  await tabs.getByRole('button',{name:'Agent two',exact:true}).click();
  await expect(tabs.getByRole('button',{name:'Agent two',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(p.locator('.herdr-output')).toContainText('Output for two');
  await p.screenshot({path:`artifacts/browser/herdr-tabs-${viewport.width}.png`});
 });
}
