import {test,expect} from './fixtures.mjs';
for(const viewport of [{width:1194,height:834},{width:402,height:874}]){
 test(`Herd pane tabs share the button row at ${viewport.width}px`,async({page:p})=>{
  await p.setViewportSize(viewport);await p.route('**/api/**',r=>r.abort());
  let stream;const snapshot={workspaces:[{workspace_id:'qa',label:'Tabs QA'}],tabs:['one','two','three'].map(id=>({tab_id:id,label:'Herd '+id})),panes:['one','two','three','four'].map(pane_id=>({pane_id,tab_id:pane_id,workspace_id:'qa',agent:'codex',terminal_title_stripped:'Agent '+pane_id}))};
  await p.routeWebSocket('**/api/herdr/ws',ws=>{
   stream=ws;ws.send(JSON.stringify({type:'snapshot',snapshot}));
   ws.onMessage(raw=>{const m=JSON.parse(raw);if(m.type==='select'&&m.pane_id)ws.send(JSON.stringify({type:'pane',pane_id:m.pane_id,read:{pane_id:m.pane_id,text:'Output for '+m.pane_id}}))});
  });
  await p.goto('/native/');await p.keyboard.press('Meta+Shift+A');
  await p.locator('.herdr-pane').filter({hasText:'Herd one'}).click();
  const tabs=p.locator('.herdr-pane-tabs:visible');await expect(tabs).toBeVisible();
  const row=await tabs.boundingBox(),back=await p.getByRole('button',{name:'All panes',exact:true}).boundingBox(),fit=await p.getByRole('button',{name:'Fit to Phone',exact:true}).boundingBox();
  expect(row.x).toBeGreaterThanOrEqual(back.x+back.width);expect(row.x+row.width).toBeLessThanOrEqual(fit.x);
  expect(Math.abs(row.y+row.height/2-(back.y+back.height/2))).toBeLessThan(2);
  await tabs.getByRole('button',{name:'Herd two',exact:true}).click();
  await expect(tabs.getByRole('button',{name:'Herd two',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(p.locator('.herdr-output')).toContainText('Output for two');
  await expect(tabs.getByRole('button',{name:'Agent four',exact:true})).toBeVisible();
  snapshot.tabs[1].label='Renamed in Herd';stream.send(JSON.stringify({type:'snapshot',snapshot}));
  await expect(tabs.getByRole('button',{name:'Renamed in Herd',exact:true})).toHaveAttribute('aria-pressed','true');
  await p.locator('.herdr-output').click();
  const composer=p.locator('.herdr-composer');await expect(composer).toBeVisible();
  const field=composer.locator('textarea');await field.fill('A draft ready for the next step.');
  await expect(composer.getByRole('button',{name:'Send',exact:true}).locator('svg')).toHaveCount(1);
  if(viewport.width>600){
   const box=await field.boundingBox();
   for(const name of ['Switch typing mode','Send','Hide keyboard']){const b=await composer.getByRole('button',{name,exact:true}).boundingBox();expect(Math.abs(b.y+b.height/2-box.y-box.height/2)).toBeLessThan(2)}
  }
  if(viewport.width>600){await p.evaluate(()=>document.documentElement.classList.add('hardware-keyboard'));await expect(composer.getByRole('button',{name:'Hide keyboard',exact:true})).toBeHidden()}
  await p.screenshot({path:`artifacts/browser/herdr-tabs-${viewport.width}.png`});
 });
}

test('last tab from another project is separated and swaps when used',async({page:p})=>{
 await p.setViewportSize({width:1194,height:834});await p.route('**/api/**',r=>r.abort());
 const snapshot={workspaces:[{workspace_id:'a',label:'Project A'},{workspace_id:'b',label:'Project B'}],tabs:[{tab_id:'a1',label:'Alpha'},{tab_id:'a2',label:'Review'},{tab_id:'b1',label:'Beta'}],panes:[{pane_id:'a1',tab_id:'a1',workspace_id:'a'},{pane_id:'a2',tab_id:'a2',workspace_id:'a'},{pane_id:'b1',tab_id:'b1',workspace_id:'b'}]};
 let stream;await p.routeWebSocket('**/api/herdr/ws',ws=>{stream=ws;ws.send(JSON.stringify({type:'snapshot',snapshot}));ws.onMessage(raw=>{const m=JSON.parse(raw);if(m.type==='select'&&m.pane_id)ws.send(JSON.stringify({type:'pane',pane_id:m.pane_id,read:{pane_id:m.pane_id,text:'Output for '+m.pane_id}}))})});
 await p.goto('/native/');await p.keyboard.press('Meta+Shift+A');await p.locator('.herdr-pane').filter({hasText:'Alpha'}).click();
 await expect(p.locator('.herdr-project-divider')).toHaveCount(0);
 await p.getByRole('button',{name:'All panes',exact:true}).click();await p.locator('.herdr-pane').filter({hasText:'Beta'}).click();
 const tabs=p.locator('.herdr-pane-tabs:visible');await expect(tabs.getByRole('button',{name:'Beta',exact:true})).toBeVisible();
 await tabs.getByRole('button',{name:'Return to Project A · Alpha',exact:true}).click();
 await expect(tabs.getByRole('button',{name:'Review',exact:true})).toBeVisible();
 await tabs.getByRole('button',{name:'Review',exact:true}).click();await tabs.getByRole('button',{name:'Return to Project B · Beta',exact:true}).click();
 await expect(tabs.getByRole('button',{name:'Return to Project A · Review',exact:true})).toBeVisible();
 await expect(tabs.locator('.herdr-project-divider')).toBeVisible();
 await p.screenshot({path:'artifacts/browser/herdr-recent-project.png'});
 snapshot.panes=snapshot.panes.filter(x=>x.pane_id!=='a2');stream.send(JSON.stringify({type:'snapshot',snapshot}));
 await expect(tabs.getByRole('button',{name:'Return to Project A · Alpha',exact:true})).toBeVisible();
});
