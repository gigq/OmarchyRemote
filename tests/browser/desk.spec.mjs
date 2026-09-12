import {test,expect} from '@playwright/test';
// Desk mode: iPad, Mac, and desktop windows tile workspaces and take ⌘ shortcuts.
const label=p=>p.locator('.desk-ws-label:visible');
const pills=p=>p.locator('.workspace-switcher:visible .workspace-pill');
const box=async(p,key)=>{await p.waitForTimeout(600);return p.locator(`[data-workspace="${key}"]`).last().boundingBox()};
const boot=async p=>{await p.route('**/api/**',r=>r.abort());await p.goto('/native/');await expect(p.locator('html')).toHaveClass(/desk-mode/);await expect(label(p)).toContainText('home ·')};

test.describe('landscape iPad',()=>{
 test.use({viewport:{width:1194,height:834},isMobile:false,hasTouch:false});
 test('shortcuts open windows into dwindle tiles, focus, fullscreen, move, and close them',async({page:p})=>{
  await boot(p);
  await p.keyboard.press('Meta+Enter');
  await expect(label(p)).toHaveText('terminal · 1 window · dwindle');await expect(pills(p)).toHaveCount(2);
  await p.keyboard.press('Meta+Shift+Enter');
  await expect(label(p)).toHaveText('browser · 2 windows · dwindle');await expect(pills(p)).toHaveCount(2);
  const t=await box(p,'terminal'),b=await box(p,'browser');
  expect(t.x+t.width).toBeLessThan(b.x);expect(Math.abs(t.width-b.width)).toBeLessThan(2);expect(t.height).toBe(b.height);
  expect(t.width).toBeGreaterThan(500);expect(t.height).toBeGreaterThan(700);
  await p.keyboard.press('Meta+Shift+A');
  await expect(label(p)).toHaveText('herdr · 3 windows · dwindle');
  const h=await box(p,'herdr'),b2=await box(p,'browser');
  expect(b2.y+b2.height).toBeLessThan(h.y);expect(Math.abs(h.x-b2.x)).toBeLessThan(1);
  await p.keyboard.press('Meta+ArrowLeft');await expect(label(p)).toContainText('terminal · 3 windows');
  await p.keyboard.press('Meta+ArrowRight');await expect(label(p)).toContainText('browser · 3 windows');
  await p.keyboard.press('Meta+ArrowDown');await expect(label(p)).toContainText('herdr · 3 windows');
  await p.keyboard.press('Meta+f');await expect(label(p)).toHaveText('herdr · 3 windows · fullscreen');
  await p.waitForTimeout(500);const full=await box(p,'herdr');expect(full.width).toBeGreaterThan(1100);
  await expect(p.locator('[data-workspace="browser"]').last()).toHaveCSS('opacity','0');
  await p.keyboard.press('Meta+f');await expect(label(p)).toHaveText('herdr · 3 windows · dwindle');
  await p.keyboard.press('Meta+Shift+Digit3');
  await expect(pills(p)).toHaveCount(3);await expect(label(p)).toHaveText('herdr · 1 window · dwindle');
  await p.keyboard.press('Meta+Digit2');await expect(label(p)).toContainText('· 2 windows · dwindle');
  await p.keyboard.press('Meta+Digit1');await expect(label(p)).toContainText('home ·');
  await p.keyboard.press('Meta+BracketRight');await expect(label(p)).toContainText('· 2 windows');
  await p.keyboard.press('Meta+e');await expect(p.locator('#touch-shell')).toHaveClass(/expo-mode/);
  await p.waitForTimeout(600);await p.screenshot({path:'artifacts/browser/desk-expo.png'});
  await p.keyboard.press('Escape');await expect(p.locator('#touch-shell')).not.toHaveClass(/expo-mode/);
  await p.keyboard.press('Meta+Slash');await expect(p.locator('.desk-sheet')).toBeVisible();
  await expect(p.locator('.desk-sheet-row kbd').first()).toContainText('1…9');
  await p.keyboard.press('Escape');await expect(p.locator('.desk-sheet')).toHaveCount(0);
  await p.keyboard.press('Meta+ArrowRight');await expect(label(p)).toContainText('browser · 2 windows');
  await p.keyboard.press('Meta+w');await expect(label(p)).toHaveText('terminal · 1 window · dwindle');
  await p.keyboard.press('Meta+Shift+A');await expect(label(p)).toHaveText('herdr · 1 window · dwindle');await expect(pills(p)).toHaveCount(3);
  await p.keyboard.press('Meta+Backspace');await expect(label(p)).toHaveText('terminal · 1 window · dwindle');
  await expect(pills(p)).toHaveCount(2);
  await p.screenshot({path:'artifacts/browser/desk-landscape.png'});
 });
 test('Home fills the desk with a framed clock panel beside the widget column',async({page:p})=>{
  await boot(p);
  const home=await box(p,'home'),grid=await p.locator('.home-app-grid:visible').boundingBox(),widgets=await p.locator('#home-widgets:visible').boundingBox();
  expect(home.width).toBeGreaterThan(1100);expect(home.y).toBe(60);
  expect(grid.x+grid.width).toBeLessThan(widgets.x);expect(widgets.height).toBeGreaterThan(600);
  await expect(p.locator('.home-app-grid:visible')).toHaveCSS('grid-template-columns',/^(\S+ ){5}\S+$/);
  await p.screenshot({path:'artifacts/browser/desk-home.png'});
 });
});

