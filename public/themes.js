/* Shared semantic colors for the shell, host adapters and ANSI renderer. */
(() => {
  const prototype={id:'prototype',name:'Prototype',colors:{mode:'dark',background:'#191724',dark_background:'#15131f',lighter_background:'#1f1d2e',darker_background:'#26233a',selection:'#403d52',foreground:'#e0def4',light_foreground:'#908caa',dark_foreground:'#6e6a86',accent:'#3e8fb0',red:'#eb6f92',yellow:'#f6c177',cyan:'#ebbcba',green:'#9ccfd8',magenta:'#c4a7e7',blue:'#31748f',bright_foreground:'#ffffff'}};
  const catalog=[prototype,...window.OmarchyThemeCatalog];
  let current=prototype;
  const ansiKeys=['black','red','green','yellow','blue','magenta','cyan','white','brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
  function terminalTheme(){
    const c=current.colors, result={background:c.dark_background||c.background,foreground:c.foreground,cursor:c.accent,selectionBackground:c.selection,black:c.darker_background||c.background,white:c.foreground,brightBlack:c.dark_foreground,brightWhite:c.bright_foreground||c.foreground};
    for(const key of ['red','green','yellow','blue','magenta','cyan']){result[key]=c[key];result['bright'+key[0].toUpperCase()+key.slice(1)]=c['bright_'+key]||c[key]}
    if(current===prototype)Object.assign(result,{cyan:'#9ccfd8',cursor:'#ebbcba',brightRed:'#ff0000',brightGreen:'#00ff00',brightYellow:'#ffff00',brightBlue:'#0000ff',brightMagenta:'#ff00ff',brightCyan:'#00ffff'});
    return result;
  }
  function apply(id,persist=true){
    current=catalog.find(t=>t.id===id)||prototype;
    const c=current.colors, vars={background:c.background,terminal:c.dark_background||c.background,surface:c.lighter_background||c.background,'surface-raised':c.darker_background||c.selection,border:c.selection,foreground:c.foreground,secondary:c.light_foreground||c.foreground,dim:c.dark_foreground||c.foreground,red:c.red,yellow:c.yellow,rose:c.cyan,green:c.green,magenta:c.magenta,accent:c.accent,blue:c.blue,cyan:c.cyan,mode:c.mode||'dark'};
    if(current===prototype)vars.cyan='#56949f';
    for(const [name,value] of Object.entries(vars))document.documentElement.style.setProperty('--theme-'+name,value);
    document.documentElement.dataset.theme=current.id;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',c.background);
    if(persist)try{localStorage.setItem('omarchy-theme',current.id)}catch{}
    refresh();window.dispatchEvent(new Event('hyprland-theme-change'));
  }
  function refresh(){
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content',current.colors.background);
    document.querySelectorAll('[data-theme-name]').forEach(n=>n.textContent=current.name);
    document.querySelectorAll('[data-theme-choice]').forEach(b=>{const selected=b.dataset.themeChoice===current.id;b.setAttribute('aria-pressed',String(selected));b.querySelector('.theme-check').textContent=selected?'✓':''});
  }
  function attach(host){
    host=host||[...document.querySelectorAll('#theme-settings')].find(n=>!n.closest('x-dc'));
    if(!host||host.childElementCount)return;
    host.innerHTML=`<header><div class="theme-eyebrow">settings / appearance</div><h1>Themes</h1><p>Make this space yours.</p><div class="theme-current">Current <strong data-theme-name></strong></div></header><div class="theme-grid" role="group" aria-label="Choose a theme"></div><p class="theme-note">${catalog.length-1} Omarchy palettes + the original prototype.<br>Saved on this device.</p>`;
    window.HyprlandWebApps?.settings(host);
    const grid=host.querySelector('.theme-grid');
    for(const t of catalog){
      const c=t.colors,b=document.createElement('button');b.type='button';b.className='theme-choice';b.dataset.themeChoice=t.id;b.setAttribute('aria-label',t.name);
      b.style.setProperty('--preview-bg',c.background);b.style.setProperty('--preview-fg',c.foreground);b.style.setProperty('--preview-accent',c.accent);
      const preview=document.createElement('div');preview.className='theme-preview';
      const prompt=document.createElement('span');prompt.className='theme-prompt';prompt.textContent='~ ❯ hello';preview.append(prompt);
      const bars=document.createElement('div');bars.className='theme-swatches';for(const key of ['red','yellow','green','blue','magenta','cyan']){const swatch=document.createElement('i');swatch.style.background=c[key];bars.append(swatch)}preview.append(bars);
      const label=document.createElement('div');label.className='theme-label';const name=document.createElement('span');name.textContent=t.name;const check=document.createElement('span');check.className='theme-check';check.setAttribute('aria-hidden','true');label.append(name,check);
      b.append(preview,label);b.onclick=e=>{e.stopPropagation();apply(t.id)};grid.append(b);
    }
    // Let native scrolling own this surface without triggering workspace swipes.
    for(const type of ['pointerdown','touchstart','touchmove','touchend'])host.addEventListener(type,e=>e.stopPropagation(),{passive:true});
    refresh();
  }
  window.HyprlandApps?.provide('settings',{create:root=>{attach(root);return {}}});
  window.HyprlandThemes={apply,attach,catalog,terminalTheme,palette:()=>{const t=terminalTheme();return ansiKeys.map(k=>t[k])}};
  let saved;try{saved=localStorage.getItem('omarchy-theme')}catch{}apply(saved,false);
})();
