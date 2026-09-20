/* Herdr owns its app provider and Home widget, including thread navigation. */
(() => {
  const { node, button } = HyprlandUtil;
  const { orderHerdr, paneGroup, HerdrApp } = HyprlandRemote;
  function render(root, snapshot, { open, error } = {}) {
    const scroll = root.querySelector('.herdr-widget-threads')?.scrollTop || 0;
    root.replaceChildren();
    const header = node('div', 'widget-line widget-legend');
    header.append(node('strong', '', 'herdr'));
    root.append(header);
    if (!snapshot) {
      root.append(node('p', 'widget-muted', error || 'Connecting to herdr…'));
      return;
    }
    const tabs = new Map(snapshot.tabs.map(tab => [tab.tab_id, tab.label]));
    const threads = orderHerdr(snapshot).flatMap(project =>
      project.panes.map(pane => ({ pane, project: project.label || project.workspace_id }))
    );
    const waiting = threads.filter(({ pane }) => paneGroup(pane) === 'attention');
    const working = threads.filter(({ pane }) => paneGroup(pane) === 'running');
    const visible = waiting.length ? waiting : working;
    header.append(
      node(
        'span',
        'widget-muted',
        waiting.length ? waiting.length + ' need attention' : working.length + ' working'
      )
    );
    if (!visible.length) {
      root.append(
        node(
          'p',
          'widget-muted',
          threads.length ? 'No threads working or waiting for you.' : 'No threads open.'
        )
      );
      return;
    }
    const list = node('div', 'herdr-widget-threads');
    for (const { pane, project } of visible) {
      const name =
        tabs.get(pane.tab_id) || pane.terminal_title_stripped || pane.agent || pane.pane_id;
      const row = button('', () => open?.(app => app?.select(pane.pane_id)), 'herdr-widget-thread');
      row.dataset.state = paneGroup(pane);
      row.setAttribute('aria-label', 'Open ' + project + ' · ' + name);
      const info = node('span', 'herdr-widget-info');
      info.append(node('strong', '', name), node('small', 'widget-muted', project));
      // Keep the actual status visible: an approval, blocked task, or working agent
      // is more useful than an undifferentiated "needs you" message.
      const state = node(
        'span',
        'herdr-widget-state',
        waiting.length
          ? pane.attention_kind && pane.attention_kind !== 'none'
            ? pane.attention_kind.replaceAll('_', ' ')
            : pane.agent_status || 'Needs attention'
          : 'Working'
      );
      row.append(info, state);
      list.append(row);
    }
    root.append(list);
    list.scrollTop = scroll;
  }
  HyprlandApps.provide('herdr', {
    create: (root, bridge) => new HerdrApp(root, bridge),
    widgets: [{ key: 'herdr', name: 'herdr', endpoint: 'herdr/snapshot', render }],
  });
})();
