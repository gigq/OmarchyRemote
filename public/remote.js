/* Shared host client. App adapters own their views; the shell owns gestures/keyboard. */
(() => {
  const theme={background:'#15131f',foreground:'#e0def4',cursor:'#ebbcba',selectionBackground:'#403d52',black:'#26233a',red:'#eb6f92',green:'#9ccfd8',yellow:'#f6c177',blue:'#31748f',magenta:'#c4a7e7',cyan:'#9ccfd8',white:'#e0def4',brightBlack:'#6e6a86'};
  const {node,button,mount,storage}=window.HyprlandUtil;
  const api=async(path,body)=>{
    const response=await fetch('/api/'+path,{method:body===undefined?'GET':'POST',headers:{'X-Hyprland-Client':'1',...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
    const value=await response.json();if(!response.ok)throw Error(value.error||'Host unavailable');return value;
  };
  const socket=path=>new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/${path}`);
  function terminal(host,readonly=false){
    const t=new Terminal({fontFamily:'"JetBrains Mono", monospace',fontSize:window.HyprlandDesk?.isDesk()?13:12,lineHeight:1.15,theme:window.HyprlandThemes?.terminalTheme()||theme,scrollback:3000,cursorBlink:!readonly,disableStdin:readonly,allowProposedApi:false});
    t.open(host);t.textarea?.setAttribute('inputmode','none');t.textarea?.setAttribute('autocapitalize','off');
    return t;
  }
  function touchScroll(host,term,horizontal,onScroll=()=>{},onIdle=()=>{}){
    const view=new NativeTerminalView(host,term,onScroll,onIdle);
    term.nativeView=view;
    const dispose=()=>view.dispose();dispose.cancel=()=>view.cancel();dispose.active=()=>view.active();return dispose;
  }
  function keyInput(key,{shift=false,ctrl=false}={}){
    const specials={'space':[' ',''],'⏎':['\r','Enter'],'⌫':['\x7f','Backspace'],'←':['\x1b[D','Left'],'→':['\x1b[C','Right'],'↑':['\x1b[A','Up'],'↓':['\x1b[B','Down'],'home':['\x1b[H','Home'],'end':['\x1b[F','End'],'tab':['\t','Tab'],'esc':['\x1b','Escape']};
    if(ctrl&&/^[a-z]$/i.test(key))return{data:String.fromCharCode(key.toLowerCase().charCodeAt(0)-96),keys:['Ctrl+'+key.toLowerCase()],text:''};
    if(specials[key]){const [data,name]=specials[key];return{data,keys:name?[name]:[],text:name?'':data}}
    const symbols={'1':'!','2':'@','3':'#','4':'$','5':'%','6':'^','7':'&','8':'*','9':'(','0':')','-':'_','/':'?',':':';',';':':','(':'[',')':']','$':'~','&':'|','@':'`','"':"'",'.':','};
    if(Array.from(key).length!==1)return null;
    const text=shift?(symbols[key]||key.toUpperCase()):key;return{data:text,text,keys:[]};
  }
  // Match Herdr Mobile's attention/working/done/ready groups. Activity sequences
  // come from agent.list; per-pane revision numbers must never rank different panes.
  function orderHerdr(snapshot){
    const rank=p=>{const s=String(p.agent_status||'').toLowerCase();if(s.includes('blocked'))return p.attention_kind==='chat'?3:0;if(/working|running|progress|busy/.test(s))return 1;if(/done|complete|finish|success|unread/.test(s))return 2;if(s==='idle'||s==='ready')return 3;return 4};
    const activity=p=>Number(p.state_change_seq)||0;
    const groupRank=panes=>Math.min(...panes.map(rank));
    const recent=panes=>Math.max(0,...panes.map(activity));
    const compareGroups=(a,b)=>groupRank(a.panes)-groupRank(b.panes)||recent(b.panes)-recent(a.panes);
    const tabs=new Map(snapshot.tabs.map((t,i)=>[t.tab_id,{...t,order:i}]));
    const label=p=>tabs.get(p.tab_id)?.label||p.terminal_title_stripped||p.agent||p.pane_id;
    const groups=snapshot.workspaces.map(workspace=>{
      const panes=snapshot.panes.filter(p=>p.workspace_id===workspace.workspace_id);
      const grouped=new Map();for(const pane of panes){const id=pane.tab_id||pane.pane_id;if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push(pane)}
      const ordered=[...grouped].map(([id,panes])=>({id,panes})).sort((a,b)=>compareGroups(a,b)
        ||(tabs.get(a.id)?.order??Infinity)-(tabs.get(b.id)?.order??Infinity)
        ||String(a.id).localeCompare(String(b.id),undefined,{numeric:true}));
      return {...workspace,panes:ordered.flatMap(t=>[...t.panes].sort((a,b)=>activity(b)-activity(a)||label(a).localeCompare(label(b))||a.pane_id.localeCompare(b.pane_id,undefined,{numeric:true})))};
    }).filter(g=>g.panes.length);
    return groups.sort((a,b)=>compareGroups(a,b)||String(a.label||a.workspace_id).localeCompare(String(b.label||b.workspace_id),undefined,{sensitivity:'base'})||a.workspace_id.localeCompare(b.workspace_id));
  }
  // btop's RGB output is presented using the phone's semantic palette.
  const monitorColors=new Map();
  function monitorColor(value,background){
    if(value==='transparent')return value;
    const key=background+':'+value;if(monitorColors.has(key))return monitorColors.get(key);
    const channels=value.startsWith('#')?[1,3,5].map(i=>parseInt(value.slice(i,i+2),16)):(value.match(/\d+/g)||[]).map(Number);
    if(channels.length!==3)return value;
    const [r,g,b]=channels,max=Math.max(...channels),min=Math.min(...channels),delta=max-min;
    let result;
    if(background)result=max<24?'transparent':'var(--theme-surface-raised)';
    else if(delta<24)result=max>180?'var(--theme-foreground)':max>65?'var(--theme-secondary)':'var(--theme-border)';
    else{
      let hue=max===r?((g-b)/delta)%6:max===g?(b-r)/delta+2:(r-g)/delta+4;hue=(hue*60+360)%360;
      const tone=hue<35||hue>=335?'red':hue<80?'yellow':hue<165?'green':hue<205?'cyan':hue<270?'blue':'magenta';
      const strength=Math.round(55+45*max/255);
      result=`color-mix(in srgb, var(--theme-${tone}) ${strength}%, var(--theme-terminal))`;
    }
    monitorColors.set(key,result);return result;
  }
  const HOST_TUIS={
    terminal:{},
    btop:{cols:80,keys:[['CPU','1'],['Memory','2'],['Network','3'],['Processes','4'],['Menu','\x1b']]},
    services:{cols:64,keys:[['↑','\x1b[A'],['↓','\x1b[B'],['Select','\r'],['Back','\x1b'],['Filter','f'],['Help','?']],search:'\x06'},
    lazydocker:{cols:64,keys:[['↑','\x1b[A'],['↓','\x1b[B'],['Panel','\t'],['Open','\r'],['Back','\x1b'],['Tab','\x5d'],['Menu','x']],search:'/'},
    dua:{cols:64,keys:[['↑','\x1b[A'],['↓','\x1b[B'],['Open','\r'],['Up folder','\x1b[D'],['Panel','\t'],['Help','?']]},
    lnav:{cols:64,keys:[['↑','\x1b[A'],['↓','\x1b[B'],['Page ↑','\x1b[5~'],['Page ↓','\x1b[6~'],['Latest','G'],['Wrap','\x17'],['Help','?']],search:'/'},
  };
  class TerminalApp {
    constructor(root,bridge,app='terminal',storageKey=null){
      this.app=app;this.storageKey=storageKey||'omarchy-'+app+'-id';this.bridge=bridge;this.root=root;this.status=node('span','remote-status');this.setStatus('connecting…');this.host=node('div','remote-terminal');
      this.restart=button(app==='terminal'?'New shell':`Restart ${app}`,()=>{if(this.exited){storage.set(this.storageKey,null);this.exited=false;this.connect()}});this.restart.hidden=true;
      this.latest=button('↓ Latest',()=>{this.stopTouchScroll.cancel();this.term.scrollToBottom()});this.latest.hidden=true;
      const bar=node('div','remote-bar');bar.append(this.status,this.latest,this.restart);root.append(bar,this.host);
      if(app!=='terminal'){
        this.tuiFit=true;this.tuiTools=node('div','host-tui-tools');
        for(const [label,key] of HOST_TUIS[app].keys)this.tuiTools.append(button(label,()=>this.input(key)));
        if(HOST_TUIS[app].search)this.tuiTools.append(button('Search',()=>{this.input(HOST_TUIS[app].search);bridge.keyboard()}));
        this.sizeButton=button('Larger',()=>{this.tuiFit=!this.tuiFit;this.sizeButton.textContent=this.tuiFit?'Larger':'Fit';this.resize()});this.tuiTools.append(this.sizeButton);root.insertBefore(this.tuiTools,this.host);
      }
      this.term=terminal(this.host);this.stopTouchScroll=touchScroll(this.host,this.term,false);if(app!=='terminal'){this.term.nativeView.colorTransform=monitorColor;this.term.nativeView.themeBoxBorders=true;}this.term.onScroll(()=>{this.latest.hidden=this.term.buffer.active.viewportY>=this.term.buffer.active.baseY});this.fit=new FitAddon.FitAddon();this.term.loadAddon(this.fit);
      // The host answers DSR, including before a client attaches.
      this.term.parser.registerCsiHandler({final:'n'},params=>params.length===1&&params[0]===6);
      this.term.onData(data=>this.input(data));
      this.term.onResize(({cols,rows})=>{if(!this.restoring&&this.ws?.readyState===1)this.ws.send(JSON.stringify({type:'resize',cols,rows}))});
      this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(this.host);
      this.host.addEventListener('click',()=>bridge.keyboard());
      this.nativeInput=bridge.createInput(root,false,(text,enter)=>this.input(text+(enter?'\r':'')));
    }
    resize(){if(this.restoring)return;if(!this.host.clientHeight||!this.host.clientWidth)return;try{if(this.app!=='terminal'){const minCols=HOST_TUIS[this.app].cols;const font=this.tuiFit?Math.min(12,(this.host.clientWidth-4)/(minCols*.60375)):12;this.term.options.fontSize=font;this.host.style.setProperty('--host-tui-font',font+'px');const d=this.fit.proposeDimensions();if(d)this.term.resize(Math.max(minCols,d.cols),Math.max(24,d.rows))}else this.fit.fit()}catch{}}
    async connect(){
      if(this.connecting||this.ws?.readyState===0||this.ws?.readyState===1||this.exited||this.disposed)return;
      clearTimeout(this.retry);this.connecting=true;this.setStatus('connecting…');
      try{
        this.sessionRequest=api('terminal/session',{id:storage.get(this.storageKey),app:this.app,cwd:this.app==='terminal'?storage.get('omarchy-terminal-cwd'):null});const session=await this.sessionRequest;storage.set(this.storageKey,session.id);
        if(this.disposed)return;
        const ws=socket(`terminal/${session.id}/ws`);this.ws=ws;
        ws.onmessage=event=>{if(this.ws!==ws||this.disposed)return;const m=JSON.parse(event.data);if(m.type==='screen'){
          this.restoring=true;this.term.reset();this.term.resize(m.cols,m.rows);this.term.write(new Uint8Array(m.data),()=>{this.restoring=false;this.resize();if(ws.readyState===1){ws.send(JSON.stringify({type:'resize',cols:this.term.cols,rows:this.term.rows}));ws.send(JSON.stringify({type:'ready'}))}});
          this.ready=true;this.setStatus('connected');this.restart.hidden=true;if(m.exited)this.exit();
        }else if(m.type==='output')this.term.write(new Uint8Array(m.data));else if(m.type==='exit')this.exit();else if(m.type==='error')this.status.textContent=m.message};
        ws.onclose=()=>{if(this.ws!==ws)return;this.ready=false;if(!this.exited&&!this.disposed){this.setStatus('disconnected · reconnecting…');this.retry=setTimeout(()=>this.connect(),1500)}};
        ws.onerror=()=>ws.close();
      }catch(e){this.setStatus('unavailable · retrying…');this.retry=setTimeout(()=>this.connect(),2500)}finally{this.connecting=false}
    }
    resume(){if(this.connecting||this.exited||this.disposed)return;const old=this.ws;this.ws=null;this.ready=false;old?.close();this.connect()}
    exit(){if(this.exited)return;this.exited=true;this.ready=false;this.ws?.close();if(this.app==='terminal'){this.onExit?.();return}this.status.textContent=`${this.app} exited`;this.restart.hidden=false;}
    key(input){return this.input(input.data)}
    setStatus(text){this.status.hidden=text==='connected';this.statusText=text;this.status.textContent=`${HyprlandApps.host.name} · ${text}`}
    hostChanged(){this.setStatus(this.statusText)}
    input(data){this.stopTouchScroll.cancel();if(this.ready&&this.ws?.readyState===1){this.ws.send(JSON.stringify({type:'input',data}));this.term.scrollToBottom();return true}else this.status.textContent=this.exited?'App exited · use Restart':'Disconnected · input was not sent';return false;}
    dispose(){this.disposed=true;clearTimeout(this.retry);this.ws?.close();this.resizeObserver.disconnect();this.stopTouchScroll();this.nativeInput.dispose();this.term.dispose()}
  }
  class TerminalTabs {
    constructor(root,bridge){
      this.root=root;this.bridge=bridge;this.tabs=[];this.bar=node('div','terminal-tabs');this.body=node('div','terminal-tab-body');root.append(this.bar,this.body);
      let saved;try{saved=JSON.parse(storage.get('omarchy-terminal-tabs'))}catch{}
      const keys=Array.isArray(saved)?[...new Set(saved.filter(k=>/^omarchy-terminal-(id|tab-[a-z0-9-]+)$/.test(k)))].slice(0,8):[];
      for(const key of keys.length?keys:['omarchy-terminal-id'])this.add(key,false);
      this.activate(Math.max(0,this.tabs.findIndex(t=>t.storageKey===storage.get('omarchy-terminal-active'))));
      this.stopTouchScroll={cancel:()=>this.active.stopTouchScroll.cancel()};
    }
    get active(){return this.tabs[this.index]}
    get nativeInput(){return this.active.nativeInput}
    get sessionRequest(){return this.active.sessionRequest}
    get exited(){return this.active.exited}
    add(key='omarchy-terminal-tab-'+crypto.randomUUID(),activate=true){if(this.tabs.length>=8)return;const root=node('div','terminal-tab');this.body.append(root);const tab=new TerminalApp(root,this.bridge,'terminal',key);tab.onExit=()=>this.shellExited(tab);this.tabs.push(tab);if(activate)this.activate(this.tabs.length-1);this.save()}
    shellExited(tab){
      if(this.disposed||this.closingTab===tab||!this.tabs.includes(tab))return;
      if(this.tabs.length===1){this.bridge.logic.closeApp('terminal');return}
      const sessionId=storage.get(tab.storageKey);if(sessionId)api('terminal/'+encodeURIComponent(sessionId)+'/close',{}).catch(()=>{});
      const active=this.active,index=this.tabs.indexOf(tab);tab.dispose();tab.root.remove();storage.set(tab.storageKey,null);this.tabs.splice(index,1);this.save();
      this.activate(active===tab?Math.min(index,this.tabs.length-1):this.tabs.indexOf(active));
    }
    save(){storage.set('omarchy-terminal-tabs',JSON.stringify(this.tabs.map(t=>t.storageKey)))}
    activate(index){this.confirmation?.remove();this.confirmation=null;this.index=index;this.tabs.forEach((t,i)=>{t.root.hidden=i!==index;t.nativeInput.show(false)});storage.set('omarchy-terminal-active',this.active.storageKey);this.render();this.active.connect();this.active.resize();if(this.bridge.apps.terminal===this)this.bridge.update()}
    render(){this.addButton?.remove();this.bar.hidden=this.tabs.length===1;this.bar.replaceChildren();this.tabs.forEach((tab,i)=>{const b=button((i+1)+' shell',()=>this.activate(i));b.setAttribute('aria-pressed',String(i===this.index));this.bar.append(b)});const add=button('+',()=>this.add());add.setAttribute('aria-label','New terminal tab');add.disabled=this.tabs.length>=8;const close=button('×',()=>this.confirmClose());close.setAttribute('aria-label','Close terminal tab');close.disabled=this.tabs.length===1;this.addButton=add;if(this.tabs.length===1)this.active.root.querySelector('.remote-bar').append(add);else this.bar.append(add,close)}
    confirmClose(){if(this.confirmation||this.tabs.length===1)return;const tab=this.active;const row=this.confirmation=node('div','terminal-close-confirm');row.setAttribute('role','group');row.setAttribute('aria-label','Confirm close shell');row.append(node('span','','Close shell and its running process?'),button('Cancel',()=>{row.remove();this.confirmation=null}),button('Close shell',()=>this.closeCurrent(tab)));this.root.insertBefore(row,this.body)}
    async closeCurrent(tab){if(this.closing||this.tabs.length===1||!this.tabs.includes(tab))return;this.closing=true;this.closingTab=tab;this.confirmation?.querySelectorAll('button').forEach(b=>b.disabled=true);try{const session=tab.sessionRequest?await tab.sessionRequest:null;const id=session?.id||storage.get(tab.storageKey);if(id)await api('terminal/'+encodeURIComponent(id)+'/close',{});tab.dispose();tab.root.remove();storage.set(tab.storageKey,null);this.tabs.splice(this.tabs.indexOf(tab),1);this.save();this.activate(Math.min(this.index,this.tabs.length-1))}catch(e){tab.status.textContent=e.message}finally{this.closing=false;this.closingTab=null;this.confirmation?.remove();this.confirmation=null}}
    async closeSessions(){for(const tab of this.tabs){const session=tab.sessionRequest?await tab.sessionRequest:null;const id=session?.id||storage.get(tab.storageKey);if(id)await api('terminal/'+encodeURIComponent(id)+'/close',{});storage.set(tab.storageKey,null)}storage.set('omarchy-terminal-tabs',null);storage.set('omarchy-terminal-active',null)}
    connect(){this.active.connect()}
    resize(){this.active.resize()}
    resume(){for(const t of this.tabs)if(t.sessionRequest)t.resume()}
    input(data){return this.active.input(data)}
    key(input){return this.active.key(input)}
    dispose(){this.disposed=true;this.tabs.forEach(t=>t.dispose())}
  }
  const paneGroup=p=>/blocked/.test(p.agent_status)&&p.attention_kind!=='chat'?'attention':/working|running|progress|busy/.test(p.agent_status)?'running':/idle|ready|blocked/.test(p.agent_status)?'idle':'done';
  class HerdrApp {
    constructor(root,bridge){
      this.root=root;this.bridge=bridge;this.snapshot=null;this.selected=storage.get('omarchy-herdr-pane');this.recentPanes=storage.read('omarchy-herdr-recent-panes',[]);if(!Array.isArray(this.recentPanes))this.recentPanes=[];this.pending=new Set();
      this.status=node('div','remote-status','Herdr · connecting…');this.list=node('div','herdr-list');this.detail=node('div','herdr-detail');this.detail.hidden=true;
      const bar=node('div','remote-bar');bar.classList.add('herdr-connection');bar.append(this.status);this.filters=node('div','herdr-filters');this.search=node('input','herdr-search');this.search.type='search';this.search.placeholder='jump to pane…';this.search.setAttribute('aria-label','Search panes');this.search.oninput=()=>{this.listSignature=null;this.renderList()};this.filter='all';root.append(bar,this.filters,this.search,this.list,this.detail);
      this.detailBar=node('div','herdr-detail-bar');this.title=node('div','herdr-pane-title');
      this.fitOutput=storage.get('omarchy-herdr-fit')!=='false';
      this.fitButton=button('',()=>{this.stopTouchScroll.cancel();this.fitOutput=!this.fitOutput;storage.set('omarchy-herdr-fit',String(this.fitOutput));this.applyFit()});
      this.filePicker=node('input');this.filePicker.type='file';this.filePicker.accept='image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif';this.filePicker.multiple=true;this.filePicker.hidden=true;
      this.attachButton=button('',()=>{this.pickerPane=this.selected;this.nativeInput.field.blur();this.filePicker.click()});this.attachButton.classList.add('herdr-attach');this.attachButton.setAttribute('aria-label','Attach images');this.attachButton.title='Attach images';
      this.attachButton.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9m-6 12 9-9"/></svg>';
      this.filePicker.onchange=()=>{const files=[...this.filePicker.files];this.filePicker.value='';this.uploadImages(files,this.pickerPane)};
      this.uploadAbort=new AbortController();
      this.backButton=button('‹',()=>this.select(null));this.backButton.setAttribute('aria-label','All panes');this.backButton.classList.add('herdr-back');
      this.paneTabs=node('div','herdr-pane-tabs');const center=node('div','herdr-detail-center');center.append(this.title,this.paneTabs);
      this.detailBar.append(this.backButton,center,this.fitButton,this.attachButton,this.filePicker);
      this.output=node('div','herdr-output');this.canvas=node('div','herdr-canvas');this.output.append(this.canvas);
      this.followOutput=true;this.latest=button('↓ Latest',()=>{this.showLatest();if(!this.nativeInput.element.hidden)this.nativeInput.focus()});this.latest.hidden=true;this.latest.classList.add('herdr-latest');this.latest.onpointerdown=e=>e.preventDefault();this.output.append(this.latest);
      this.inputStatus=node('span','remote-status','');this.inputStatus.setAttribute('role','status');
      const inputBar=node('div','herdr-input-bar');inputBar.append(this.inputStatus);
      this.metadata=node('div','herdr-metadata');this.detail.append(this.detailBar,this.metadata,this.output,inputBar);this.term=terminal(this.canvas,true);this.fit=new FitAddon.FitAddon();this.term.loadAddon(this.fit);
      this.stopTouchScroll=touchScroll(this.output,this.term,true,()=>this.trackScroll(),()=>this.flushRead());this.applyFit();
      this.term.onScroll(()=>{if(!this.rendering)this.trackScroll()});
      this.output.onclick=()=>{this.showLatest();bridge.keyboard()};
      this.nativeInput=bridge.createInput(root,true,(text,enter)=>this.input({text,keys:enter?['Enter']:[]}),{dismissOnSend:true,compactControls:true,draftStore:'omarchy-herdr-drafts-v1'});this.nativeInput.select(this.selected);
      this.nativeInput.field.addEventListener('paste',e=>{const files=[...(e.clipboardData?.items||[])].filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();this.uploadImages(files,this.selected)}});
      this.resizeObserver=new ResizeObserver(()=>{if(this.lastRead)this.renderOutput(this.lastRead,true)});this.resizeObserver.observe(this.output);
    }
    connect(){
      if(this.disposed||this.ws?.readyState===0||this.ws?.readyState===1)return;clearTimeout(this.retry);
      const ws=socket('herdr/ws');this.ws=ws;this.setStatus('connecting…');
      ws.onopen=()=>{if(this.selected)this.send({type:'select',pane_id:this.selected})};
      ws.onmessage=event=>{const m=JSON.parse(event.data);
        if(m.type==='snapshot'){this.online=true;this.snapshot=m.snapshot;this.setStatus(`${m.snapshot.panes.length} panes`);this.renderList();if(this.selected){const pane=this.snapshot.panes.find(p=>p.pane_id===this.selected);if(pane)this.showDetail(pane);else this.select(null)}}
        else if(m.type==='pane'&&m.pane_id===this.selected){this.online=true;this.renderOutput(m.read);}
        else if(m.type==='ack'){this.pending.delete(m.id);this.inputStatus.textContent=''}
        else if(m.type==='input_error'){this.pending.delete(m.id);this.inputStatus.textContent=m.message||'Input failed'}
        else if(m.type==='pane_error'){this.inputStatus.textContent='Pane unavailable · return to all panes';this.online=false}
        else if(m.type==='error'){this.online=false;this.setStatus('unavailable · retrying…')}
      };
      ws.onclose=()=>{if(this.ws!==ws)return;this.online=false;if(this.pending.size)this.inputStatus.textContent='Connection lost · last input may not have arrived';this.pending.clear();if(!this.disposed){this.setStatus('disconnected · reconnecting…');this.retry=setTimeout(()=>this.connect(),1500)}};
      ws.onerror=()=>ws.close();
    }
    resume(){if(this.disposed)return;const old=this.ws;this.ws=null;this.online=false;old?.close();if(this.pending.size)this.inputStatus.textContent='Connection interrupted · last input may not have arrived';this.pending.clear();this.connect()}
    send(message){if(this.ws?.readyState!==1)return false;this.ws.send(JSON.stringify(message));return true}
    renderList(){
      const signature=JSON.stringify([this.filter,this.search.value,this.snapshot.workspaces.map(w=>[w.workspace_id,w.label]),this.snapshot.panes.map(p=>[p.pane_id,p.workspace_id,p.tab_id,p.agent,p.agent_status,p.state_change_seq,p.attention_kind,p.terminal_title_stripped,p.foreground_cwd,p.cwd]),this.snapshot.tabs.map(t=>[t.tab_id,t.label])]);
      if(signature===this.listSignature)return;this.listSignature=signature;
      const scroll=this.list.scrollTop;this.list.replaceChildren();this.filters.replaceChildren();for(const [key,label] of [['attention','needs you'],['running','running'],['idle','idle'],['all','all']]){const count=this.snapshot.panes.filter(p=>key==='all'||paneGroup(p)===key).length;const b=button(key==='all'?'all':label+' · '+count,()=>{this.filter=key;this.renderList()});b.setAttribute('aria-pressed',String(this.filter===key));this.filters.append(b)}
      if(!this.snapshot.panes.length){this.list.append(node('p','remote-empty','No panes are open in local Herdr.'));return}
      for(const workspace of orderHerdr(this.snapshot)){
        const panes=workspace.panes.filter(p=>(this.filter==='all'||paneGroup(p)===this.filter)&&[p.terminal_title_stripped,p.agent,p.cwd,p.foreground_cwd,workspace.label,this.snapshot.tabs.find(t=>t.tab_id===p.tab_id)?.label].join(' ').toLowerCase().includes(this.search.value.toLowerCase()));if(!panes.length)continue;
        const group=node('section','herdr-group');const heading=node('div','herdr-group-title');heading.append(node('strong','',workspace.label||workspace.workspace_id),node('span','remote-status',`${panes.length} panes`));group.append(heading);
        for(const pane of panes){const row=button('',()=>this.select(pane.pane_id));row.className='herdr-pane';
          const icon=node('span','herdr-agent-icon','●');icon.dataset.group=paneGroup(pane);const info=node('span','herdr-pane-info');const label=node('span','herdr-name-line');label.append(node('strong','',this.paneLabel(pane)),node('span','herdr-provider',pane.agent||'shell'));info.append(label,node('span','remote-status',HyprlandApps.tilde(pane.foreground_cwd||pane.cwd)));
          const status=node('span','herdr-state',pane.agent_status||'unknown');status.dataset.state=pane.agent_status||'unknown';row.append(icon,info,status);group.append(row)}
        this.list.append(group);
      }
      if(!this.list.children.length)this.list.append(node('p','remote-empty','No matching panes.'));this.list.scrollTop=scroll;
    }
    paneLabel(pane){return this.snapshot?.tabs.find(t=>t.tab_id===pane.tab_id)?.label?.trim()||pane.terminal_title_stripped||pane.pane_id}
    showDetail(pane){this.filters.hidden=true;this.search.hidden=true;this.list.hidden=true;this.detail.hidden=false;this.title.textContent=this.paneLabel(pane);const signature=JSON.stringify([pane.pane_id,pane.agent_status,pane.cwd,this.recentPanes,this.snapshot?.workspaces,this.snapshot?.panes.map(p=>[p.pane_id,p.workspace_id,p.tab_id,p.agent_status,p.terminal_title_stripped]),this.snapshot?.tabs.map(t=>[t.tab_id,t.label])]);if(signature!==this.detailSignature){this.detailSignature=signature;this.metadata.textContent=`${pane.agent||'shell'} · ${pane.agent_status||'unknown'} · ${HyprlandApps.tilde(pane.foreground_cwd||pane.cwd)}`;this.paneTabs.replaceChildren();const siblings=this.snapshot.panes.filter(p=>p.workspace_id===pane.workspace_id);const recent=this.recentPanes.map(id=>this.snapshot.panes.find(p=>p.pane_id===id)).find(p=>p&&p.workspace_id!==pane.workspace_id);this.paneTabs.hidden=siblings.length<=1&&!recent;this.title.hidden=!this.paneTabs.hidden;for(const p of siblings){const b=button(this.paneLabel(p),()=>this.select(p.pane_id));b.setAttribute('aria-pressed',String(p.pane_id===pane.pane_id));this.paneTabs.append(b)}if(recent){const divider=node('span','herdr-project-divider');divider.setAttribute('aria-hidden','true');const project=this.snapshot.workspaces.find(w=>w.workspace_id===recent.workspace_id)?.label||'another project';const back=button(this.paneLabel(recent),()=>this.select(recent.pane_id));back.classList.add('herdr-recent-project');back.title=`Return to ${project} · ${this.paneLabel(recent)}`;back.setAttribute('aria-label',back.title);this.paneTabs.append(divider,back)}}}
    select(id){
      this.recentPanes=[...new Set([id,this.selected,...this.recentPanes].filter(Boolean))].slice(0,40);storage.write('omarchy-herdr-recent-panes',this.recentPanes);
      this.stopTouchScroll.cancel();
      this.nativeInput.select(id);this.nativeInput.submit.disabled=!!this.uploading&&this.uploadPane===id;this.selected=id;storage.set('omarchy-herdr-pane',id);this.lastRead=null;this.queuedRead=null;this.followOutput=true;this.output.scrollLeft=0;this.term.reset();this.inputStatus.textContent='';
      this.send({type:'select',pane_id:id});
      if(id){const pane=this.snapshot?.panes.find(p=>p.pane_id===id);if(pane)this.showDetail(pane)}else{this.detail.hidden=true;this.filters.hidden=false;this.search.hidden=false;this.list.hidden=false;this.bridge.logic.set({kb:false})}
    }
    move(delta){const panes=this.snapshot?orderHerdr(this.snapshot).flatMap(g=>g.panes):[];const i=panes.findIndex(p=>p.pane_id===this.selected);if(i>=0&&panes[i+delta])this.select(panes[i+delta].pane_id)}
    applyFit(){this.fitButton.textContent=this.fitOutput?'Fit':'Original';this.fitButton.setAttribute('aria-pressed',String(this.fitOutput));this.fitButton.setAttribute('aria-label','Fit to Phone');this.term.nativeView.setFit(this.fitOutput)}
    placeLatest(){if(this.nativeInput.element.hidden)this.output.append(this.latest);else this.nativeInput.header.insertBefore(this.latest,this.nativeInput.hideButton)}
    trackScroll(){this.followOutput=this.term.nativeView.follow;this.latest.hidden=this.followOutput;}
    showLatest(){this.stopTouchScroll.cancel();this.followOutput=true;this.term.scrollToBottom();this.output.scrollLeft=0;this.latest.hidden=true;}
    flushRead(){const queued=this.queuedRead;this.queuedRead=null;if(queued)this.renderOutput(queued.read,queued.force)}
    renderOutput(read,force=false){
      if(read.pane_id!==this.selected)return;
      if(!this.output.clientHeight)return;const text=read.text||'';if(!force&&text===this.lastRead?.text)return;
      // Retain only the latest snapshot while a finger or momentum owns the view.
      if(this.rendering||this.stopTouchScroll.active()){this.queuedRead={read,force};return}
      const previous=this.lastRead;this.lastRead=read;
      const plain=text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'');
      const cols=Math.max(40,Math.min(300,Math.max(...plain.split(/\r?\n/).map(l=>Array.from(l).length))));
      const screen=this.term.element.querySelector('.xterm-screen');
      const cellWidth=parseFloat(screen.style.width)/this.term.cols;
      this.canvas.style.width=`${Math.max(this.output.clientWidth,cols*cellWidth+16)}px`;
      // Use xterm's measured font metrics, not an assumed pixel height per row.
      const dimensions=this.fit.proposeDimensions();if(!dimensions)return;
      const viewAnchor=this.term.nativeView.anchor(),scroll=viewAnchor.source;
      const anchor=this.term.buffer.active.getLine(scroll)?.translateToString(true);
      const pane=this.selected;this.rendering=true;
      this.term.resize(Math.max(cols,dimensions.cols),Math.max(4,dimensions.rows));this.term.reset();
      this.term.write(text.replace(/\r?\n/g,'\r\n'),()=>{
        if(this.selected===pane){
          if(this.followOutput||!previous)this.term.scrollToBottom();
          else{
            let target=scroll,distance=Infinity;
            for(let i=0;i<this.term.buffer.active.length;i++)if(this.term.buffer.active.getLine(i)?.translateToString(true)===anchor&&Math.abs(i-scroll)<distance){target=i;distance=Math.abs(i-scroll)}
            this.term.scrollToLine(target);this.term.nativeView.restore({...viewAnchor,follow:false},target);
          }
        }
        this.rendering=false;
        this.flushRead();
      });
    }
    async uploadImages(files,pane){
      if(!pane||!files.length||this.disposed)return;
      if(this.uploading){this.inputStatus.textContent='An image is still uploading. Try again when it finishes.';return}
      this.uploading=true;this.uploadPane=pane;this.attachButton.disabled=true;this.nativeInput.submit.disabled=this.selected===pane;
      const messages=[];
      try{for(const file of files){
        if(this.disposed)break;
        if(file.size>10*1024*1024){messages.push(file.name+': larger than 10 MB');continue}
        if(!file.size){messages.push(file.name+': empty image');continue}
        if(this.selected===pane)this.inputStatus.textContent='Uploading '+(file.name||'image')+'…';
        try{
          const response=await fetch('/api/uploads/images',{method:'POST',headers:{'X-Hyprland-Client':'1','Content-Type':file.type||'application/octet-stream'},body:file,signal:AbortSignal.any([this.uploadAbort.signal,AbortSignal.timeout(60000)])});
          if(response.status===413)throw Error('Image is larger than 10 MB');
          const result=await response.json().catch(()=>({}));if(!response.ok||typeof result.path!=='string')throw Error(result.error||'Upload failed');
          if(this.disposed)break;
          this.nativeInput.attachImage(pane,result.path);messages.push('Attached '+(file.name||'image'));
        }catch(e){if(this.disposed)break;messages.push((file.name||'Image')+': '+(e.name==='TimeoutError'?'Upload timed out. Try again.':e.message||'Upload failed'))}
      }}finally{
        this.uploading=false;this.uploadPane=null;this.attachButton.disabled=false;this.nativeInput.submit.disabled=false;
        if(!this.disposed&&this.selected===pane){this.inputStatus.textContent=messages.join(' · ');if(this.bridge.logic.cur()==='herdr'&&!this.bridge.logic.state.ov){this.bridge.logic.set({kb:true,sup:false});this.nativeInput.focus()}}
      }
    }
    key(input){return this.input(input)}
    setStatus(text){this.status.hidden=/^\d+ panes$/.test(text);this.statusText=text;this.status.textContent=`${HyprlandApps.host.name} · ${text}`}
    hostChanged(){this.setStatus(this.statusText)}
    input(input){
      if(!this.selected){this.status.textContent='Select a pane to type';return false}
      if(!this.online||this.ws?.readyState!==1){this.inputStatus.textContent='Disconnected · input was not sent';return false}
      this.showLatest();
      const id=crypto.randomUUID();this.pending.add(id);this.inputStatus.textContent='';
      return this.send({type:'input',id,pane_id:this.selected,text:input.text,keys:input.keys});
    }
    dispose(){this.disposed=true;this.uploadAbort.abort();clearTimeout(this.retry);this.ws?.close();this.resizeObserver.disconnect();this.stopTouchScroll();this.nativeInput.dispose();this.term.dispose()}
  }
  // The shell talks to every app through this bridge; apps come from the HyprlandApps catalog
  // and their providers (below and in files.js, browser.js, themes.js). Nothing here knows app names.
  class HostBridge {
    constructor(logic){
      this.logic=logic;this.apps={};this.focusRetries=0;this.rememberedFocus=new WeakMap();
      this.rememberFocus=e=>{const root=e.target.closest?.('[data-workspace]');if(root)this.rememberedFocus.set(root,e.target)};
      document.addEventListener('focusin',this.rememberFocus);
      this.reconcileFocus=()=>{if(this.focusFrame)return;this.focusFrame=requestAnimationFrame(()=>{this.focusFrame=null;this.syncFocus()})};
      for(const event of ['focusout','pointerup','transitionend'])document.addEventListener(event,this.reconcileFocus);
      window.addEventListener('focus',this.reconcileFocus);
      this.foreground=()=>{if(!document.hidden)for(const app of Object.values(this.apps))app.resume?.()};
      document.addEventListener('visibilitychange',this.foreground);window.addEventListener('online',this.foreground);
      this.hostChanged=()=>{for(const app of Object.values(this.apps))app.hostChanged?.()};document.addEventListener('hyprland-host',this.hostChanged);
      if(location.protocol!=='file:')fetch('/api/capabilities',{headers:{'X-Hyprland-Client':'1'}}).then(r=>r.ok?r.json():null).then(caps=>{if(caps)HyprlandApps.setHost(caps)}).catch(()=>{});
      this.hardwareChanged=()=>this.update();window.addEventListener('hyprland-hardware-keyboard',this.hardwareChanged);
      this.update();
    }
    app(key){return this.apps[key]||null}
    async closeApp(key){
      const spec=HyprlandApps.get(key),app=this.apps[key]||null;if(!spec)return;
      if(spec.provider?.close)await spec.provider.close(app,this);
      if(app){app.dispose?.();mount(spec.mount)?.replaceChildren();delete this.apps[key]}
    }
    createInput(root,message,send,options={}){return new NativeInput(root,{...options,message,send,key:(key,mods)=>this.key(key,mods),focus:()=>{if(!this.logic.state.kb)this.logic.set({kb:true,sup:false})},hide:()=>this.logic.set({kb:false,sup:false})})}
    keyboard(){if(!this.logic.state.ov){this.logic.set({kb:true,sup:false});this.currentInput()?.focus()}}
    currentInput(){return this.apps[this.logic.cur()]?.nativeInput||null}
    update(){
      const s=this.logic.state,current=this.logic.cur(),kb=s.kb,ov=s.ov;
      const native=!!HyprlandApps.get(current)?.native&&!s.launch&&!s.sup;
      mount('touch-shell')?.classList.toggle('use-native-input',native);
      for(const spec of Object.values(HyprlandApps.catalog)){
        if(!spec.native)continue;const root=mount(spec.mount);
        if(root){root.classList.toggle('with-keyboard',kb&&!ov);root.classList.toggle('native-typing',native)}
      }
      if(location.protocol==='file:'){
        for(const spec of Object.values(HyprlandApps.catalog)){if(spec.offline)continue;const root=mount(spec.mount);if(root&&!root.textContent)root.append(node('p','remote-empty','Connect to the host to use this app.'))}
      }
      const visible=s.desk&&window.HyprlandDesk?(window.HyprlandDesk.desks(s)[s.ws]||[current]):[current];
      for(const key of visible){
        const spec=HyprlandApps.get(key);if(!spec?.provider||this.apps[key]||(location.protocol==='file:'&&!spec.offline))continue;
        const root=mount(spec.mount);if(!root)continue;
        const app=spec.provider.create(root,this);this.apps[key]=app;app.connect?.();
      }
      for(const [key,app] of Object.entries(this.apps)){
        const focused=key===current&&!ov;
        app.show?.(visible.includes(key)&&!ov,{covered:!!(s.launch||s.shade||s.map)});
        if(!focused){app.stopTouchScroll?.cancel();app.blur?.()}
        app.nativeInput?.show(native&&focused&&kb);
        app.placeLatest?.();
      }
      this.reconcileFocus();
      for(const app of Object.values(this.apps))app.resize?.();
    }
    syncFocus(){
      const s=this.logic.state,current=this.logic.cur();
      if(document.hidden||s.ov||s.launch||s.shade||s.map||s.sup||document.querySelector('.desk-sheet,[role="dialog"]'))return;
      const hardware=window.__HYPRLAND_HARDWARE_KEYBOARD__===true;
      if(!hardware&&!s.kb)return;
      const root=mount(HyprlandApps.get(current)?.mount);if(!root)return;
      const selection=window.getSelection();if(selection&&!selection.isCollapsed)return;
      const active=document.activeElement;
      if(root.contains(active)&&(active.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)))return;
      const input=this.currentInput();
      // Herd's list has no input destination until a pane is selected.
      if(input&&this.apps[current]?.detail?.hidden)return;
      const rect=root.getBoundingClientRect();
      if(rect.right<=0||rect.left>=innerWidth||rect.bottom<=0||rect.top>=innerHeight||!root.checkVisibility()){
        // A workspace can still be outside the viewport on the first layout frame.
        if(this.focusRetries++<60)this.reconcileFocus();return;
      }
      if(input){input.focus();if(document.activeElement!==input.field){if(this.focusRetries++<60)this.reconcileFocus()}else this.focusRetries=0;return}
      this.focusRetries=0;
      // Embedded pages own a separate native responder; do not pull it into the shell.
      if(!hardware||root.contains(active)||root.closest('.native-surface-visible'))return;
      const card=root.closest('[data-workspace]'),remembered=this.rememberedFocus.get(card);
      const target=remembered?.isConnected&&remembered.checkVisibility()?remembered:root;
      if(target===root)target.tabIndex=-1;target.focus({preventScroll:true});
    }
    async openTerminalAt(path){await this.closeApp('terminal');storage.set('omarchy-terminal-cwd',path);this.logic.openApp('terminal')}
    key(key,mods){const input=keyInput(key,mods);if(!input)return;this.apps[this.logic.cur()]?.key?.(input)}
    dispose(){cancelAnimationFrame(this.focusFrame);for(const event of ['focusout','pointerup','transitionend'])document.removeEventListener(event,this.reconcileFocus);window.removeEventListener('focus',this.reconcileFocus);document.removeEventListener('focusin',this.rememberFocus);window.removeEventListener('hyprland-hardware-keyboard',this.hardwareChanged);for(const app of Object.values(this.apps))app.dispose?.();document.removeEventListener('visibilitychange',this.foreground);window.removeEventListener('online',this.foreground);document.removeEventListener('hyprland-host',this.hostChanged)}
  }
  // Host TUIs share TerminalApp; each one is a catalog app whose session the backend spawns by id.
  const closeSession=async(key,app)=>{const session=app?.sessionRequest?await app.sessionRequest:null;const id=session?.id||storage.get('omarchy-'+key+'-id');if(id)await api(`terminal/${encodeURIComponent(id)}/close`,{});storage.set('omarchy-'+key+'-id',null)};
  if(window.HyprlandApps){
    HyprlandApps.provide('terminal',{create:(root,bridge)=>new TerminalTabs(root,bridge),close:(app)=>app?app.closeSessions():closeSession('terminal',null)});
    for(const key of Object.keys(HOST_TUIS))if(key!=='terminal')HyprlandApps.provide(key,{create:(root,bridge)=>new TerminalApp(root,bridge,key),close:app=>closeSession(key,app)});
    HyprlandApps.provide('herdr',{create:(root,bridge)=>new HerdrApp(root,bridge)});
  }
  window.HyprlandRemote={attach:logic=>new HostBridge(logic),keyInput,orderHerdr,paneGroup};
})();
