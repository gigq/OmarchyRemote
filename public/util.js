/* Shared DOM and storage helpers for app modules (window.HyprlandUtil).
   Loaded right after apps.js so every module can destructure what it needs. */
(() => {
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n};
  // Live DOM only: the design runtime keeps a hidden template copy inside <x-dc>.
  const mount=id=>[...document.querySelectorAll('#'+id)].find(n=>!n.closest('x-dc'));
  const button=(text,action,cls='remote-button')=>{const b=node('button',cls,text);b.type='button';b.onclick=e=>{e.stopPropagation();action(e)};return b};
  // Native keeps a small local mirror so live and bundled offline origins share preferences.
  const native=window.__OMARCHY_DEVICE__?.snapshot;
  try{if(native&&Number(native['omarchy-local-modified']||0)>Number(localStorage.getItem('omarchy-local-modified')||0)){
    for(const key of Object.keys(localStorage))if(key.startsWith('omarchy-'))localStorage.removeItem(key);
    for(const [key,value]of Object.entries(native))if(key.startsWith('omarchy-')&&typeof value==='string')localStorage.setItem(key,value);
  }}catch{}
  let mirrorPending=false;
  const mirror=()=>{if(!window.webkit?.messageHandlers?.shellStorage||mirrorPending)return;mirrorPending=true;queueMicrotask(()=>{mirrorPending=false;try{const values=Object.fromEntries(Object.keys(localStorage).filter(k=>k.startsWith('omarchy-')).map(k=>[k,localStorage.getItem(k)]));window.webkit.messageHandlers.shellStorage.postMessage(values)}catch{}})};
  window.addEventListener('pagehide',mirror);
  // localStorage can throw (private mode, quota); every accessor swallows that.
  const storage={
    get:k=>{try{return localStorage.getItem(k)}catch{return null}},
    set:(k,v)=>{try{const value=v==null?null:String(v);if(localStorage.getItem(k)===value)return;value==null?localStorage.removeItem(k):localStorage.setItem(k,value);if(k.startsWith('omarchy-')){localStorage.setItem('omarchy-local-modified',String(Math.max(Date.now(),Number(localStorage.getItem('omarchy-local-modified')||0)+1)));mirror()}window.dispatchEvent(new CustomEvent('hyprland-storage',{detail:{key:k,value}}))}catch{}},
    read:(k,fallback=null)=>{try{return JSON.parse(localStorage.getItem(k))??fallback}catch{return fallback}},
    write:(k,v)=>storage.set(k,JSON.stringify(v))
  };
  window.HyprlandUtil={node,mount,button,storage};
})();
