import {test,expect} from '@playwright/test';
test('all Omarchy themes apply to shell and ANSI output and persist',async({page})=>{
 await page.route('**/api/**',r=>r.abort());
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/native/');await page.getByText('settings',{exact:true}).first().click();
 await expect(page.locator('.theme-choice')).toHaveCount(23);
 await page.getByRole('button',{name:'Catppuccin Latte',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-theme','catppuccin-latte');
 await expect(page.getByRole('button',{name:'Catppuccin Latte',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.theme-settings')).toHaveCSS('color','rgb(76, 79, 105)');
 await page.screenshot({path:'artifacts/browser/themes-light.png'});
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','catppuccin-latte');
 await page.getByText('settings',{exact:true}).first().click();
 await page.getByRole('button',{name:'Tokyo Night',exact:true}).click();
 await expect(page.locator('html')).toHaveAttribute('data-theme','tokyo-night');
 await page.screenshot({path:'artifacts/browser/themes-dark.png'});
 const result=await page.evaluate(async()=>{
  const host=document.createElement('div');host.style.cssText='position:fixed;inset:100px 20px;height:200px';document.body.append(host);
  const term=new Terminal({cols:40,rows:5,theme:HyprlandThemes.terminalTheme()});term.open(host);const view=new NativeTerminalView(host,term);
  await new Promise(r=>term.write('\x1b[31mRed\x1b[0m plain',r));
  HyprlandThemes.apply('catppuccin-latte');await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const span=host.querySelector('.native-terminal-row span');const value={color:span.style.color,background:term.options.theme.background,text:host.querySelector('.native-terminal-content').textContent};view.dispose();term.dispose();host.remove();return value;
 });
 expect(result.color).toBe('rgb(210, 15, 57)');expect(result.background).toBe('#e3e4e8');expect(result.text).toContain('Red');expect(errors).toEqual([]);
});