test.describe('portrait iPad',()=>{
 test.use({viewport:{width:834,height:1194},isMobile:false,hasTouch:false});
 test('tiles stack and the widget row sits under the Home panel',async({page:p})=>{
  await boot(p);
  const grid=await p.locator('.home-app-grid:visible').boundingBox(),widgets=await p.locator('#home-widgets:visible').boundingBox();
  expect(grid.y+grid.height).toBeLessThan(widgets.y);expect(widgets.width).toBeGreaterThan(700);
  await p.keyboard.press('Meta+Enter');await p.keyboard.press('Meta+Shift+A');
  await expect(label(p)).toHaveText('herdr · 2 windows · dwindle');
  const t=await box(p,'terminal'),h=await box(p,'herdr');
  expect(t.y+t.height).toBeLessThan(h.y);expect(Math.abs(t.x-h.x)).toBeLessThan(1);expect(t.width).toBeGreaterThan(700);
  await p.screenshot({path:'artifacts/browser/desk-portrait.png'});
 });
});

test('the phone shell stays scaled and single-window',async({page:p})=>{
 await p.route('**/api/**',r=>r.abort());await p.goto('/native/');
 await expect(p.locator('html')).not.toHaveClass(/desk-mode/);
 await expect(p.locator('.desk-ws-label')).toBeHidden();
 await p.keyboard.press('Meta+Enter');await p.keyboard.press('Meta+Shift+Enter');
 await expect(pills(p)).toHaveCount(3);
 const b=await box(p,'browser');expect(b.width).toBeLessThanOrEqual(402);
});

test('Home Expo title gradient stays out of the iPad widget area',async({page:p})=>{
 await p.route('**/api/**',r=>r.abort());
 for(const viewport of [{width:1194,height:834},{width:834,height:1194}]){
  await p.setViewportSize(viewport);await p.goto('/native/');
  await p.keyboard.press('Meta+Comma');await p.keyboard.press('Meta+e');
  await expect(p.locator('#touch-shell')).toHaveClass(/expo-mode/);
  await p.waitForTimeout(600);
  const home=p.locator('[data-workspace="home"]').last();
  const title=await home.locator(':scope > .workspace-label').boundingBox();
  const widgets=await p.locator('#home-widgets').boundingBox();
  if(viewport.width>viewport.height)expect(title.x+title.width).toBeLessThan(widgets.x);
  else expect(title.y+title.height).toBeLessThan(widgets.y);
  await p.screenshot({path:'artifacts/browser/home-expo-gradient-'+viewport.width+'.png'});
 }
});

test('new iPad workspaces slide sideways without vertical drift',async({page:p})=>{
 await p.setViewportSize({width:1194,height:834});await p.route('**/api/**',r=>r.abort());await p.goto('/native/');
 for(const key of ['settings','files']){
  if(key==='files'){await p.keyboard.press('Meta+Digit1');await p.waitForTimeout(600)}
  await p.evaluate(key=>{
   window.entryFrames=[];const card=[...document.querySelectorAll('[data-workspace]')].find(e=>e.dataset.workspace===key),start=performance.now();
   const sample=()=>{const r=card.getBoundingClientRect();if(Number(getComputedStyle(card).opacity)>.05)window.entryFrames.push({y:r.y,height:r.height});if(performance.now()-start<1200)requestAnimationFrame(sample)};requestAnimationFrame(sample);
  },key);
  await p.getByText(key,{exact:true}).first().click();await p.waitForTimeout(650);
  const frames=await p.evaluate(()=>window.entryFrames);
  expect(frames.length).toBeGreaterThan(5);
  for(const frame of frames){expect(frame.y).toBeCloseTo(60,0);expect(frame.height).toBeCloseTo(748,0)}
 }
});
