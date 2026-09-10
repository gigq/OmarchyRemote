import {test,expect} from '@playwright/test';
import {captureTerminals,visibleText} from './terminal-helper.mjs';

test.beforeEach(async({page})=>{
 await captureTerminals(page);
 // Renderer fixtures never open a host shell or talk to an existing agent.
 await page.route('**/api/**',route=>route.abort());
});
async function open(page){
 await page.goto('/native/');await page.getByText('terminal',{exact:true}).first().click();
 await page.evaluate(()=>new Promise(resolve=>qaTerms[0].write('renderer fixture\r\n\x1b[31mred text\x1b[0m',resolve)));
 await expect.poll(()=>visibleText(page)).toContain('red text');
}
test('GPU draws the terminal and context loss restores readable DOM output',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await open(page);
 await expect(page.locator('.remote-terminal')).toHaveAttribute('data-renderer','webgl');
 await expect(page.locator('.remote-terminal canvas').first()).toBeVisible();
 await page.waitForTimeout(500);
 await page.screenshot({path:'artifacts/browser/gpu-renderer.png'});
 await page.locator('.remote-terminal').evaluate(host=>{const gl=[...host.querySelectorAll('canvas')].map(c=>c.getContext('webgl2')).find(Boolean);gl.getExtension('WEBGL_lose_context').loseContext()});
 await expect(page.locator('.remote-terminal')).toHaveAttribute('data-renderer','dom',{timeout:10000});
 await expect(page.locator('.remote-terminal .xterm-rows')).toContainText('red text');
 expect(errors).toEqual([]);
});
test('unavailable GPU falls back without losing text',async({page})=>{
 await page.addInitScript(()=>{Object.defineProperty(window,'WebglAddon',{configurable:true,get:()=>({WebglAddon:class{constructor(){throw Error('GPU unavailable')}}}),set:()=>{}})});
 await open(page);
 await expect(page.locator('.remote-terminal')).toHaveAttribute('data-renderer','dom');
 await expect(page.locator('.remote-terminal .xterm-rows')).toContainText('red text');
});
