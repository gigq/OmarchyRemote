// Fit the design's logical canvas to the usable viewport without stretching type.
function fitCanvas() {
  const viewport = document.getElementById('phone-viewport');
  if (!viewport) return;
  const scale = viewport.clientWidth / 402;
  if (!scale) return;
  document.documentElement.style.setProperty('--canvas-scale', scale);
  document.documentElement.style.setProperty('--canvas-height', `${viewport.clientHeight / scale}px`);
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
  const viewport=window.visualViewport;
  const scale=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--canvas-scale'))||1;
  const inset=viewport?Math.max(0,window.innerHeight-viewport.height):0;
  document.documentElement.classList.toggle('system-keyboard-open',inset>80);
  document.documentElement.style.setProperty('--keyboard-inset',`${inset/scale}px`);
}
window.visualViewport?.addEventListener('resize',fitNativeKeyboard);
window.visualViewport?.addEventListener('scroll',fitNativeKeyboard);
window.addEventListener('resize',fitNativeKeyboard);
fitNativeKeyboard();
