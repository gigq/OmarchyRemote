/* Desk layout for iPad, Mac, and desktop windows: workspaces tile up to four windows
   (Hyprland dwindle), a hardware keyboard drives the shell, and ⌘/ shows the bindings.
   The phone shell keeps one app per workspace; nothing here runs below the size threshold. */
(() => {
  const MIN_SIDE=600, MAX_TILES=4;
  const CHROME={top:60,side:24,bottom:26,gap:12};
  const APPLE=/Mac|iPhone|iPad|iPod/i.test(navigator.platform||'')||/Macintosh|iPad|iPhone/.test(navigator.userAgent);
  const MOD=APPLE?'⌘':'Ctrl+Alt';
  const {mount,node}=window.HyprlandUtil;
  const isDesk=()=>Math.min(window.innerWidth,window.innerHeight)>=MIN_SIDE;

  // ---- workspace model: pure functions over the shell state ---------------------------------
  // `open` stays the ordered list of open apps; `tiles` maps each app to its desk index (home is desk 0).
  const desks=s=>{
    const t=s.tiles||{};
    const rows=s.open.filter(k=>k!=='home').map((k,i)=>[k,Number.isInteger(t[k])&&t[k]>0?t[k]:1e6+i]);
    const ids=[...new Set(rows.map(r=>r[1]))].sort((a,b)=>a-b);
    return [['home'],...ids.map(id=>rows.filter(r=>r[1]===id).map(r=>r[0]))];
  };
  const normalize=s=>{const tiles={};desks(s).forEach((apps,i)=>{if(i)for(const k of apps)tiles[k]=i});return tiles};
  const deskOf=(s,key)=>desks(s).findIndex(d=>d.includes(key));
  const cur=s=>{const d=desks(s)[s.ws]||['home'];return d.includes(s.focus)?s.focus:d[0]};
  const clamp=(s,i)=>Math.max(0,Math.min(desks(s).length-1,i));
  const go=(s,i)=>{const ws=clamp(s,i);return{ws,focus:desks(s)[ws].includes(s.focus)?s.focus:null,tiles:normalize(s)}};
  const open=(s,key)=>{
    if(s.open.includes(key))return{ws:deskOf(s,key),focus:key,tiles:normalize(s)};
    const d=desks(s);const target=s.ws===0||(d[s.ws]||[]).length>=MAX_TILES?d.length:s.ws;
    const ns={...s,open:[...s.open,key],tiles:{...normalize(s),[key]:target}};
    return{open:ns.open,tiles:normalize(ns),ws:deskOf(ns,key),focus:key};
  };
  const close=(s,key)=>{
    const before=desks(s),pos=before.findIndex(d=>d.includes(key)),current=before[s.ws]||['home'];
    const tiles={...normalize(s)};delete tiles[key];
    const ns={...s,open:s.open.filter(k=>k!==key),tiles};const after=desks(ns);
    const survivors=current.filter(k=>k!==key);
    let ws=after.findIndex(d=>d.some(k=>survivors.includes(k)));
    if(ws<0)ws=Math.max(0,Math.min(pos-1,after.length-1));
    return{open:ns.open,tiles:normalize(ns),full:(s.full||[]).filter(k=>k!==key),ws,focus:after[ws]?.includes(s.focus)?s.focus:null};
  };
  const move=(s,key,target)=>{
    if(!key||key==='home'||!s.open.includes(key))return null;
    const d=desks(s);target=Math.max(1,Math.min(d.length,target));
    if(deskOf(s,key)===target)return null;
    const ns={...s,tiles:{...normalize(s),[key]:target}};
    return{tiles:normalize(ns),ws:deskOf(ns,key),focus:key,full:(s.full||[]).filter(k=>k!==key)};
  };
  const swap=(s,key,other)=>{
    if(!key||!other||key===other)return null;
    const open=[...s.open],a=open.indexOf(key),b=open.indexOf(other);if(a<0||b<0)return null;
    [open[a],open[b]]=[open[b],open[a]];return{open,focus:key};
  };
  const dwindle=(rect,n,gap)=>{
    if(n<=1)return[rect];
    const a={...rect},b={...rect};
    if(rect.w>=rect.h){a.w=Math.round((rect.w-gap)/2);b.x=rect.x+a.w+gap;b.w=rect.w-a.w-gap}
    else{a.h=Math.round((rect.h-gap)/2);b.y=rect.y+a.h+gap;b.h=rect.h-a.h-gap}
    return[a,...dwindle(b,n-1,gap)];
  };
  // Every open app gets a rectangle inside its desk; hidden siblings of a fullscreen window keep the full area.
  const layout=(s,W,H)=>{
    const area={x:CHROME.side,y:CHROME.top,w:Math.max(0,W-CHROME.side*2),h:Math.max(0,H-CHROME.top-CHROME.bottom)};
    const rects=new Map();
    desks(s).forEach((apps,desk)=>{
      const full=apps.find(k=>(s.full||[]).includes(k));const visible=full?[full]:apps;
      const rs=desk===0?[area]:dwindle(area,visible.length,CHROME.gap);
      visible.forEach((k,i)=>rects.set(k,{...rs[i],desk}));
      apps.filter(k=>!visible.includes(k)).forEach(k=>rects.set(k,{...area,desk,hidden:true}));
    });
    return{area,rects};
  };
  const neighbor=(s,W,H,key,dir)=>{
    const {rects}=layout(s,W,H),from=rects.get(key);if(!from)return null;
    const cx=from.x+from.w/2,cy=from.y+from.h/2;let best=null,score=Infinity;
    for(const [k,r] of rects){
      if(k===key||r.desk!==from.desk||r.hidden)continue;
      const dx=r.x+r.w/2-cx,dy=r.y+r.h/2-cy;
      const ahead=dir==='left'?-dx:dir==='right'?dx:dir==='up'?-dy:dy;if(ahead<=4)continue;
      const drift=dir==='left'||dir==='right'?Math.abs(dy):Math.abs(dx);const d=ahead+drift*2;
      if(d<score){score=d;best=k}
    }
    return best;
  };
  // Card bindings for renderVals: transforms, sizes, frames, pills, and the workspace label.
  const render=(logic,s,W,H)=>{
    const A=logic.APPS,d=desks(s),focused=cur(s),{area,rects}=layout(s,W,H);
    const n=d.length,cols=Math.min(n,Math.max(1,Math.round(Math.sqrt(n*W/Math.max(1,H))))),rows=Math.ceil(n/cols);
    const eg=Math.max(28,CHROME.gap*2),ex=CHROME.side,ey=CHROME.top+8,ew=Math.max(1,W-ex*2),eh=Math.max(1,H-ey-CHROME.bottom-8);
    const sc=Math.max(.05,Math.min((ew-(cols-1)*eg)/cols/Math.max(1,W),(eh-(rows-1)*eg)/rows/Math.max(1,H)));
    const gx=ex+(ew-(cols*W*sc+(cols-1)*eg))/2,gy=ey+(eh-(rows*H*sc+(rows-1)*eg))/2;
    const cards={};
    for(const k of Object.keys(A)){
      const r=rects.get(k);
      // Park unopened windows at the workspace's final height and size for horizontal entry.
      if(!r){cards[k]={tf:`translate(${W+40}px,${area.y}px) scale(1)`,w:area.w+'px',h:area.h+'px',bd:'var(--theme-window-inactive)',lab:0,op:0,pe:'none',tap:()=>{}};continue}
      const tf=s.ov?`translate(${Math.round(gx+(r.desk%cols)*(W*sc+eg)+r.x*sc)}px,${Math.round(gy+Math.floor(r.desk/cols)*(H*sc+eg)+r.y*sc)}px) scale(${sc.toFixed(4)})`:`translate(${r.x+(r.desk-s.ws)*W}px,${r.y}px) scale(1)`;
      cards[k]={tf,w:r.w+'px',h:r.h+'px',bd:k===focused&&r.desk===s.ws?'var(--theme-accent)':'var(--theme-window-inactive)',lab:s.ov?1:0,op:r.hidden?0:1,pe:r.hidden?'none':'auto',tap:()=>{if(logic.state.ov)logic.jump(k)}};
    }
    const pills=d.map((apps,i)=>({i:i+1,col:logic.T.mu,bg:i===s.ws?logic.T.sf2:'transparent',c:i===s.ws?logic.T.fg:logic.T.mu,on:()=>{if(i===logic.state.ws)logic.set({ov:!logic.state.ov,kb:false});else logic.go(i)}}));
    const apps=d[s.ws]||['home'];
    const label=s.ws===0?`home · ${(s.homePins||[]).length||10} apps`:`${A[focused]?.name||focused} · ${apps.length} ${apps.length===1?'window':'windows'} · ${apps.some(k=>(s.full||[]).includes(k))?'fullscreen':'dwindle'}`;
    return{cards,pills,label};
  };

  // ---- keyboard bindings ------------------------------------------------------------------------
  // Apple keyboards use ⌘ (SUPER on Omarchy); elsewhere Ctrl+Alt stays clear of terminal and browser keys.
  const BINDINGS=[
    {group:'Workspaces',keys:'1…9 / 0',code:/^Digit[0-9]$/,label:'Switch to workspace',run:(d,e)=>d.logic.go((Number(e.code.slice(5))||10)-1)},
    {group:'Workspaces',keys:'[ / ]',code:/^Bracket(Left|Right)$/,label:'Previous / next workspace',run:(d,e)=>d.logic.go(d.logic.state.ws+(e.code==='BracketLeft'?-1:1))},
    {group:'Workspaces',keys:'E',code:/^KeyE$/,label:'Expo overview',run:d=>d.logic.set({ov:!d.logic.state.ov,kb:false,sup:false,launch:false,shade:null})},
    {group:'Windows',keys:'⇧ 1…9 / 0',shift:true,code:/^Digit[0-9]$/,desk:true,label:'Move window to workspace',run:(d,e)=>d.moveWindow((Number(e.code.slice(5))||10)-1)},
    {group:'Windows',keys:'⇧ [ / ]',shift:true,code:/^Bracket(Left|Right)$/,desk:true,label:'Move window to previous / next workspace',run:(d,e)=>d.moveWindow(d.logic.state.ws+(e.code==='BracketLeft'?-1:1))},
    {group:'Windows',keys:'← ↑ ↓ →',code:/^Arrow/,label:'Focus window in direction',run:(d,e)=>d.focusDir(e.code.slice(5).toLowerCase())},
    {group:'Windows',keys:'⇧ ← ↑ ↓ →',shift:true,code:/^Arrow/,desk:true,label:'Swap window in direction',run:(d,e)=>d.swapDir(e.code.slice(5).toLowerCase())},
    {group:'Windows',keys:'J',code:/^KeyJ$/,desk:true,label:'Next window in workspace',run:d=>d.cycle(1)},
    {group:'Windows',keys:'⇧ J',shift:true,code:/^KeyJ$/,desk:true,label:'Previous window in workspace',run:d=>d.cycle(-1)},
    {group:'Windows',keys:'F',code:/^KeyF$/,desk:true,label:'Toggle fullscreen window',run:d=>d.toggleFull()},
    {group:'Windows',keys:'W',code:/^KeyW$/,label:'Close window',run:d=>d.logic.closeWs()},
    {group:'Windows',keys:'⌫',code:/^Backspace$/,label:'Close window (when the browser owns ⌘W)',run:d=>d.logic.closeWs()},
    {group:'Apps',keys:'↩',code:/^(Enter|NumpadEnter)$/,label:'Terminal',run:d=>d.logic.openApp('terminal')},
    {group:'Apps',keys:'⇧ ↩',shift:true,code:/^(Enter|NumpadEnter)$/,label:'Browser',run:d=>d.logic.openApp('browser')},
    {group:'Apps',keys:'⇧ B',shift:true,code:/^KeyB$/,label:'Browser',run:d=>d.logic.openApp('browser')},
    {group:'Apps',keys:'⇧ F',shift:true,code:/^KeyF$/,label:'Files',run:d=>d.logic.openApp('files')},
    {group:'Apps',keys:'⇧ A',shift:true,code:/^KeyA$/,label:'Herd agents',run:d=>d.logic.openApp('herdr')},
    {group:'Apps',keys:'⇧ D',shift:true,code:/^KeyD$/,label:'lazydocker',run:d=>d.logic.openApp('lazydocker')},
    {group:'Apps',keys:',',code:/^Comma$/,label:'Settings',run:d=>d.logic.openApp('settings')},
    {group:'Shell',keys:'K',code:/^KeyK$/,label:'Launcher',run:d=>d.logic.state.launch?d.logic.set({launch:false,kb:false,query:''}):d.logic.openLauncher()},
    {group:'Shell',keys:'/',code:/^Slash$/,label:'Show these shortcuts',run:d=>d.toggleSheet()},
  ];
  const EDITING=new Set(['KeyA','KeyC','KeyV','KeyX','KeyZ','Backspace','ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);
  const editable=el=>!!el&&(el.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  class Desk {
    constructor(logic){
      this.logic=logic;this.abort=new AbortController();const signal=this.abort.signal;
      this.shell=mount('touch-shell');
      window.addEventListener('keydown',e=>this.keydown(e),{capture:true,signal});
      this.shell?.addEventListener('pointerdown',e=>this.pointerdown(e),{capture:true,signal});
      window.addEventListener('hyprland-layout',e=>this.measure(e.detail),{signal});
      this.shell?.addEventListener('click',e=>{
        if(e.target.closest('[data-desk-shortcuts]')){e.stopPropagation();this.toggleSheet()}
      },{signal});
      const help=this.shell?.querySelector('[data-desk-shortcuts]');
      if(help){help.textContent=`${MOD} /`;help.title=`Keyboard shortcuts (${MOD} /)`}
      this.measure();
    }
    measure(detail){
      const viewport=mount('phone-viewport');
      const desk=detail?detail.desk:isDesk();
      const inset=detail?detail.inset:0;
      const W=detail?detail.width:viewport?.clientWidth||window.innerWidth,H=Math.max(0,(detail?detail.height:viewport?.clientHeight||window.innerHeight)-inset);
      const s=this.logic.state;
      if(s.desk!==desk||(desk&&(s.deskW!==W||s.deskH!==H)))this.logic.set({desk,deskW:W,deskH:H});
    }
    update(){if(!this.logic.state.desk&&this.sheet)this.closeSheet()}
    pointerdown(e){
      const s=this.logic.state;if(!s.desk||s.ov||e.button>0)return;
      const key=e.target.closest('[data-workspace]')?.dataset.workspace;
      if(key&&key!==this.logic.cur()&&deskOf(s,key)===s.ws)this.logic.focusApp(key);
    }
    keydown(e){
      const s=this.logic.state,logic=this.logic;
      if(e.key==='Escape'&&!e.metaKey&&!e.ctrlKey&&!e.altKey){
        if(this.sheet){this.closeSheet();e.preventDefault();e.stopImmediatePropagation();return}
        if(editable(e.target))return;
        if(s.ov)logic.set({ov:false});else if(s.shade)logic.set({shade:null});else return;
        e.preventDefault();e.stopImmediatePropagation();return;
      }
      // ⌘ works everywhere it reaches the page; Ctrl+Alt is the Windows/Linux spelling.
      const apple=e.metaKey&&!e.ctrlKey&&!e.altKey,combo=!apple&&e.ctrlKey&&e.altKey&&!e.metaKey;
      if(!(apple||combo)||e.repeat)return;
      const inField=editable(e.target);
      if(inField&&(apple?(!e.shiftKey&&EDITING.has(e.code))||(e.shiftKey&&/^Arrow|^KeyZ$/.test(e.code)):!/^(Arrow|Enter|Backspace|Escape)/.test(e.code)))return;
      const binding=BINDINGS.find(b=>b.code.test(e.code)&&!!b.shift===e.shiftKey&&(!b.desk||s.desk));
      if(!binding)return;
      e.preventDefault();e.stopImmediatePropagation();
      if(this.sheet&&!/Slash/.test(e.code))this.closeSheet();
      binding.run(this,e);
    }
    // Window operations only make sense on the desk; the phone keeps one app per workspace.
    patch(p){if(p)this.logic.set(p)}
    moveWindow(target){const s=this.logic.state;if(!s.desk)return;if(target<1)return;this.patch(move(s,cur(s),target))}
    focusDir(dir){
      const s=this.logic.state;
      if(!s.desk){if(dir==='left')this.logic.go(s.ws-1);else if(dir==='right')this.logic.go(s.ws+1);else if(dir==='up')this.logic.set({ov:true,kb:false,sup:false});else this.logic.go(0);return}
      const next=neighbor(s,s.deskW,s.deskH,cur(s),dir);if(next)this.logic.focusApp(next);
    }
    swapDir(dir){const s=this.logic.state;if(!s.desk)return;this.patch(swap(s,cur(s),neighbor(s,s.deskW,s.deskH,cur(s),dir)))}
    cycle(step){const s=this.logic.state;if(!s.desk)return;const apps=desks(s)[s.ws]||[];if(apps.length<2)return;const i=apps.indexOf(cur(s));const next=apps[(i+step+apps.length)%apps.length];if(apps.some(k=>(s.full||[]).includes(k)))this.logic.set({full:[...(s.full||[]).filter(k=>!apps.includes(k)),next]});this.logic.focusApp(next)}
    toggleFull(){const s=this.logic.state;if(!s.desk||s.ws===0)return;const key=cur(s),full=(s.full||[]).includes(key)?(s.full||[]).filter(k=>k!==key):[...(s.full||[]).filter(k=>deskOf(s,k)!==s.ws),key];this.logic.set({full,focus:key})}
    toggleSheet(){if(this.sheet)this.closeSheet();else this.openSheet()}
    openSheet(){
      if(!this.shell)return;this.closeSheet();
      const sheet=node('div','desk-sheet');sheet.setAttribute('role','dialog');sheet.setAttribute('aria-label','Keyboard shortcuts');
      const close=node('button','desk-sheet-close','Done');close.type='button';close.onclick=()=>this.closeSheet();
      const head=node('div','desk-sheet-head');head.append(node('h2','','Keyboard shortcuts'),node('span','widget-muted',`${MOD} is SUPER · ⇧ is Shift`),close);sheet.append(head);
      const grid=node('div','desk-sheet-grid');
      for(const group of [...new Set(BINDINGS.map(b=>b.group))]){
        const section=node('section','desk-sheet-group');section.append(node('h3','',group));
        for(const b of BINDINGS.filter(b=>b.group===group&&(!b.desk||this.logic.state.desk))){const row=node('div','desk-sheet-row');row.append(node('kbd','',`${MOD} ${b.keys}`),node('span','',b.label));section.append(row)}
        grid.append(section);
      }
      sheet.append(grid,node('p','widget-muted desk-sheet-foot','0 selects workspace 10. J cycles windows within one workspace; [ / ] switches workspaces. Text editing keys stay with the focused field. ⌘Space and ⌘` are left to iPadOS. Esc or Done closes this list.'));
      sheet.addEventListener('pointerdown',e=>{if(e.target===sheet)this.closeSheet();e.stopPropagation()});
      this.returnFocus=document.activeElement;this.shell.append(sheet);this.sheet=sheet;close.focus({preventScroll:true});
    }
    closeSheet(){if(!this.sheet)return;this.sheet.remove();this.sheet=null;if(this.returnFocus?.matches('button'))this.returnFocus.focus({preventScroll:true});this.returnFocus=null}
    dispose(){this.closeSheet();this.abort.abort()}
  }
  window.HyprlandDesk={attach:logic=>new Desk(logic),isDesk,desks,deskOf,cur,go,open,close,move,swap,layout,render,BINDINGS,MOD,CHROME};
})();
