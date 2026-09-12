// Fit the design's logical canvas to the usable viewport without stretching type.
// Screens with both edges past 600px (iPad, Mac, desktop windows) get the desk layout at 1:1 instead.
function deskMode() { return Math.min(window.innerWidth, window.innerHeight) >= 600; }
function keyboardInset() {
  const native=window.__HYPRLAND_KEYBOARD__;
  if(deskMode()&&native&&Number.isFinite(native.inset)&&Number.isFinite(native.height)&&native.height>0){
    return Math.max(0,native.inset*window.innerHeight/native.height);
  }
  return window.visualViewport?Math.max(0,window.innerHeight-window.visualViewport.height):0;
}
function fitCanvas() {
  const viewport = document.getElementById('phone-viewport');
  if (!viewport) return;
  const root = document.documentElement, desk = deskMode();
  root.classList.toggle('desk-mode', desk);
  root.classList.toggle('desk-landscape', desk && window.innerWidth >= window.innerHeight);
  root.classList.toggle('desk-portrait', desk && window.innerWidth < window.innerHeight);
  const scale = desk ? 1 : viewport.clientWidth / 402;
  if (!scale) return;
  root.style.setProperty('--canvas-scale', scale);
  root.style.setProperty('--canvas-height', `${viewport.clientHeight / scale}px`);
  const inset = keyboardInset();
  window.dispatchEvent(new CustomEvent('hyprland-layout', { detail: { desk, width: viewport.clientWidth, height: viewport.clientHeight, inset: inset > 80 ? inset : 0 } }));
}
const observer = new MutationObserver(() => {
  const viewport = document.getElementById('phone-viewport');
  if (!viewport || viewport.closest('x-dc')) return;
  new ResizeObserver(fitCanvas).observe(viewport);
  fitCanvas();
  observer.disconnect();
});
observer.observe(document.body, { childList: true, subtree: true });
window.addEventListener('resize', fitCanvas);
window.visualViewport?.addEventListener('resize', fitCanvas);
fitCanvas();

// A swipe across a tile should never become a click on that tile.
let touch = null;
document.addEventListener('pointerdown', event => {
  touch = event.target.closest('#touch-shell') ? { x: event.clientX, y: event.clientY, moved: false } : null;
}, true);
document.addEventListener('pointermove', event => {
  if (touch && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 15) touch.moved = true;
}, true);
document.addEventListener('click', event => {
  if (touch?.moved && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); }
  touch = null;
}, true);
document.addEventListener('pointercancel', () => { touch = null; }, true);

if (!window.__HYPRLAND_DEV__ && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(error => {
      console.warn('Offline support could not be installed:', error);
    });
  });
}

// iOS shrinks the visual viewport for its keyboard, not the layout viewport.
function fitNativeKeyboard(){
  const scale=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--canvas-scale'))||1;
  const inset=keyboardInset();
  document.documentElement.classList.toggle('system-keyboard-open',inset>80);
  document.documentElement.style.setProperty('--keyboard-inset',`${inset/scale}px`);
}
window.visualViewport?.addEventListener('resize',fitNativeKeyboard);
window.visualViewport?.addEventListener('scroll',fitNativeKeyboard);
window.addEventListener('resize',fitNativeKeyboard);
fitNativeKeyboard();

window.addEventListener('hyprland-keyboard',()=>{fitCanvas();fitNativeKeyboard()});

// The native wrapper publishes device battery changes; unknown/PWA states stay hidden.
function updateDeviceBattery(){
  const battery=window.__HYPRLAND_BATTERY__;
  const valid=Number.isFinite(battery?.percent)&&battery.percent>=0&&battery.percent<=100;
  document.querySelectorAll('[data-device-battery]').forEach(el=>{
    el.hidden=!valid;if(!valid)return;
    const percent=Math.round(battery.percent),charging=['charging','full'].includes(battery.state);
    el.dataset.charging=String(charging);el.dataset.low=String(percent<=20);
    el.querySelector('[data-battery-percent]').textContent=`${percent}%`;
    el.querySelector('[data-battery-fill]').setAttribute('width',String(15*percent/100));
    const label=`Battery: ${percent}%${battery.state==='full'?', fully charged':charging?', charging':''}`;
    el.setAttribute('aria-label',label);el.title=label;
  });
}
window.addEventListener('hyprland-battery',updateDeviceBattery);
updateDeviceBattery();
