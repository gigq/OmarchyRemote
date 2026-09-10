/* Shared host client. App adapters own their views; the shell owns gestures/keyboard. */
(() => {
  const theme={background:'#15131f',foreground:'#e0def4',cursor:'#ebbcba',selectionBackground:'#403d52',black:'#26233a',red:'#eb6f92',green:'#9ccfd8',yellow:'#f6c177',blue:'#31748f',magenta:'#c4a7e7',cyan:'#9ccfd8',white:'#e0def4',brightBlack:'#6e6a86'};
  const node=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n};
  const button=(text,action)=>{const b=node('button','remote-button',text);b.type='button';b.onclick=e=>{e.stopPropagation();action()};return b};
  const mount=id=>[...document.querySelectorAll('#'+id)].find(n=>!n.closest('x-dc'));
  const storage={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch{}}};
  const api=async(path,body)=>{
    const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Hyprland-Client':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
    const value=await response.json();if(!response.ok)throw Error(value.error||'Host unavailable');return value;
  };
  const socket=path=>new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/${path}`);
  function terminal(host,readonly=false){
    const t=new Terminal({fontFamily:'"JetBrains Mono", monospace',fontSize:12,lineHeight:1.15,theme,scrollback:3000,cursorBlink:!readonly,disableStdin:readonly,allowProposedApi:false});
    t.open(host);t.textarea?.setAttribute('inputmode','none');t.textarea?.setAttribute('autocapitalize','off');
    return t;
  }
  // xterm 6 scrollbars handle wheels, but don't translate iPhone touch drags.
  // Keep shell edge gestures; drag inside a terminal reads its history instead.
  function touchScroll(host,term,horizontal,onScroll=()=>{}){
    let gesture=null,frame=null,ignoreClickUntil=0;
    const cancel=()=>{if(frame!==null)cancelAnimationFrame(frame);frame=null};
    const edge=t=>{const shell=mount('touch-shell')?.getBoundingClientRect();return shell&&(t.clientX<shell.left+shell.width*.08||t.clientX>shell.right-shell.width*.08)};
    const scroll=(g,dx,dy)=>{
      const screen=term.element.querySelector('.xterm-screen');
      const cellHeight=screen.getBoundingClientRect().height/term.rows||18;
      g.remainder+=dy/cellHeight;const lines=Math.trunc(g.remainder);
      if(lines){const before=term.buffer.active.viewportY;term.scrollLines(lines);g.remainder-=lines;if(term.buffer.active.viewportY===before){g.vy=0;g.remainder=0}}
      if(horizontal){const before=host.scrollLeft,scale=host.getBoundingClientRect().width/host.offsetWidth||1;host.scrollLeft+=dx/scale;if(host.scrollLeft===before&&Math.abs(dx)>1)g.vx=0}
      else g.vx=0;
      onScroll();
    };
    const coast=g=>{
      let previous=performance.now();
      const step=now=>{
        frame=null;const elapsed=now-previous;previous=now;
        if(elapsed>120||Math.hypot(g.vx,g.vy)<.06)return;
        const dt=Math.min(elapsed,40),decay=Math.exp(-dt/220);
        scroll(g,g.vx*dt,g.vy*dt);g.vx*=decay;g.vy*=decay;
        if(Math.hypot(g.vx,g.vy)>=.06)frame=requestAnimationFrame(step);
      };
      frame=requestAnimationFrame(step);
    };
    const pointer=e=>{if(e.pointerType==='touch'&&!edge(e))e.stopPropagation()};
    const start=e=>{
      const stopping=frame!==null;cancel();
      if(e.touches.length!==1||edge(e.touches[0])){gesture=null;return}
      const t=e.touches[0];gesture={x:t.clientX,y:t.clientY,lastX:t.clientX,lastY:t.clientY,remainder:0,drag:false,stopping,vx:0,vy:0,time:performance.now()};e.stopPropagation();
    };
    const move=e=>{
      if(!gesture||e.touches.length!==1)return;const t=e.touches[0],g=gesture;
      if(!g.drag&&Math.hypot(t.clientX-g.x,t.clientY-g.y)<6)return;
      g.drag=true;e.preventDefault();e.stopImmediatePropagation();
      const now=performance.now(),dt=Math.max(8,now-g.time),dx=g.lastX-t.clientX,dy=g.lastY-t.clientY;
      g.vx=Math.max(-3,Math.min(3,.65*dx/dt+.35*g.vx));g.vy=Math.max(-3,Math.min(3,.65*dy/dt+.35*g.vy));
      scroll(g,dx,dy);g.lastX=t.clientX;g.lastY=t.clientY;g.time=now;
    };
    const end=e=>{
      const g=gesture;gesture=null;
      if(g?.drag||g?.stopping){ignoreClickUntil=performance.now()+350;e.preventDefault();e.stopImmediatePropagation()}
      if(g?.drag&&e.type==='touchend'&&performance.now()-g.time<100)coast(g);
    };
    const click=e=>{if(e.detail!==0&&performance.now()<ignoreClickUntil){e.preventDefault();e.stopImmediatePropagation()}};
    host.addEventListener('click',click,true);host.addEventListener('wheel',cancel,{capture:true,passive:true});
    host.addEventListener('pointerdown',pointer,true);host.addEventListener('touchstart',start,{capture:true,passive:true});host.addEventListener('touchmove',move,{capture:true,passive:false});host.addEventListener('touchend',end,{capture:true,passive:false});host.addEventListener('touchcancel',end,true);
    const dispose=()=>{cancel();host.removeEventListener('click',click,true);host.removeEventListener('wheel',cancel,true);host.removeEventListener('pointerdown',pointer,true);host.removeEventListener('touchstart',start,true);host.removeEventListener('touchmove',move,true);host.removeEventListener('touchend',end,true);host.removeEventListener('touchcancel',end,true)};
    dispose.cancel=cancel;return dispose;
  }
  function keyInput(key,{shift=false,ctrl=false}={}){
    const specials={'space':[' ',''],'⏎':['\r','Enter'],'⌫':['\x7f','Backspace'],'←':['\x1b[D','Left'],'→':['\x1b[C','Right'],'↑':['\x1b[A','Up'],'↓':['\x1b[B','Down'],'home':['\x1b[H','Home'],'end':['\x1b[F','End'],'tab':['\t','Tab'],'esc':['\x1b','Escape']};
    if(ctrl&&/^[a-z]$/i.test(key))return{data:String.fromCharCode(key.toLowerCase().charCodeAt(0)-96),keys:['Ctrl+'+key.toLowerCase()],text:''};
    if(specials[key]){const [data,name]=specials[key];return{data,keys:name?[name]:[],text:name?'':data}}
    const symbols={'1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')','-':'_','/':'?',':':';',';':':','(':'[',')':']','$':'~','&':'|','@':'`','"':"'",'.':','};
    if(Array.from(key).length!==1)return null;
    const text=shift?(symbols[key]||key.toUpperCase()):key;return{data:text,text,keys:[]};
  }
  class TerminalApp {
    constructor(root,bridge){
      this.bridge=bridge;this.root=root;this.status=node('span','remote-status','HOST · connecting…');this.host=node('div','remote-terminal');
      this.restart=button('New shell',()=>{if(this.exited){storage.set('omarchy-terminal-id',null);this.exited=false;this.connect()}});this.restart.hidden=true;
      this.latest=button('↓ Latest',()=>{this.stopTouchScroll.cancel();this.term.scrollToBottom()});this.latest.hidden=true;
      const bar=node('div','remote-bar');bar.append(this.status,this.latest,this.restart);root.append(bar,this.host);
      this.term=terminal(this.host);this.stopTouchScroll=touchScroll(this.host,this.term,false);this.term.onScroll(()=>{this.latest.hidden=this.term.buffer.active.viewportY>=this.term.buffer.active.baseY});this.fit=new FitAddon.FitAddon();this.term.loadAddon(this.fit);
      this.term.onData(data=>this.input(data));
      this.term.onResize(({cols,rows})=>{if(this.ws?.readyState===1)this.ws.send(JSON.stringify({type:'resize',cols,rows}))});
      this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(this.host);
      this.host.addEventListener('click',()=>bridge.keyboard());
    }
    resize(){if(!this.host.clientHeight||!this.host.clientWidth)return;try{this.fit.fit()}catch{}}
    async connect(){
      if(this.connecting||this.ws?.readyState===0||this.ws?.readyState===1||this.exited||this.disposed)return;
      clearTimeout(this.retry);this.connecting=true;this.status.textContent='HOST · connecting…';
      try{
        const session=await api('terminal/session',{id:storage.get('omarchy-terminal-id')});storage.set('omarchy-terminal-id',session.id);
        if(this.disposed)return;
        const ws=socket(`terminal/${session.id}/ws`);this.ws=ws;
        ws.onmessage=event=>{const m=JSON.parse(event.data);if(m.type==='screen'){
          this.term.reset();this.term.resize(m.cols,m.rows);this.term.write(new Uint8Array(m.data),()=>{this.resize();if(ws.readyState===1)ws.send(JSON.stringify({type:'resize',cols:this.term.cols,rows:this.term.rows}))});
          this.ready=true;this.status.textContent='HOST · connected';this.restart.hidden=true;if(m.exited)this.exit();
        }else if(m.type==='output')this.term.write(new Uint8Array(m.data));else if(m.type==='exit')this.exit();else if(m.type==='error')this.status.textContent=m.message};
        ws.onclose=()=>{if(this.ws!==ws)return;this.ready=false;if(!this.exited&&!this.disposed){this.status.textContent='HOST disconnected · reconnecting…';this.retry=setTimeout(()=>this.connect(),1500)}};
        ws.onerror=()=>ws.close();
      }catch(e){this.status.textContent='HOST unavailable · retrying…';this.retry=setTimeout(()=>this.connect(),2500)}finally{this.connecting=false}
    }
    resume(){if(this.connecting||this.exited||this.disposed)return;const old=this.ws;this.ws=null;this.ready=false;old?.close();this.connect()}
    exit(){this.exited=true;this.ready=false;this.ws?.close();this.status.textContent='Shell exited';this.restart.hidden=false;}
    input(data){this.stopTouchScroll.cancel();if(this.ready&&this.ws?.readyState===1){this.ws.send(JSON.stringify({type:'input',data}));this.term.scrollToBottom()}else this.status.textContent=this.exited?'Shell exited · start a new shell':'Disconnected · input was not sent';}
    dispose(){this.disposed=true;clearTimeout(this.retry);this.ws?.close();this.resizeObserver.disconnect();this.stopTouchScroll();this.term.dispose()}
  }
  class HerdrApp {
    constructor(root,bridge){
      this.root=root;this.bridge=bridge;this.snapshot=null;this.selected=storage.get('omarchy-herdr-pane');this.pending=new Set();
      this.status=node('div','remote-status','Herdr · connecting…');this.list=node('div','herdr-list');this.detail=node('div','herdr-detail');this.detail.hidden=true;
      const bar=node('div','remote-bar');bar.append(node('strong','', 'herdr'),this.status);root.append(bar,this.list,this.detail);
      this.detailBar=node('div','herdr-detail-bar');this.title=node('div','herdr-pane-title');
      this.detailBar.append(button('‹ All panes',()=>this.select(null)),this.title);
      this.output=node('div','herdr-output');this.canvas=node('div','herdr-canvas');this.output.append(this.canvas);
      this.followOutput=true;this.latest=button('↓ Latest',()=>this.showLatest());this.latest.hidden=true;
      this.inputStatus=node('span','remote-status','Tap to type into this pane');
      const inputBar=node('div','herdr-input-bar');inputBar.append(button('⌨ Keyboard',()=>{this.showLatest();bridge.keyboard()}),this.latest,this.inputStatus);
      this.detail.append(this.detailBar,this.output,inputBar);this.term=terminal(this.canvas,true);this.fit=new FitAddon.FitAddon();this.term.loadAddon(this.fit);
      this.stopTouchScroll=touchScroll(this.output,this.term,true,()=>this.trackScroll());
      this.term.onScroll(()=>{if(!this.rendering)this.trackScroll()});
      this.output.onclick=()=>{this.showLatest();bridge.keyboard()};
      this.resizeObserver=new ResizeObserver(()=>{if(this.lastRead)this.renderOutput(this.lastRead,true)});this.resizeObserver.observe(this.output);
    }
    connect(){
      if(this.disposed||this.ws?.readyState===0||this.ws?.readyState===1)return;clearTimeout(this.retry);
      const ws=socket('herdr/ws');this.ws=ws;this.status.textContent='connecting…';
      ws.onopen=()=>{if(this.selected)this.send({type:'select',pane_id:this.selected})};
      ws.onmessage=event=>{const m=JSON.parse(event.data);
        if(m.type==='snapshot'){this.online=true;this.snapshot=m.snapshot;this.status.textContent=`HOST · ${m.snapshot.panes.length} panes`;this.renderList();if(this.selected){const pane=this.snapshot.panes.find(p=>p.pane_id===this.selected);if(pane)this.showDetail(pane);else this.select(null)}}
        else if(m.type==='pane'&&m.pane_id===this.selected){this.online=true;this.renderOutput(m.read);}
        else if(m.type==='ack'){this.pending.delete(m.id);this.inputStatus.textContent=this.pending.size?'Sending…':'Input sent'}
        else if(m.type==='input_error'){this.pending.delete(m.id);this.inputStatus.textContent=m.message||'Input failed'}
        else if(m.type==='pane_error'){this.inputStatus.textContent='Pane unavailable · return to all panes';this.online=false}
        else if(m.type==='error'){this.online=false;this.status.textContent='Herdr unavailable · retrying…'}
      };
      ws.onclose=()=>{if(this.ws!==ws)return;this.online=false;if(this.pending.size)this.inputStatus.textContent='Connection lost · last input may not have arrived';this.pending.clear();if(!this.disposed){this.status.textContent='disconnected · reconnecting…';this.retry=setTimeout(()=>this.connect(),1500)}};
      ws.onerror=()=>ws.close();
    }
    resume(){if(this.disposed)return;const old=this.ws;this.ws=null;this.online=false;old?.close();if(this.pending.size)this.inputStatus.textContent='Connection interrupted · last input may not have arrived';this.pending.clear();this.connect()}
    send(message){if(this.ws?.readyState!==1)return false;this.ws.send(JSON.stringify(message));return true}
    renderList(){
      const signature=JSON.stringify([this.snapshot.workspaces.map(w=>[w.workspace_id,w.label]),this.snapshot.panes.map(p=>[p.pane_id,p.workspace_id,p.tab_id,p.agent,p.agent_status,p.terminal_title_stripped,p.foreground_cwd,p.cwd]),this.snapshot.tabs.map(t=>[t.tab_id,t.label])]);
      if(signature===this.listSignature)return;this.listSignature=signature;
      const scroll=this.list.scrollTop;this.list.replaceChildren();
      if(!this.snapshot.panes.length){this.list.append(node('p','remote-empty','No panes are open in local Herdr.'));return}
      for(const workspace of this.snapshot.workspaces){
        const panes=this.snapshot.panes.filter(p=>p.workspace_id===workspace.workspace_id);if(!panes.length)continue;
        const group=node('section','herdr-group');const heading=node('div','herdr-group-title');heading.append(node('strong','',workspace.label||workspace.workspace_id),node('span','remote-status',`${panes.length} panes`));group.append(heading);
        for(const pane of panes){const tab=this.snapshot.tabs.find(t=>t.tab_id===pane.tab_id);const row=button('',()=>this.select(pane.pane_id));row.className='herdr-pane';
          const icon=node('span','herdr-agent-icon',pane.agent||'sh');const info=node('span','herdr-pane-info');info.append(node('strong','',pane.terminal_title_stripped||tab?.label||pane.pane_id),node('span','remote-status',`${tab?.label||'terminal'} · ${pane.foreground_cwd||pane.cwd||''}`));
          const status=node('span','herdr-state',pane.agent_status||'unknown');status.dataset.state=pane.agent_status||'unknown';row.append(icon,info,status);group.append(row)}
        this.list.append(group);
      }
      this.list.scrollTop=scroll;
    }
    showDetail(pane){this.list.hidden=true;this.detail.hidden=false;this.title.textContent=`${pane.agent||'shell'} · ${pane.terminal_title_stripped||pane.pane_id}`;}
    select(id){
      this.stopTouchScroll.cancel();
      this.selected=id;storage.set('omarchy-herdr-pane',id);this.lastRead=null;this.queuedRead=null;this.followOutput=true;this.output.scrollLeft=0;this.term.reset();this.inputStatus.textContent='Tap to type into this pane';
      this.send({type:'select',pane_id:id});
      if(id){const pane=this.snapshot?.panes.find(p=>p.pane_id===id);if(pane)this.showDetail(pane)}else{this.detail.hidden=true;this.list.hidden=false;this.bridge.logic.set({kb:false})}
    }
    move(delta){const panes=this.snapshot?.panes||[];const i=panes.findIndex(p=>p.pane_id===this.selected);if(i>=0&&panes[i+delta])this.select(panes[i+delta].pane_id)}
    trackScroll(){this.followOutput=this.term.buffer.active.viewportY>=this.term.buffer.active.baseY;this.latest.hidden=this.followOutput;}
    showLatest(){this.stopTouchScroll.cancel();this.followOutput=true;this.term.scrollToBottom();this.output.scrollLeft=0;this.latest.hidden=true;}
    renderOutput(read,force=false){
      if(read.pane_id!==this.selected)return;
      if(!this.output.clientHeight)return;const text=read.text||'';if(!force&&text===this.lastRead?.text)return;
      if(this.rendering){this.queuedRead={read,force};return}
      const previous=this.lastRead;this.lastRead=read;
      const plain=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'');
      const cols=Math.max(40,Math.min(300,Math.max(...plain.split(/\r?\n/).map(l=>Array.from(l).length))));
      const screen=this.term.element.querySelector('.xterm-screen');
      const cellWidth=parseFloat(screen.style.width)/this.term.cols;
      this.canvas.style.width=`${Math.max(this.output.clientWidth,cols*cellWidth+16)}px`;
      // Use xterm's measured font metrics, not an assumed pixel height per row.
      const dimensions=this.fit.proposeDimensions();if(!dimensions)return;
      const scroll=this.term.buffer.active.viewportY;
      const anchor=this.term.buffer.active.getLine(scroll)?.translateToString(true);
      const pane=this.selected;this.rendering=true;
      this.term.resize(Math.max(cols,dimensions.cols),Math.max(4,dimensions.rows));this.term.reset();
      this.term.write(text.replace(/\r?\n/g,'\r\n'),()=>{
        if(this.selected===pane){
          if(this.followOutput||!previous)this.term.scrollToBottom();
          else{
            let target=scroll,distance=Infinity;
            for(let i=0;i<this.term.buffer.active.length;i++)if(this.term.buffer.active.getLine(i)?.translateToString(true)===anchor&&Math.abs(i-scroll)<distance){target=i;distance=Math.abs(i-scroll)}
            this.term.scrollToLine(target);
          }
        }
        this.rendering=false;
        const queued=this.queuedRead;this.queuedRead=null;if(queued)this.renderOutput(queued.read,queued.force);
      });
    }
    input(input){
      if(!this.selected){this.status.textContent='Select a pane to type';return}
      if(!this.online||this.ws?.readyState!==1){this.inputStatus.textContent='Disconnected · input was not sent';return}
      this.showLatest();
      const id=crypto.randomUUID();this.pending.add(id);this.inputStatus.textContent='Sending…';
      this.send({type:'input',id,pane_id:this.selected,text:input.text,keys:input.keys});
    }
    dispose(){this.disposed=true;clearTimeout(this.retry);this.ws?.close();this.resizeObserver.disconnect();this.stopTouchScroll();this.term.dispose()}
  }
  class HostBridge {
    constructor(logic){
      this.logic=logic;this.terminal=null;this.herdr=null;
      this.foreground=()=>{if(!document.hidden){this.terminal?.resume();this.herdr?.resume()}};
      document.addEventListener('visibilitychange',this.foreground);window.addEventListener('online',this.foreground);this.update();
    }
    keyboard(){if(!this.logic.state.ov)this.logic.set({kb:true,sup:false})}
    update(){
      const current=this.logic.cur(),kb=this.logic.state.kb;
      for(const id of ['remote-terminal-app','remote-herdr-app']){const root=mount(id);if(root)root.classList.toggle('with-keyboard',kb&&!this.logic.state.ov)}
      if(location.protocol==='file:'){for(const id of ['remote-terminal-app','remote-herdr-app']){const root=mount(id);if(root&&!root.textContent)root.append(node('p','remote-empty','Connect to HOST to use this app.'))}return}
      if(current==='terminal'&&!this.terminal){this.terminal=new TerminalApp(mount('remote-terminal-app'),this);this.terminal.connect()}
      if(current==='herd'&&!this.herdr){this.herdr=new HerdrApp(mount('remote-herdr-app'),this);this.herdr.connect()}
      if(current!=='terminal'||this.logic.state.ov)this.terminal?.stopTouchScroll.cancel();
      if(current!=='herd'||this.logic.state.ov)this.herdr?.stopTouchScroll.cancel();
      this.terminal?.resize();
    }
    key(key,mods){const input=keyInput(key,mods);if(!input)return;if(this.logic.cur()==='terminal')this.terminal?.input(input.data);else if(this.logic.cur()==='herd')this.herdr?.input(input)}
    dispose(){this.terminal?.dispose();this.herdr?.dispose();document.removeEventListener('visibilitychange',this.foreground);window.removeEventListener('online',this.foreground)}
  }
  window.HyprlandRemote={attach:logic=>new HostBridge(logic),keyInput};
})();
