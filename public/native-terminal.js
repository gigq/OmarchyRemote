/* Native overflow scrolling over xterm's parsed buffer. No touchmove cancellation,
   velocity simulation, or per-frame scroll-position animation. */
(() => {
  const palette=['#26233a','#eb6f92','#9ccfd8','#f6c177','#31748f','#c4a7e7','#9ccfd8','#e0def4','#6e6a86','#ff0000','#00ff00','#ffff00','#0000ff','#ff00ff','#00ffff','#ffffff'];
  const color=(n,rgb)=>{
    if(rgb)return '#'+n.toString(16).padStart(6,'0');
    if(n<16)return palette[n];
    if(n>=232){const v=8+(n-232)*10;return `rgb(${v},${v},${v})`}
    n-=16;const c=v=>v?55+40*v:0;return `rgb(${c(Math.floor(n/36))},${c(Math.floor(n/6)%6)},${c(n%6)})`;
  };
  class NativeTerminalView {
    constructor(host,term,onScroll=()=>{},onIdle=()=>{}){
      this.host=host;this.term=term;this.onScroll=onScroll;this.onIdle=onIdle;
      this.height=18;this.width=7.2;this.frame=null;this.rows=new Map();this.syncing=false;this.busy=false;this.finger=false;this.follow=true;this.dirty=true;this.cursorVisible=true;
      this.scroller=document.createElement('div');this.scroller.className='native-terminal-scroll';this.scroller.tabIndex=0;this.scroller.setAttribute('aria-label','Terminal output');
      this.content=document.createElement('div');this.content.className='native-terminal-content';this.scroller.append(this.content);host.append(this.scroller);
      this.edges=['left','right'].map(side=>{const edge=document.createElement('div');edge.className='native-scroll-edge '+side;edge.setAttribute('aria-hidden','true');host.append(edge);return edge});
      term.element.classList.add('terminal-parser');term.element.setAttribute('aria-hidden','true');term.textarea.tabIndex=-1;
      this.abort=new AbortController();const listen=(type,fn,options={})=>this.scroller.addEventListener(type,fn,{...options,signal:this.abort.signal});
      listen('scroll',()=>{
        if(this.expected!==undefined&&Math.abs(this.scroller.scrollTop-this.expected)<1){this.expected=undefined;this.schedule();return}
        if(this.viewportHeight!==this.scroller.clientHeight){this.schedule();return}
        this.follow=this.scroller.scrollTop>=this.scroller.scrollHeight-this.scroller.clientHeight-1;
        this.busy=true;clearTimeout(this.idleTimer);this.idleTimer=setTimeout(()=>this.idle(),160);
        this.syncing=true;term.scrollToLine(Math.floor(this.scroller.scrollTop/this.height));this.syncing=false;
        this.schedule();onScroll();
      },{passive:true});
      listen('scrollend',()=>this.idle(),{passive:true});
      listen('touchstart',e=>{this.finger=true;this.startY=e.touches[0]?.clientY;this.startX=e.touches[0]?.clientX;this.moved=this.busy;e.stopPropagation()},{passive:true});
      listen('touchmove',e=>{if(Math.hypot(e.touches[0].clientY-this.startY,e.touches[0].clientX-this.startX)>6)this.moved=true;e.stopPropagation()},{passive:true});
      const end=e=>{this.finger=false;e.stopPropagation();clearTimeout(this.idleTimer);this.idleTimer=setTimeout(()=>this.idle(),160)};
      listen('touchend',end,{passive:true});listen('touchcancel',end,{passive:true});
      listen('pointerdown',e=>e.stopPropagation());
      listen('click',e=>{if(this.moved){e.preventDefault();e.stopImmediatePropagation();this.moved=false}}, {capture:true});
      this.listeners=[term.onWriteParsed(()=>this.schedule(true)),term.onResize(()=>{if(this.follow)this.target=term.buffer.active.baseY;this.schedule(true)}),term.onScroll(()=>{
        if(!this.syncing){this.target=term.buffer.active.viewportY;this.follow=this.target>=term.buffer.active.baseY;this.schedule()}
      })];
      for(const [final,visible] of [['h',true],['l',false]])this.listeners.push(term.parser.registerCsiHandler({prefix:'?',final},params=>{if(params.includes(25)){this.cursorVisible=visible;this.schedule(true)}return false}));
      this.listeners.push(term.buffer.onBufferChange(()=>{this.target=term.buffer.active.viewportY;this.follow=this.target>=term.buffer.active.baseY;this.schedule(true)}));
      this.resize=new ResizeObserver(()=>this.schedule());this.resize.observe(host);this.schedule();
    }
    idle(){if(this.finger)return;this.busy=false;clearTimeout(this.idleTimer);this.onIdle()}
    active(){return this.busy||this.finger}
    cancel(){this.scroller.scrollTo({top:this.scroller.scrollTop,left:this.scroller.scrollLeft,behavior:'instant'});this.finger=false;this.idle()}
    schedule(dirty=false){this.dirty ||= dirty;if(this.frame===null)this.frame=requestAnimationFrame(()=>{this.frame=null;this.render()})}
    render(){
      const {term,scroller,content}=this;if(!this.host.clientHeight)return;
      const screen=term.element.querySelector('.xterm-screen');
      let dirty=this.dirty;this.dirty=false;const oldHeight=this.height,oldWidth=this.width;
      this.height=parseFloat(screen.style.height)/term.rows||18;this.width=parseFloat(screen.style.width)/term.cols||7.2;
      dirty ||= oldHeight!==this.height||oldWidth!==this.width;
      const b=term.buffer.active;
      if(this.viewportHeight!==scroller.clientHeight&&this.follow)this.target=b.baseY;
      this.viewportHeight=scroller.clientHeight;
      content.style.height=`${Math.max(b.length*this.height,b.baseY*this.height+scroller.clientHeight)}px`;
      content.style.width=`${term.cols*this.width}px`;
      if(this.target!==undefined){this.expected=Math.min(this.target*this.height,content.offsetHeight-scroller.clientHeight);scroller.scrollTop=this.expected;this.target=undefined}
      // Overscan allows the compositor to keep moving existing text between JS updates.
      const top=Math.max(0,Math.floor(scroller.scrollTop/this.height)-80),end=Math.min(b.length,Math.ceil((scroller.scrollTop+scroller.clientHeight)/this.height)+80);
      for(const [i,row] of this.rows)if(i<top||i>=end){row.remove();this.rows.delete(i)}
      const cell=b.getNullCell();
      for(let y=top;y<end;y++){
        const line=b.getLine(y);if(!line)continue;
        let row=this.rows.get(y);if(row&&!dirty)continue;if(!row){row=document.createElement('div');row.className='native-terminal-row';row.dataset.line=y;content.append(row);this.rows.set(y,row)}
        row.style.top=`${y*this.height}px`;row.style.height=row.style.lineHeight=`${this.height}px`;
        const runs=[];let run;
        for(let x=0;x<term.cols;x++){
          const c=line.getCell(x,cell);if(!c||!c.getWidth())continue;
          let fg=c.isFgDefault()?'#e0def4':color(c.getFgColor(),c.isFgRGB()),bg=c.isBgDefault()?'transparent':color(c.getBgColor(),c.isBgRGB());
          if(c.isInverse())[fg,bg]=[bg==='transparent'?'#15131f':bg,fg];
          const cursor=this.cursorVisible&&!term.options.disableStdin&&y===b.baseY+b.cursorY&&x===b.cursorX;
          const decoration=[c.isUnderline()?'underline':'',c.isStrikethrough()?'line-through':'',c.isOverline()?'overline':''].filter(Boolean).join(' ')||'none';
          const style=`color:${fg};background:${bg};font-weight:${c.isBold()?700:400};font-style:${c.isItalic()?'italic':'normal'};opacity:${c.isDim()?.5:1};text-decoration:${decoration};${cursor?'box-shadow:inset 0 0 0 1px #ebbcba;':''}`;
          const chars=c.isInvisible()?' '.repeat(c.getWidth()):(c.getChars()||' ');
          if(run&&run.style===style&&c.getWidth()===1&&run.simple){run.text+=chars;run.width++}
          else{run={style,text:chars,width:c.getWidth(),simple:c.getWidth()===1};runs.push(run)}
        }
        const signature=JSON.stringify([this.width,runs]);if(signature===row.signature)continue;row.signature=signature;
        const fragment=document.createDocumentFragment();for(const r of runs){const span=document.createElement('span');span.style.cssText=r.style+`width:${r.width*this.width}px`;span.textContent=r.text;fragment.append(span)}row.replaceChildren(fragment);
      }
    }
    dispose(){this.abort.abort();this.resize.disconnect();this.listeners.forEach(l=>l.dispose());cancelAnimationFrame(this.frame);clearTimeout(this.idleTimer);this.scroller.remove();this.edges.forEach(edge=>edge.remove())}
  }
  window.NativeTerminalView=NativeTerminalView;
})();
