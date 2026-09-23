/* Device-local host directory. Mirrors public/hosts.js and the iOS/Android host pickers. */
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
export const MAX_HOSTS = 10;

export function normalize(raw) {
  const text = String(raw || '').trim();
  let url;
  try {
    url = new URL(text.includes('://') ? text : 'https://' + text);
  } catch {
    throw new Error('Enter the host’s HTTPS address.');
  }
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) ||
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
}

export function clean(data) {
  const hosts = [];
  for (const item of Array.isArray(data?.hosts) ? data.hosts.slice(0, MAX_HOSTS) : []) {
    try {
      const url = normalize(item.url);
      if (!hosts.some(h => h.id === url))
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
}

/* Applies one picker action and reports whether the shell must load another page. */
export function apply(directory, action, body = {}) {
  const next = clean(directory);
  if (action === 'save') {
    const url = normalize(body.url);
    const name =
      String(body.name || '')
        .trim()
        .slice(0, 80) || new URL(url).hostname;
    const existing = next.hosts.find(h => h.id === url);
    if (existing) existing.name = name;
    else if (next.hosts.length >= MAX_HOSTS) throw new Error('You can save up to 10 hosts.');
    else next.hosts.push({ id: url, url, name });
  } else if (action === 'remove') {
    next.hosts = next.hosts.filter(h => h.id !== body.id);
    if (next.selected === body.id) {
      next.selected = null;
      next.disconnected = true;
    }
  } else if (action === 'connect') {
    if (!next.hosts.some(h => h.id === body.id)) throw new Error('Host not found.');
    next.selected = body.id;
    next.disconnected = false;
  } else if (action === 'disconnect') {
    next.disconnected = true;
  } else if (action !== 'manage') {
    throw new Error('Unsupported host action');
  }
  const navigate = ['connect', 'disconnect', 'manage'].includes(action);
  return { directory: next, navigate };
}

/* Seeds the directory from OMARCHY_REMOTE_URL or --host=, like the native apps' configured URL. */
export function seed(directory, raw) {
  if (!raw) return clean(directory);
  const url = normalize(raw);
  const next = clean(directory);
  if (!next.hosts.some(h => h.id === url)) {
    if (next.hosts.length >= MAX_HOSTS) return next;
    next.hosts.push({ id: url, url, name: new URL(url).hostname });
  }
  if (!next.selected) {
    next.selected = url;
    next.disconnected = false;
  }
  return next;
}
