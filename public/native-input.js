/* Ordinary textareas let the system keyboard own touch targeting and composition. */
(() => {
  const sentinel='\u200b';
  class NativeInput {
    constructor(root,{message=false,dismissOnSend=false,draftStore=null,compactControls=false,send,key,focus,hide}){
      this.compactControls=compactControls;this.draftStore=draftStore;this.dismissOnSend=dismissOnSend;this.send=send;this.key=key;this.onFocus=focus;this.onHide=hide;this.message=message;this.drafts=new Map();this.draft='';this.ctrl=false;this.composing=false;
      this.element=document.createElement('div');this.element.className='native-input-panel';this.element.hidden=true;
      this.tools=document.createElement('div');this.tools.className='native-input-tools';this.element.append(this.tools);
      const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.setAttribute('aria-label',text);b.onpointerdown=e=>{e.stopPropagation();e.preventDefault()};b.onclick=e=>{e.stopPropagation();fn()};this.tools.append(b);return b};
      this.mode=button('',()=>{this.saveDraft();this.field.blur();this.message=!this.message;this.configure();this.focus()});this.mode.setAttribute('aria-label','Switch typing mode');
      for(const [label,keyName] of [['Esc','esc'],['Tab','tab'],['←','←'],['↑','↑'],['↓','↓'],['→','→']])button(label,()=>{this.key(keyName,{});this.focus()});
      this.ctrlButton=button('Ctrl',()=>{this.ctrl=!this.ctrl;this.ctrlButton.setAttribute('aria-pressed',String(this.ctrl));this.focus()});
      this.hideButton=button('⌄',()=>{this.field.blur();this.onHide()});this.hideButton.setAttribute('aria-label','Hide keyboard');
      const row=document.createElement('div');row.className='native-input-row';this.field=document.createElement('textarea');this.field.rows=2;this.field.className='native-input';this.field.setAttribute('autocomplete','off');this.field.setAttribute('inputmode','text');this.field.setAttribute('enterkeyhint','send');
      this.submit=document.createElement('button');this.submit.type='button';this.submit.className='native-send';this.submit.textContent='Send';this.submit.onpointerdown=e=>e.preventDefault();this.submit.onclick=()=>this.enter();row.append(this.field,this.submit);this.element.append(row);
      const header=this.header=document.createElement('div');header.className='native-input-header';header.append(this.mode,this.hideButton);this.element.prepend(header);root.append(this.element);
      for(const type of ['pointerdown','touchstart','touchmove','touchend','click'])this.element.addEventListener(type,e=>e.stopPropagation(),{passive:true});
      this.field.onfocus=()=>this.onFocus();
      this.field.oncompositionstart=()=>{this.composing=true};
      this.field.oncompositionend=()=>{this.composing=false;if(this.message)this.saveDraft();else this.rawInput()};
      this.field.oninput=e=>{if(this.message)this.saveDraft();else if(!e.isComposing&&!this.composing)this.rawInput(e)};
      this.field.onbeforeinput=e=>{
        if(e.isComposing||this.composing)return;
        if(this.ctrl&&e.data){e.preventDefault();this.sendText(e.data);return}
        if(e.inputType==='insertLineBreak'||e.inputType==='insertParagraph'){e.preventDefault();this.enter();return}
        if(!this.message&&e.inputType==='deleteContentBackward'){e.preventDefault();this.key('⌫',{});this.reset()}
      };
      this.field.onkeydown=e=>{
        if(e.isComposing||this.composing)return;
        if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();this.enter();return}
        if((e.ctrlKey||this.ctrl)&&/^[a-z]$/i.test(e.key)){e.preventDefault();this.key(e.key,{ctrl:true});this.clearCtrl();return}
        const special={Escape:'esc',Tab:'tab',ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',Backspace:'⌫'};
        if(special[e.key]&&(!this.message||['Escape','Tab'].includes(e.key))){e.preventDefault();this.key(special[e.key],{});if(!this.message)this.reset()}
      };
      this.draftStatus=document.createElement('p');this.draftStatus.className='theme-note';this.draftStatus.setAttribute('role','status');this.draftStatus.hidden=true;this.element.append(this.draftStatus);
      if(this.compactControls){this.header.insertBefore(this.tools,this.hideButton);this.element.classList.add('herdr-composer');this.mode.classList.add('native-mode');this.hideButton.classList.add('native-dismiss')}
      this.configure();
    }
    loadDraft(id){
      if(this.drafts.has(id))return this.drafts.get(id);
      if(!this.draftStore||!id)return '';
      const drafts=window.HyprlandUtil?.storage.read(this.draftStore,{});
      return typeof drafts?.[id]==='string'?drafts[id]:'';
    }
    storeDraft(id,text){
      if(!id)return;this.drafts.set(id,text);
      if(!this.draftStore)return;
      try{
        const storage=window.HyprlandUtil.storage,raw=storage.read(this.draftStore,{});
        const drafts=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
        if(text)drafts[id]=text;else delete drafts[id];
        const value=JSON.stringify(drafts);
        // Stay within the native mirror's record limit; never silently discard other drafts.
        if(new TextEncoder().encode(value).length>240000)throw Error('full');
        storage.set(this.draftStore,value);
        if(storage.get(this.draftStore)!==value)throw Error('unavailable');
        this.draftStatus.hidden=true;
      }catch{this.draftStatus.textContent='Draft could not be saved on this device. Keep this window open or copy your text.';this.draftStatus.hidden=false}
    }
    saveDraft(){if(this.message){this.draft=this.field.value;this.storeDraft(this.id,this.draft)}}
    icon(button,path,label){button.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="'+path+'"/></svg>';button.title=label}
    configure(){this.tools.hidden=this.message;this.mode.textContent=this.message?'Message':'Keys';this.field.setAttribute('aria-label',this.message?'Message to host':'Direct terminal keys');this.field.setAttribute('autocorrect',this.message?'on':'off');this.field.setAttribute('enterkeyhint',this.message?'send':'enter');this.field.setAttribute('autocapitalize','off');this.field.spellcheck=this.message;this.field.placeholder=this.message?'Write a message…':'';this.submit.textContent=this.message?'Send':'Return';if(this.compactControls){this.icon(this.mode,this.message?'M21 11a8 8 0 0 1-8 8H7l-5 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z':'M3 5h18v14H3ZM7 9h.01M11 9h.01M15 9h.01M18 9h.01M7 12h.01M11 12h.01M15 12h.01M18 12h.01M8 16h8',this.message?'Message mode · switch to keys':'Keys mode · switch to message');this.icon(this.submit,this.message?'m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2':'M20 5v8H4m5-5-5 5 5 5',this.message?'Send':'Return');this.submit.setAttribute('aria-label',this.message?'Send':'Return');this.icon(this.hideButton,'m6 9 6 6 6-6','Hide keyboard')}this.field.value=this.message?this.draft:sentinel;this.field.rows=this.message?2:1;this.clearCtrl()}
    reset(){this.field.value=sentinel;this.field.setSelectionRange(1,1)}
    clearCtrl(){this.ctrl=false;this.ctrlButton.setAttribute('aria-pressed','false')}
    sendText(text){if(this.ctrl&&text){this.key(Array.from(text)[0],{ctrl:true});text=Array.from(text).slice(1).join('');this.clearCtrl()}if(text)this.send(text,false)}
    rawInput(e){const text=this.field.value.split(sentinel).join('');if(text)this.sendText(text);else if(e?.inputType==='deleteContentBackward')this.key('⌫',{});this.reset()}
    enter(){if(this.composing||this.submit.disabled)return;if(this.message){this.saveDraft();if(this.send(this.draft,true)!==false){this.draft='';this.field.value='';this.storeDraft(this.id,'');if(this.dismissOnSend){this.field.blur();this.onHide();return}}}else this.key('⏎',{});this.focus()}
    attachImage(id,path){
      this.saveDraft();const before=id===this.id?this.draft:this.loadDraft(id);const text=before+(before&&!before.endsWith('\n')?'\n':'')+'Image: '+path+'\n';
      if(id===this.id){this.field.blur();this.message=true;this.draft=text;this.configure()}this.storeDraft(id,text);
    }
    focus(){this.element.hidden=false;this.field.focus({preventScroll:true});if(!this.message)this.field.setSelectionRange(this.field.value.length,this.field.value.length)}
    show(visible){this.element.hidden=!visible;if(!visible)this.field.blur()}
    select(id){this.saveDraft();if(this.id)this.drafts.set(this.id,this.draft);this.id=id;this.draft=this.loadDraft(id);this.configure()}
    dispose(){this.saveDraft();this.field.blur();this.element.remove()}
  }
  window.NativeInput=NativeInput;
})();
