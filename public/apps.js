/* App catalog: the one list the shell reads for workspaces, Home pins, the launcher,
   Expo cards, desk tiles and SUPER bindings. To add an app, `define` it here and give it
   behaviour with `HyprlandApps.provide(key, {...})` from its own module (see CONTRIBUTING.md).
   The key doubles as the host app id the backend knows. */
(() => {
  const catalog={};
  // surface: 'terminal' cards use the terminal background, 'page' cards the app background.
  // mount: id of the element the app renders into (default remote-<key>-app, class remote-app).
  // native: the touch keyboard and hardware keys are sent to the app (its instance implements key()).
  // offline: the app works without the host backend, so no "connect to the host" placeholder.
  // typing: keyboard status label while the app has focus (defaults to the app name).
  const define=(key,spec)=>{catalog[key]={key,mount:'remote-'+key+'-app',mountClass:'remote-app',surface:'page',native:false,offline:false,typing:null,provider:null,...spec};return catalog[key]};
  define('home',{name:'home',color:'var(--theme-rose)',glyph:'hm',description:'launcher',offline:true});
  define('terminal',{name:'terminal',color:'var(--theme-green)',glyph:'>_',description:'live host shell',surface:'terminal',native:true});
  define('files',{name:'files',color:'var(--theme-red)',glyph:'fm',description:'files on the host'});
  define('browser',{name:'browser',color:'var(--theme-blue)',glyph:'br',description:'desktop browser tabs'});
  define('herdr',{name:'herdr',color:'var(--theme-cyan)',glyph:'hd',description:'agents · herdr',native:true,typing:'selected Herdr pane'});
  define('btop',{name:'btop',color:'var(--theme-green)',glyph:'bt',description:'host system monitor',surface:'terminal',native:true});
  define('services',{name:'services',color:'var(--theme-yellow)',glyph:'sv',description:'systemd services · logs',surface:'terminal',native:true});
  define('lazydocker',{name:'lazydocker',color:'var(--theme-blue)',glyph:'dk',description:'containers · docker',surface:'terminal',native:true});
  define('dua',{name:'dua',color:'var(--theme-yellow)',glyph:'du',description:'disk usage · cleanup',surface:'terminal',native:true});
  define('lnav',{name:'lnav',color:'var(--theme-cyan)',glyph:'lg',description:'host logs · search',surface:'terminal',native:true});
  define('settings',{name:'settings',color:'var(--theme-accent)',glyph:'st',description:'appearance · themes · web apps',mount:'theme-settings',mountClass:'theme-settings',offline:true});
  // A provider is {create(root, bridge) → instance, close?(instance|null, bridge)}. Instances may
  // implement connect, resume, resize, show(visible), blur, key(input), nativeInput, stopTouchScroll,
  // placeLatest and dispose; the bridge calls whichever exist.
  const provide=(key,provider)=>{const app=catalog[key];if(!app)throw Error('Unknown app: '+key);app.provider=provider;return app};
  const defineWebApp=app=>define(app.id,{name:app.name,glyph:app.name.slice(0,2).toLowerCase(),color:'var(--theme-accent)',description:new URL(app.url).hostname,offline:true,mountClass:'remote-app webapp-app'});
  const DEFAULT_PINS=['terminal','files','browser','herdr','btop','services','lazydocker','dua','lnav','settings'];
  // The connected host, filled from /api/capabilities by the bridge; `hyprland-host` fires on
  // document when it changes so status lines can repaint.
  const host={name:'host',home:''};
  const setHost=caps=>{if(caps?.host)host.name=caps.host;if(caps?.home)host.home=caps.home;document.dispatchEvent(new CustomEvent('hyprland-host',{detail:host}))};
  const tilde=path=>host.home&&path&&(path===host.home||path.startsWith(host.home+'/'))?'~'+path.slice(host.home.length):path||'';
  window.HyprlandApps={catalog,define,defineWebApp,provide,get:key=>catalog[key]||null,keys:()=>Object.keys(catalog),DEFAULT_PINS,host,setHost,tilde};
})();
