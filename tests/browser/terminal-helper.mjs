export async function captureTerminals(page){await page.addInitScript(()=>{let ctor;Object.defineProperty(window,'Terminal',{configurable:true,get:()=>ctor,set:Base=>{ctor=class extends Base{constructor(...args){super(...args);(window.qaTerms??=[]).push(this)}}}})})}
export async function visibleText(page){return page.evaluate(()=>{const t=qaTerms[0],b=t.buffer.active;return Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||'').join('\n')})}
export async function exitShell(page){
 await page.evaluate(()=>qaTerms[0].input('\x03'));
 // SIGINT can flush bytes following it in the same PTY write.
 await page.waitForTimeout(150);
 await page.evaluate(()=>qaTerms[0].input('\x15exit\r'));
}
