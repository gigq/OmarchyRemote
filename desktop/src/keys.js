/* Matches keys typed inside an embedded website against the shell's published action registry.
   The registry comes from desk.js through shellKeyboard; this file owns no shortcut table. */
export function register(commands) {
  if (!Array.isArray(commands) || commands.length > 256) return null;
  for (const row of commands)
    if (
      !row ||
      typeof row.code !== 'string' ||
      row.code.length > 32 ||
      String(row.label || '').length > 160
    )
      return null;
  return commands;
}

/* `input` is Electron's before-input-event payload: code plus modifier booleans. */
export function match(commands, input, editing = false) {
  if (!input?.code) return null;
  for (const row of commands) {
    if (row.code !== input.code || !!row.shift !== !!input.shift) continue;
    if (editing && row.editing) continue;
    const exact =
      !!row.meta === !!input.meta && !!row.ctrl === !!input.control && !!row.alt === !!input.alt;
    // Plain Command shell bindings keep their Ctrl+Alt spelling where Super belongs to the desktop.
    const alias = row.meta && !row.ctrl && !row.alt && !input.meta && input.control && input.alt;
    if (exact || alias) return row;
  }
  return null;
}
