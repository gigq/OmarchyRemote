/* Launcher app for the connected host's published native builds. */
(() => {
  const { node, button } = HyprlandUtil;
  class BuildsApp {
    constructor(root) {
      this.root = root;
      this.events = new AbortController();
      for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend'])
        root.addEventListener(type, event => event.stopPropagation(), {
          passive: true,
          signal: this.events.signal,
        });
      root.classList.add('builds-app');
      this.toolbar = node('div', 'builds-toolbar');
      this.refresh = button('Refresh', () => this.load(), 'keycap');
      this.toolbar.append(this.refresh);
      this.status = node('p', 'builds-status');
      this.status.setAttribute('role', 'status');
      this.content = node('div', 'builds-content');
      root.append(this.toolbar, this.status, this.content);
      this.showWelcome();
    }
    connect() {
      this.load();
    }
    resume() {
      this.load();
    }
    show(visible) {
      if (visible && !this.visible) this.load();
      this.visible = visible;
    }
    hostChanged() {
      this.load();
    }
    async load() {
      if (this.disposed) return;
      this.controller?.abort();
      const controller = (this.controller = new AbortController());
      this.refresh.disabled = true;
      this.status.textContent = 'Checking this host…';
      try {
        const response = await fetch('/builds/catalog.json', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok && response.status !== 404) throw Error('Could not load builds');
        const builds = response.status === 404 ? [] : await response.json();
        if (!Array.isArray(builds)) throw Error('Invalid build catalog');
        if (controller.signal.aborted) return;
        this.status.textContent = '';
        if (builds.length) this.showBuilds(builds);
        else this.showWelcome();
      } catch (error) {
        if (controller.signal.aborted) return;
        this.status.textContent =
          'Cannot reach the build dashboard. Reconnect to the host and refresh.';
      } finally {
        if (this.controller === controller) this.refresh.disabled = false;
      }
    }
    skillLink() {
      const link = node('a', 'builds-action', 'Get the agent skill');
      link.href = '/builds/SKILL.md';
      link.download = 'SKILL.md';
      if (window.__HYPRLAND_NATIVE__)
        link.onclick = async event => {
          event.preventDefault();
          try {
            const response = await fetch(link.href);
            if (!response.ok) throw Error('Skill download unavailable');
            const file = new File([await response.text()], 'SKILL.md', { type: 'text/plain' });
            if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
            else {
              await navigator.clipboard.writeText(await file.text());
              this.status.textContent =
                'Skill copied. Save it as omarchy-builds/SKILL.md in your agent’s skills folder.';
            }
          } catch (error) {
            if (error.name !== 'AbortError') this.status.textContent = error.message;
          }
        };
      return link;
    }
    showWelcome() {
      const card = node('section', 'builds-card builds-welcome');
      card.append(
        node('p', 'builds-eyebrow', 'Start here'),
        node('h2', '', 'A home for your builds.'),
        node(
          'p',
          '',
          'Give your coding agent the publishing skill. Your app updates, release notes, and install links will appear here once your first build is published.'
        ),
        this.skillLink()
      );
      const steps = node('ol', 'builds-steps');
      for (const text of [
        'Save the skill as omarchy-builds/SKILL.md in ~/.codex/skills or ~/.claude/skills.',
        'Ask your agent: “Use omarchy-builds to publish my latest signed build to this host.”',
        'Return here for updates. No dashboard setup needed.',
      ])
        steps.append(node('li', '', text));
      card.append(steps);
      this.content.replaceChildren(card);
    }
    showBuilds(builds) {
      this.content.replaceChildren();
      for (const [index, build] of builds.entries()) {
        if (!/^[a-f0-9]{64}$/.test(build.id)) continue;
        const card = node('section', 'builds-card');
        card.append(
          node('p', 'builds-eyebrow', index ? 'Previous build' : 'Latest build'),
          node('h2', '', 'Build ' + build.build),
          node('p', 'builds-notes', build.notes || 'No release notes.'),
          node(
            'p',
            'builds-meta',
            `v${build.version} · ${((build.bytes || 0) / 1048576).toFixed(1)} MB · ${build.published?.slice(0, 10) || ''}`
          )
        );
        const details = node('details');
        details.append(
          node('summary', '', 'Build details'),
          node('p', '', 'Source: ' + build.commit),
          node('p', '', 'Profile expires: ' + build.expires),
          node('code', '', build.sha256)
        );
        card.append(details);
        this.content.append(card);
      }
      const actions = node('section', 'builds-card');
      const url = /^https?:$/.test(location.protocol)
        ? new URL('/builds/', location.href).href
        : null;
      actions.append(
        node('h3', '', 'Install an update'),
        node(
          'p',
          '',
          'Open this host’s dashboard in Safari to install a build. Keep Tailscale connected.'
        )
      );
      if (url) {
        const copy = button(
          'Copy dashboard link',
          async () => {
            try {
              await navigator.clipboard.writeText(url);
              this.status.textContent = 'Dashboard link copied. Open it in Safari to install.';
            } catch {
              this.status.textContent = url;
            }
          },
          'builds-action'
        );
        actions.append(copy);
        if (!window.__HYPRLAND_NATIVE__) {
          const link = node('a', 'builds-action', 'Open dashboard');
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener';
          actions.append(link);
        }
      }
      actions.append(this.skillLink());
      this.content.append(actions);
    }
    dispose() {
      this.disposed = true;
      this.events.abort();
      this.controller?.abort();
    }
  }
  HyprlandApps.provide('builds', { create: root => new BuildsApp(root) });
})();
