/** The small eyedropper button next to colour params (Properties) and in the colour popup. */
import { useId } from 'react';
import { clamp01 } from '../../core/scopes';
import { cancelEyedropper, startEyedropper, useViewer } from '../../store/viewer';
import { Icon } from '../Icon';

type RGBA = [number, number, number, number];

/**
 * Arms the viewer eyedropper; the next click on the image calls `onPick` once (one undo step
 * when the caller commits without coalescing). The picked alpha is replaced by `keepAlpha` if given.
 */
export function EyedropperButton({ label, onPick, keepAlpha, className }: { label: string; onPick: (c: RGBA) => void; keepAlpha?: number; className?: string }) {
  const token = useId();
  const armed = useViewer((s) => s.eyedrop?.token === token);
  const size = useViewer((s) => (s.eyedrop?.token === token ? s.eyedrop.size : 0));
  return (
    <button
      type="button"
      className={'tbtn small vx-eyedrop-btn' + (armed ? ' checked' : '') + (className ? ' ' + className : '')}
      title={armed ? `Click the image to pick (${size}×${size}) — Esc cancels` : 'Pick this colour from the viewer (eyedropper)'}
      aria-pressed={armed}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        if (armed) return cancelEyedropper();
        startEyedropper(label, (c) => onPick([clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), keepAlpha ?? clamp01(c[3])]), { token });
      }}
    >
      <Icon name="color_picker" />
    </button>
  );
}
