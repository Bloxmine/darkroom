/**
 * One owner for the Space bar, which three features want:
 *  - viewer: hold Space + drag = pan (even over a viewer tool's overlay);
 *  - node graph: hold Space + drag = React Flow pan (GraphEditor panActivationKeyCode="Space");
 *  - playback: a *tap* (press and release without dragging) = play / pause while the project is in motion.
 * Playback therefore toggles on key-up, and only if no pointer drag/click happened while Space
 * was held. Typing in a text field, select or content-editable never counts (the key goes to the
 * field). Space's default action (scrolling, "clicking" a focused button or checkbox) is suppressed
 * so a focused control doesn't fire when you meant play/pause or pan.
 */
import { create } from 'zustand';
import { useUi } from '../../store/ui';

export const useSpace = create<{ down: boolean }>(() => ({ down: false }));

const tapListeners = new Set<() => void>();
/** Called for a Space tap (no drag, released within TAP_MS). Returns an unsubscribe. */
export function onSpaceTap(fn: () => void) {
  tapListeners.add(fn);
  return () => void tapListeners.delete(fn);
}

const TAP_MS = 600;

export const isTypingTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color'].includes((el as HTMLInputElement).type);
  return !!el.closest?.('.cm-editor'); // CodeMirror
};

let pressedAt = 0;
let used = false;
let active = false;

function reset() {
  active = false;
  used = false;
  if (useSpace.getState().down) useSpace.setState({ down: false });
}

function keydown(e: KeyboardEvent) {
  if (e.code !== 'Space') return;
  if (isTypingTarget(e.target)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (useUi.getState().dialog) return;
  e.preventDefault(); // no page scroll / button activation
  if (e.repeat || active) return;
  active = true;
  used = false;
  pressedAt = performance.now();
  useSpace.setState({ down: true });
}

function keyup(e: KeyboardEvent) {
  if (e.code !== 'Space' || !active) return;
  e.preventDefault();
  const tap = !used && performance.now() - pressedAt < TAP_MS && !isTypingTarget(e.target);
  reset();
  if (tap) for (const fn of [...tapListeners]) fn();
}

/** Any pointer press or drag while Space is held makes it a pan gesture, not a tap. */
function pointer(e: PointerEvent) {
  if (!active) return;
  if (e.type === 'pointerdown' || e.buttons) used = true;
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', keydown, true);
  window.addEventListener('keyup', keyup, true);
  window.addEventListener('pointerdown', pointer, true);
  window.addEventListener('pointermove', pointer, true);
  window.addEventListener('blur', reset);
}
