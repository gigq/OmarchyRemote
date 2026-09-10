import {test,expect} from '@playwright/test';
import {captureTerminals,visibleText} from './terminal-helper.mjs';

test.beforeEach(async({page})=>{
 await captureTerminals(page);
 await page.route('**/api/**',route=>route.abort());
});
async function open(page){
 await page.goto('/native/');await page.getByText('terminal',{exact:true}).first().click();
 await page.evaluate(()=>new Promise(resolve=>qaTerms[0].write('renderer fixture\r\n\x1b[31mred text\x1b[0m\r\n\x1b[7minverse\x1b[0m\r\nwide: 界🙂\r\n<script>unsafe</script>',resolve)));
 await expect.poll(()=>visibleText(page)).toContain('red text');
 await page.waitForTimeout(500);
}
test('native output preserves ANSI colors, wide cells and literal markup',async({page})=>{
 await open(page);
 const rows=page.locator('.native-terminal-content');
 await expect(rows).toContainText('red text');await expect(rows).toContainText('界🙂');await expect(rows).toContainText('<script>unsafe</script>');
 await expect(rows.locator('script')).toHaveCount(0);
 expect(await rows.locator('span').filter({hasText:'red text'}).evaluate(el=>getComputedStyle(el).color)).toBe('rgb(235, 111, 146)');
 const inverse=rows.locator('span').filter({hasText:'inverse'});expect(await inverse.evaluate(el=>getComputedStyle(el).backgroundColor)).toBe('rgb(224, 222, 244)');
 await page.screenshot({path:'artifacts/browser/native-renderer.png'});
});
test('scroll position moves by pixels and DOM stays bounded for long history',async({page})=>{
 await open(page);
 await page.evaluate(()=>new Promise(resolve=>qaTerms[0].write(Array.from({length:2900},(_,i)=>`row ${i}\r\n`).join(''),resolve)));
 const scroller=page.locator('.native-terminal-scroll');
 await expect.poll(()=>scroller.evaluate(el=>el.scrollHeight)).toBeGreaterThan(40000);
 await scroller.evaluate(el=>{el.scrollTop=20003});
 await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBe(20003);
 const first=await scroller.locator('.native-terminal-row').first().getAttribute('data-line');
 await scroller.evaluate(el=>{el.scrollTop+=3});
 await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBe(20006);
 expect(await scroller.locator('.native-terminal-row').count()).toBeLessThan(230);
 expect(await scroller.locator('.native-terminal-row').first().getAttribute('data-line')).toBe(first);
});

test('keyboard viewport resize keeps latest pinned and preserves a history position',async({page})=>{
 await open(page);
 await page.evaluate(()=>new Promise(resolve=>qaTerms[0].write(Array.from({length:220},(_,i)=>`resize ${i}\r\n`).join(''),resolve)));
 const scroller=page.locator('.native-terminal-scroll');
 await expect.poll(()=>scroller.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)).toBeLessThan(2);
 await page.locator('.remote-terminal').click();
 await page.evaluate(()=>document.documentElement.style.setProperty('--keyboard-inset','320px'));
 await expect.poll(()=>scroller.evaluate(el=>el.scrollHeight-el.clientHeight-el.scrollTop)).toBeLessThan(2);
 await scroller.evaluate(el=>{el.scrollTop=1000});await page.waitForTimeout(200);
 await page.evaluate(()=>document.documentElement.style.setProperty('--keyboard-inset','250px'));
 await expect.poll(()=>scroller.evaluate(el=>el.scrollTop)).toBeCloseTo(1000,0);
});

test('alternate screen and cursor visibility follow terminal escape sequences',async({page})=>{
 await open(page);const content=page.locator('.native-terminal-content');
 await page.evaluate(()=>new Promise(resolve=>qaTerms[0].write('\x1b[?1049h\x1b[2J\x1b[HALTERNATE\x1b[?25l',resolve)));
 await expect(content).toContainText('ALTERNATE');await expect(content).not.toContainText('renderer fixture');
 await expect.poll(()=>content.locator('span[style*="box-shadow"]').count()).toBe(0);
 await page.evaluate(()=>new Promise(resolve=>qaTerms[0].write('\x1b[?1049l\x1b[?25h',resolve)));
 await expect(content).toContainText('renderer fixture');await expect(content).not.toContainText('ALTERNATE');
 await expect.poll(()=>content.locator('span[style*="box-shadow"]').count()).toBe(1);
});
