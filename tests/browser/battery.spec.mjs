import {test,expect} from '@playwright/test';
for(const viewport of [{width:402,height:874},{width:1194,height:834}]){
 test(`device battery updates and fits the header at ${viewport.width}px`,async({page:p})=>{
  await p.setViewportSize(viewport);await p.route('**/api/**',r=>r.abort());await p.goto('/native/');
  const indicator=p.locator('#touch-shell [data-device-battery]').last();
  await expect(indicator).toBeHidden();
  const publish=async(percent,state='unplugged')=>p.evaluate(battery=>{window.__HYPRLAND_BATTERY__=battery;window.dispatchEvent(new Event('hyprland-battery'))},{percent,state});
  await publish(78);await expect(indicator).toBeVisible();await expect(indicator).toHaveAttribute('aria-label','Battery: 78%');
  await expect(indicator.locator('.battery-bolt')).toBeHidden();
  await publish(0);await expect(indicator).toContainText('0%');await expect(indicator).toHaveAttribute('data-low','true');
  await publish(20,'charging');await expect(indicator.locator('.battery-bolt')).toBeVisible();await expect(indicator).toHaveAttribute('aria-label','Battery: 20%, charging');
  await publish(100,'full');await expect(indicator).toHaveAttribute('aria-label','Battery: 100%, fully charged');
  const b=await indicator.boundingBox(),clock=await p.locator('#touch-shell .shell-topbar [data-live-time]').last().boundingBox();
  expect(b.x).toBeGreaterThanOrEqual(clock.x+clock.width);expect(b.x+b.width).toBeLessThanOrEqual(viewport.width);expect(Math.abs(b.y+b.height/2-clock.y-clock.height/2)).toBeLessThan(2);
  await p.screenshot({path:`artifacts/browser/device-battery-${viewport.width}.png`});
  for(const percent of [null,-1,101]){await publish(percent,'unknown');await expect(indicator).toBeHidden()}
 });
}
test('battery snapshot arriving before shell mount renders on startup',async({page:p})=>{
 await p.addInitScript(()=>{window.__HYPRLAND_BATTERY__={percent:63,state:'unplugged'}});
 await p.route('**/api/**',r=>r.abort());await p.goto('/native/');
 await expect(p.locator('#touch-shell [data-device-battery]').last()).toHaveAttribute('aria-label','Battery: 63%');
});
