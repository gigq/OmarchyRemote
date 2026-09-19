# Window management implementation

Approved order (September 19, 2026):

1. **Completed (build 30):** Resizable splits, modifier-drag movement, split-direction toggle, and saved layout selection. Default: Omarchy's Dwindle. Master-and-stack is an additional choice.
2. **Completed (web shell; native registration in the next step):** Previous workspace and moving without following.
3. Searchable action palette, with one action registry for keyboard help and native registrations.
4. Scratchpad.
5. Multiple independent window instances and window groups.
6. Scrolling layout once instance and grouping foundations are stable.

Keep phone behavior intact, preserve per-device state, test the affected UI, and commit each completed feature separately. Command is Super on Apple; Ctrl+Alt is the web fallback on Linux/Windows. Preserve existing shortcuts when adapting Omarchy actions.
