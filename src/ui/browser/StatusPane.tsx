/** Status-bar pane (src/ui/Chrome.tsx): item / selection counts while a browser panel has focus. Kept tiny: Chrome imports it. */
import { Icon } from '../Icon';
import { useBrowser } from './store';

export function BrowserStatusPane() {
  const active = useBrowser((s) => s.activePanel);
  const n = useBrowser((s) => s.entries.length);
  const sel = useBrowser((s) => s.selection.length);
  if (!active) return null;
  return (
    <span className="sb-pane" title="Items in the Content panel / selected">
      <Icon name="images" />
      {n} item{n === 1 ? '' : 's'}
      {sel ? `, ${sel} selected` : ''}
    </span>
  );
}
