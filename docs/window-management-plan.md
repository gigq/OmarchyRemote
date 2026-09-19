# Window management implementation

Approved order (September 19, 2026):

1. **Completed (build 30):** Resizable splits, modifier-drag movement, split-direction toggle, and saved layout selection. Default: Omarchy's Dwindle. Master-and-stack is an additional choice.
2. **Completed (web shell; native registration in the next step):** Previous workspace and moving without following.
3. **Completed (build 31):** Searchable action palette, with one action registry for keyboard help and native registrations.
4. **Completed:** Scratchpad.
5. **Completed:** Independent Terminal/Files window instances and groups for all apps.
6. **Completed (bundled in build 32):** Scrolling columns, saved widths, native scroll strip, and focus-driven reveal.

Keep phone behavior intact, preserve per-device state, test the affected UI, and commit each completed feature separately. Command is Super on Apple; Ctrl+Alt is the web fallback on Linux/Windows. Preserve existing shortcuts when adapting Omarchy actions.

Follow-up set (September 19, 2026):

- Completed: regular floating windows with saved bounds and stacking.
- Completed: independent Browser windows (native build 33).
- Completed: direct active-window keyboard resizing.
- Completed: per-device shortcut editor with shared dispatch, help, native registration, conflict checks, and reset.
