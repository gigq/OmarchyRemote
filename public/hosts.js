/* Device-local connection directory. Never backed up to an individual host. */
(() => {
  const bridge = window.webkit?.messageHandlers?.shellHosts;
  const key = 'hyper-host-directory';
  const picker = location.pathname.endsWith('/hosts.html');
  const apple =
    /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '') ||
    /Macintosh|iPad|iPhone/.test(navigator.userAgent);
  const hostKeys = apple ? '⌘⌃' : 'Meta+Ctrl+';
  const normalize = raw => {
    const url = new URL(raw.includes('://') ? raw : 'https://' + raw);
    if (
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        )) ||
      url.username ||
      url.password ||
      !url.hostname ||
      !['/', '/native', '/native/'].includes(url.pathname) ||
      url.search ||
      url.hash
    )
      throw new Error(
        'Use the host’s HTTPS address, without credentials, a query, or a custom path.'
      );
    return url.origin + '/native/';
  };
  const clean = data => {
    const hosts = [];
    for (const item of Array.isArray(data?.hosts) ? data.hosts.slice(0, 10) : []) {
      try {
        const url = normalize(item.url);
        if (!hosts.some(h => h.url === url))
          hosts.push({
            id: url,
            url,
            name: String(item.name || new URL(url).hostname)
              .trim()
              .slice(0, 80),
          });
      } catch {}
    }
    return {
      hosts,
      selected: hosts.some(h => h.id === data?.selected) ? data.selected : null,
      disconnected: data?.disconnected === true,
    };
  };
  let directory;
  try {
    const handoff =
      !bridge && location.hash.startsWith('#hosts=')
        ? JSON.parse(decodeURIComponent(location.hash.slice(7)))
        : null;
    directory = clean(
      window.__OMARCHY_DEVICE__?.hosts || handoff || JSON.parse(localStorage.getItem(key))
    );
    if (handoff) history.replaceState(null, '', location.pathname + location.search);
  } catch {
    directory = { hosts: [], selected: null };
  }
  if (!bridge && !picker && !window.__OMARCHY_DEVICE__ && directory.disconnected) {
    location.replace(new URL('hosts.html', location.href));
    return;
  }
  if (!bridge && !picker && /^https?:$/.test(location.protocol)) {
    const url = normalize(location.origin);
    if (!directory.hosts.some(h => h.id === url) && directory.hosts.length < 10)
      directory.hosts.push({ id: url, url, name: location.hostname });
    directory.selected = url;
  }
  const save = () => {
    if (!bridge) localStorage.setItem(key, JSON.stringify(directory));
  };
  try {
    save();
  } catch {}
  const snapshot = () =>
    Object.fromEntries(
      Object.keys(localStorage)
        .filter(k => k.startsWith('omarchy-'))
        .map(k => [k, localStorage.getItem(k)])
    );
  async function request(action, extra = {}) {
    if (!bridge && window.__OMARCHY_DEVICE__) {
      alert('Host switching needs the updated native app.');
      return;
    }
    if (bridge) {
      const result = await bridge.postMessage({
        action,
        ...extra,
        scope: window.__OMARCHY_DEVICE__?.scope || '',
        values: picker ? null : snapshot(),
      });
      if (result) directory = clean(result);
    } else {
      if (action === 'save') {
        const url = normalize(extra.url);
        const existing = directory.hosts.find(h => h.id === url);
        if (!existing && directory.hosts.length >= 10)
          throw new Error('You can save up to 10 hosts.');
        const item = {
          id: url,
          url,
          name: extra.name.trim().slice(0, 80) || new URL(url).hostname,
        };
        if (existing) Object.assign(existing, item);
        else directory.hosts.push(item);
      }
      if (action === 'remove') {
        directory.hosts = directory.hosts.filter(h => h.id !== extra.id);
        if (directory.selected === extra.id) {
          directory.selected = null;
          directory.disconnected = true;
        }
      }
      if (action === 'disconnect') {
        directory.selected = null;
        directory.disconnected = true;
      }
      if (action === 'connect') {
        const host = directory.hosts.find(h => h.id === extra.id);
        if (!host) throw new Error('Host not found.');
        directory.selected = host.id;
        directory.disconnected = false;
        save();
        const target = new URL('/', host.url);
        target.hash = 'hosts=' + encodeURIComponent(JSON.stringify(directory));
        location.assign(target.href);
        return;
      }
      save();
      if (action === 'disconnect' || action === 'manage') {
        location.assign(new URL('hosts.html', location.href));
        return;
      }
    }
    render();
  }
  const connect = id => request('connect', { id });
  const manage = () => request('manage');
  const disconnect = () => request('disconnect');
  const switchIndex = index => {
    const host = directory.hosts[index];
    if (host && (picker || host.id !== directory.selected)) return connect(host.id);
  };
  const button = (text, run) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.onclick = () => Promise.resolve().then(run).catch(showError);
    return element;
  };
  const showError = error => {
    const output = document.querySelector('#host-error');
    if (output) output.textContent = error.message || String(error);
    else console.error(error);
  };
  function render() {
    if (!picker) return;
    const list = document.querySelector('#host-list');
    if (!list) return;
    list.replaceChildren();
    directory.hosts.forEach((host, index) => {
      const row = document.createElement('li');
      const open = button(host.name, () => connect(host.id));
      open.className = 'host-connect';
      const address = document.createElement('small');
      address.textContent = new URL(host.url).host;
      const number = document.createElement('span');
      number.className = 'host-number';
      number.textContent = String((index + 1) % 10);
      open.prepend(number);
      open.append(address);
      if (host.id === directory.selected) open.setAttribute('aria-current', 'true');
      const remove = button('Remove', () => request('remove', { id: host.id }));
      remove.setAttribute('aria-label', 'Remove ' + host.name);
      row.append(open, remove);
      list.append(row);
    });
    const back = document.querySelector('#host-back');
    back.hidden = !directory.selected;
    back.onclick = () => connect(directory.selected).catch(showError);
  }
  window.HyprlandHosts = {
    normalize,
    manage,
    disconnect,
    switchIndex,
    launcherItems: query =>
      [
        ...directory.hosts.map((host, index) => ({
          name: host.name,
          detail:
            (host.id === directory.selected ? 'Current host · ' : 'Connect · ') +
            new URL(host.url).host,
          key: hostKeys + ((index + 1) % 10),
          run: () => connect(host.id),
        })),
        { name: 'Manage hosts', detail: 'Add or connect to a host', run: manage },
        { name: 'Disconnect', detail: 'Return to saved hosts', run: disconnect },
      ].filter(item => (item.name + ' ' + item.detail).toLowerCase().includes(query)),
  };
  if (picker)
    document.addEventListener('DOMContentLoaded', () => {
      render();
      document.querySelector('#host-key-hint').textContent =
        'Saved on this device. ' + (apple ? '⌘ Control ' : 'Meta+Ctrl+') + '1–0 switches hosts.';
      // Native apps add hosts in a system dialog; the desktop client keeps the inline form.
      if (bridge && window.__OMARCHY_PLATFORM__ !== 'desktop') {
        const form = document.querySelector('#host-form');
        form.before(button('Add a host', () => request('prompt')));
        form.after(document.querySelector('#host-error'));
        form.hidden = true;
      }
      document.querySelector('#host-form').onsubmit = async event => {
        event.preventDefault();
        document.querySelector('#host-error').textContent = '';
        const form = new FormData(event.target);
        try {
          await request('save', {
            url: normalize(String(form.get('url')).trim()),
            name: String(form.get('name')),
          });
          event.target.reset();
        } catch (error) {
          showError(error);
        }
      };
      const shortcut = event => {
        if (
          !event.metaKey ||
          !event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          !/^Digit\d$/.test(event.code)
        )
          return;
        event.preventDefault?.();
        switchIndex((Number(event.code.slice(5)) || 10) - 1);
      };
      window.addEventListener('keydown', shortcut);
      // Use the same dispatch endpoint as the shell while no desk is loaded.
      window.HyprlandDesk = {
        nativeKey: key =>
          shortcut({
            code: key.code,
            metaKey: key.meta,
            ctrlKey: key.ctrl,
            altKey: key.alt,
            shiftKey: key.shift,
          }),
      };
      window.webkit?.messageHandlers?.shellKeyboard?.postMessage({
        commands: Array.from({ length: 10 }, (_, i) => ({
          code: 'Digit' + i,
          meta: true,
          ctrl: true,
          alt: false,
          shift: false,
          label: 'Switch to host ' + (i || 10),
        })),
      });
    });
})();
