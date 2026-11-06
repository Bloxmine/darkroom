/** Shortcut recording helpers for Preferences › Keyboard. */

const CODE_KEYS: Record<string, string> = {
  Equal: '=',
  Minus: '-',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Space: 'Space',
};

/** True while a row is recording: the window's own shortcuts (⌘1…, Esc) stand down. */
export const recording = { active: false };

/** Keyboard event → combo string in the command table's format ('Ctrl+Shift+K'), or null for a bare modifier. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn'].includes(e.key)) return null;
  let key: string;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else if (e.key.length === 1) key = e.key.toUpperCase();
  else key = e.key; // F1, Enter, Tab, Delete, Backspace, ArrowLeft…
  const mods = [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.altKey ? 'Alt' : '', e.shiftKey ? 'Shift' : ''].filter(Boolean);
  return [...mods, key].join('+');
}
