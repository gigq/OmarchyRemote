/* Shared DOM and storage helpers for app modules (window.HyprlandUtil).
   Loaded right after apps.js so every module can destructure what it needs. */
(() => {
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n};
  // Live DOM only: the design runtime keeps a hidden template copy inside <x-dc>.
  const mount=id=>[...document.querySelectorAll('#'+id)].find(n=>!n.closest('x-dc'));
  const button=(text,action,cls='remote-button')=>{const b=node('button',cls,text);b.type='button';b.onclick=e=>{e.stopPropagation();action(e)};return b};
  // localStorage can throw (private mode, quota); every accessor swallows that.
  const storage={
    get:k=>{try{return localStorage.getItem(k)}catch{return null}},
    set:(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch{}},
    read:(k,fallback=null)=>{try{return JSON.parse(localStorage.getItem(k))??fallback}catch{return fallback}},
    write:(k,v)=>{try{localStorage.setItem(k,JSON.stringify(v))}catch{}}
  };
  window.HyprlandUtil={node,mount,button,storage};
})();
