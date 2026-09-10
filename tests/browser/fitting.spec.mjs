import {test,expect} from '@playwright/test';
import {captureTerminals} from './terminal-helper.mjs';
test('fit wraps words and wide glyphs without changing source columns or losing ANSI text',async({page})=>{
 await captureTerminals(page);await page.route('**/api/**',route=>route.abort());
 await page.goto('/native/');await page.getByText('terminal',{exact:true}).first().click();await page.waitForTimeout(500);
 const prose='This is a long paragraph with colored words that should wrap cleanly at spaces without changing the original desktop terminal layout.';
 await page.evaluate(async prose=>{const t=qaTerms[0];t.resize(180,30);t.reset();await new Promise(r=>t.write('\x1b[31m'+prose+'\x1b[0m\r\n'+'界🙂'.repeat(50)+'\r\n'+'x'.repeat(170),r));t.nativeView.setFit(true)},prose);
 const scroller=page.locator('.native-terminal-scroll');
 await expect.poll(()=>scroller.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThan(2);
 const segments=await page.evaluate(()=>{const v=qaTerms[0].nativeView,b=qaTerms[0].buffer.active;return v.layout.filter(r=>r.source===0).map(r=>b.getLine(0).translateToString(false,r.start,r.end))});
 expect(segments.length).toBeGreaterThan(1);expect(segments.join('')).toBe(prose);for(const segment of segments.slice(0,-1))expect(segment.endsWith(' ')).toBe(true);
 expect(await page.evaluate(()=>qaTerms[0].cols)).toBe(180);
 expect(await page.locator('.native-terminal-row span').filter({hasText:'This is'}).evaluate(el=>getComputedStyle(el).color)).toBe('rgb(235, 111, 146)');
 await page.screenshot({path:'artifacts/browser/fit-to-phone.png'});
 await page.evaluate(()=>qaTerms[0].nativeView.setFit(false));
 await expect.poll(()=>scroller.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeGreaterThan(500);
 expect(await page.evaluate(()=>qaTerms[0].cols)).toBe(180);
});

test('fitted scrolling retains its source line when toggling width modes',async({page})=>{
 await captureTerminals(page);await page.route('**/api/**',route=>route.abort());await page.goto('/native/');await page.getByText('terminal',{exact:true}).first().click();await page.waitForTimeout(500);
 await page.evaluate(async()=>{const t=qaTerms[0];t.resize(160,30);t.reset();await new Promise(r=>t.write(Array.from({length:100},(_,i)=>`Line ${i} with a long readable paragraph that will fill several mobile rows while keeping its original source coordinates.\r\n`).join(''),r));t.nativeView.setFit(true)});
 const scroller=page.locator('.native-terminal-scroll');await expect.poll(()=>scroller.evaluate(el=>el.scrollHeight)).toBeGreaterThan(4000);
 await scroller.evaluate(el=>{el.scrollTop=1803});await page.waitForTimeout(200);
 const source=await page.evaluate(()=>qaTerms[0].nativeView.anchor().source);
 await page.evaluate(()=>qaTerms[0].nativeView.setFit(false));await page.waitForTimeout(100);
 expect(await page.evaluate(()=>qaTerms[0].nativeView.anchor().source)).toBe(source);
 await page.evaluate(()=>qaTerms[0].nativeView.setFit(true));await page.waitForTimeout(100);
 expect(await page.evaluate(()=>qaTerms[0].nativeView.anchor().source)).toBe(source);
});
