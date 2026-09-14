// Each test uses an isolated in-memory host. Never write to the real host catalog/backups.
import {test,expect} from '@playwright/test';
function host(){
 const devices=new Map(),apps=new Map();let offline=false;
 async function route(context){await context.route('**/api/**',r=>r.abort());await context.route('**/api/state{,/**}',async r=>{
  if(offline)return r.abort();const url=new URL(r.request().url()),path=url.pathname.slice('/api/state'.length),q=r.request().method()==='POST'?r.request().postDataJSON():null;
  const catalog=()=>({schema:1,host_id:'host-fixture',webapps:[...apps.values()].filter(a=>!a.deleted)});
  if(path==='')return r.fulfill({json:catalog()});
  if(path==='/webapps'){if(q.action==='remove')apps.set(q.id,{id:q.id,deleted:true});else if(!apps.has(q.app.id))apps.set(q.app.id,q.app);return r.fulfill({json:catalog()})}
  if(path==='/devices')return r.fulfill({json:{devices:[...devices.values()]}});
  const id=path.split('/').pop();let d=devices.get(id)||{id,name:'',revision:0,values:{}};
  if(q){if(q.revision!==d.revision)return r.fulfill({status:409,json:{error:'Conflict'}});d={...d,name:q.name,revision:d.revision+1,updated_at:Math.floor(Date.now()/1000),values:{...d.values}};for(const[k,v]of Object.entries(q.changes)){if(v===null)delete d.values[k];else d.values[k]=v}devices.set(id,d)}
  return r.fulfill({json:d});
 });}
 return {devices,apps,route,set offline(v){offline=v}};
}
async function device(browser,server,name,seed){const c=await browser.newContext({viewport:{width:402,height:874},isMobile:true,hasTouch:true});await server.route(c);const p=await c.newPage();
 await p.addInitScript(({name,seed})=>{if(!localStorage.getItem('qa-seeded')){localStorage.setItem('omarchy-device-name',name);for(const[k,v]of Object.entries(seed||{}))localStorage.setItem(k,v);localStorage.setItem('qa-seeded','1')}},{name,seed});
 await p.goto('http://127.0.0.1:4187/native/');await p.evaluate(()=>HyprlandPreferences.ready);await p.keyboard.press('Meta+Comma');await expect(p.getByRole('region',{name:'Device settings',exact:true})).toBeVisible();return{c,p};}
async function install(p,name){await p.getByRole('textbox',{name:'Web app name',exact:true}).fill(name);await p.getByRole('textbox',{name:'Web app URL',exact:true}).fill('https://example.com/'+name);await p.getByRole('button',{name:'Install web app',exact:true}).click();await p.evaluate(()=>HyprlandWebApps.sync())}
test('shared installs, independent preferences, durable offline queue and tombstones',async({browser})=>{
 const h=host(),a=await device(browser,h,'Phone'),b=await device(browser,h,'Tablet');
 try{
  await install(a.p,'Reader');await expect.poll(()=>h.apps.size).toBe(1);await b.p.evaluate(()=>HyprlandWebApps.sync());await expect(b.p.getByRole('button',{name:'Open Reader',exact:true})).toBeVisible();
  const app=[...h.apps.values()][0];expect(await b.p.evaluate(id=>JSON.parse(localStorage.getItem('omarchy-home-pins')||'[]').includes(id),app.id)).toBe(false);
  await a.p.getByRole('button',{name:'Tokyo Night',exact:true}).click();await a.p.evaluate(()=>HyprlandPreferences.sync());await b.p.getByRole('button',{name:'Catppuccin',exact:true}).click();await b.p.evaluate(()=>HyprlandPreferences.sync());
  const aid=await a.p.evaluate(()=>HyprlandPreferences.id),bid=await b.p.evaluate(()=>HyprlandPreferences.id);expect(aid).not.toBe(bid);expect(h.devices.get(aid).values['omarchy-theme']).toBe('tokyo-night');expect(h.devices.get(bid).values['omarchy-theme']).toBe('catppuccin');
  h.offline=true;await install(a.p,'Offline');await a.p.reload();await a.p.evaluate(()=>HyprlandPreferences.ready);await expect(a.p.getByRole('button',{name:'Open Offline',exact:true})).toBeVisible();expect(h.apps.size).toBe(1);
  h.offline=false;await a.p.evaluate(()=>HyprlandWebApps.sync());await expect.poll(()=>h.apps.size).toBe(2);
  await b.p.getByRole('button',{name:'Uninstall Reader from host',exact:true}).click();await b.p.evaluate(()=>HyprlandWebApps.sync());await a.p.evaluate(()=>HyprlandWebApps.sync());await expect(a.p.getByRole('button',{name:'Open Reader',exact:true})).toHaveCount(0);
  const stale=await device(browser,h,'Old phone',{'omarchy-webapps':JSON.stringify([app]),'omarchy-theme':'gruvbox'});try{await stale.p.evaluate(()=>HyprlandWebApps.ready);await expect(stale.p.getByRole('button',{name:'Open Reader',exact:true})).toHaveCount(0);expect(h.apps.get(app.id).deleted).toBe(true)}finally{await stale.c.close()}
 }finally{await a.c.close();await b.c.close()}
});
test('same device recovers after local data loss; a new device can explicitly restore another backup',async({browser})=>{
 const h=host(),a=await device(browser,h,'My iPad');
 try{
  await a.p.getByRole('button',{name:'Tokyo Night',exact:true}).click();await a.p.evaluate(()=>{HyprlandUtil.storage.write('omarchy-home-pins',['files','settings']);HyprlandUtil.storage.write('omarchy-widgets',['weather']);return HyprlandPreferences.sync()});
  const id=await a.p.evaluate(()=>HyprlandPreferences.id);await a.p.evaluate(()=>{const id=HyprlandPreferences.id;localStorage.clear();localStorage.setItem('omarchy-device-id',id);localStorage.setItem('qa-seeded','1')});await a.p.reload();await a.p.evaluate(()=>HyprlandPreferences.ready);await expect(a.p.locator('html')).toHaveAttribute('data-theme','tokyo-night');expect(await a.p.evaluate(()=>JSON.parse(localStorage.getItem('omarchy-widgets')))).toEqual(['weather']);expect(await a.p.evaluate(()=>HyprlandPreferences.id)).toBe(id);
  const b=await device(browser,h,'New iPad');try{await b.p.getByRole('button',{name:'Restore a device backup',exact:true}).click();await b.p.getByRole('button',{name:/My iPad ·/}).click();await b.p.getByRole('button',{name:'Restore and reload',exact:true}).click();await expect(b.p.locator('html')).toHaveAttribute('data-theme','tokyo-night');expect(await b.p.evaluate(()=>HyprlandPreferences.id)).not.toBe(id);expect(await b.p.evaluate(()=>JSON.parse(localStorage.getItem('omarchy-home-pins')))).toEqual(['files','settings'])}finally{await b.c.close()}
 }finally{await a.c.close()}
});
