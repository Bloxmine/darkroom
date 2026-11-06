import { imageRect, viewerCanvas } from '../store/engine';
import { useUi } from '../store/ui';

/** Zoom the viewer by `factor` around a canvas point (device px; default = centre). */
export function zoomViewer(factor: number, at?: { x: number; y: number }) {
  const r = imageRect();
  const cw = viewerCanvas.width;
  const ch = viewerCanvas.height;
  const ui = useUi.getState();
  const z = r.zoom;
  const nz = Math.max(0.02, Math.min(64, z * factor));
  const cx = (at?.x ?? cw / 2) - cw / 2;
  const cy = (at?.y ?? ch / 2) - ch / 2;
  const px = ui.fit ? 0 : ui.panX;
  const py = ui.fit ? 0 : ui.panY;
  // keep the image point under the cursor fixed
  const ox = (cx - px) / z;
  const oy = (cy - py) / z;
  useUi.setState({ fit: false, zoom: nz, panX: cx - ox * nz, panY: cy - oy * nz });
}
