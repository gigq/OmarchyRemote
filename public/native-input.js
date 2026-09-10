/* Ordinary textareas let the system keyboard own touch targeting and composition. */
(() => {
  const sentinel='\u200b';
  class NativeInput {
    constructor(root,{message=false,send,key,focus,hide}){
      this.send=send;this.key=key;this.onFocus=focus;this.onHide=hide;this.message=message;this.drafts=new Map();this.draft='';this.ctrl=false;this.composing=false;
      this.element=document.createElement('div');this.element.className='native-input-panel';this.element.hidden=true;
      this.tools=document.createElement('div');this.tools.className='native-input-tools';this.element.append(this.tools);
      const button=(text,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.setAttribute('aria-label',text);b.onpointerdown=e=>{e.stopPropagation();e.preventDefault()};b.onclick=e=>{e.stopPropagation();fn()};this.tools.append(b);return b};
      this.mode=button('',()=>{this.saveDraft();this.field.blur();this.message=!this.message;this.configure();this.focus()});this.mode.setAttribute('aria-label','Switch typing mode');
      for(const [label,keyName] of [['Esc','esc'],['Tab','tab'],['←','←'],['↑','↑'],['↓','↓'],['→','→']])button(label,()=>{this.key(keyName,{});this.focus()});
      this.ctrlButton=button('Ctrl',()=>{this.ctrl=!this.ctrl;this.ctrlButton.setAttribute('aria-pressed',String(this.ctrl));this.focus()});
      this.hideButton=button('⌄',()=>{this.field.blur();this.onHide()});this.hideButton.setAttribute('aria-label','Hide keyboard');
      const row=document.createElement('div');row.className='native-input-row';this.field=document.createElement('textarea');this.field.rows=2;this.field.className='native-input';this.field.setAttribute('autocomplete','off');this.field.setAttribute('inputmode','text');this.field.setAttribute('enterkeyhint','send');
      this.submit=document.createElement('button');this.submit.type='button';this.submit.className='native-send';this.submit.textContent='Send';this.submit.onpointerdown=e=>e.preventDefault();this.submit.onclick=()=>this.enter();row.append(this.field,this.submit);this.element.append(row);
      const header=document.createElement('div');header.className='native-input-header';header.append(this.mode,this.hideButton);this.element.prepend(header);root.append(this.element);
      for(const type of ['pointerdown','touchstart','touchmove','touchend','click'])this.element.addEventListener(type,e=>e.stopPropagation(),{passive:true});
      this.field.onfocus=()=>this.onFocus();
      this.field.oncompositionstart=()=>{this.composing=true};
      this.field.oncompositionend=()=>{this.composing=false;if(!this.message)this.rawInput()};
      this.field.oninput=e=>{if(!e.isComposing&&!this.composing){if(this.message)this.saveDraft();else this.rawInput(e)}};
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
      this.configure();
    }
    saveDraft(){if(this.message)this.draft=this.field.value}
    configure(){this.mode.textContent=this.message?'Message':'Keys';this.field.setAttribute('aria-label',this.message?'Message to host':'Direct terminal keys');this.field.setAttribute('autocorrect',this.message?'on':'off');this.field.setAttribute('enterkeyhint',this.message?'send':'enter');this.field.setAttribute('autocapitalize','off');this.field.spellcheck=this.message;this.field.placeholder=this.message?'Write a message…':'';this.submit.textContent=this.message?'Send':'Return';this.field.value=this.message?this.draft:sentinel;this.field.rows=this.message?2:1;this.clearCtrl()}
    reset(){this.field.value=sentinel;this.field.setSelectionRange(1,1)}
    clearCtrl(){this.ctrl=false;this.ctrlButton.setAttribute('aria-pressed','false')}
    sendText(text){if(this.ctrl&&text){this.key(Array.from(text)[0],{ctrl:true});text=Array.from(text).slice(1).join('');this.clearCtrl()}if(text)this.send(text,false)}
    rawInput(e){const text=this.field.value.split(sentinel).join('');if(text)this.sendText(text);else if(e?.inputType==='deleteContentBackward')this.key('⌫',{});this.reset()}
    enter(){if(this.composing)return;if(this.message){this.saveDraft();if(this.send(this.draft,true)!==false){this.draft='';this.field.value=''}}else this.key('⏎',{});this.focus()}
    focus(){this.element.hidden=false;this.field.focus({preventScroll:true});if(!this.message)this.field.setSelectionRange(this.field.value.length,this.field.value.length)}
    show(visible){this.element.hidden=!visible;if(!visible)this.field.blur()}
    select(id){this.saveDraft();if(this.id)this.drafts.set(this.id,this.draft);this.id=id;this.draft=this.drafts.get(id)||'';this.configure()}
    dispose(){this.field.blur();this.element.remove()}
  }
  window.NativeInput=NativeInput;
})();
