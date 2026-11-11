/**
 * A small JPEG of the project's output, kept up to date in the background so a saved .darkroom
 * file can carry a `preview` (shown as its thumbnail in the Browse workspace). Captured from the
 * viewer's last frame when it showed the Output (a GPU downsample + async readback, debounced to
 * 2 s after the last render), so it never costs an extra render.
 */
import { decimate } from '../core/readback';
import { afterRender, engine, presented } from './engine';
import { outputNodeId, useDoc } from './doc';

let preview: string | null = null;
let timer = 0;
let busy = false;

/** The latest preview as a data URL (≈ 256 px JPEG), or null before the first capture. */
export const projectPreviewDataUrl = () => preview;

async function capture() {
  if (busy || !engine || !presented.tex) return;
  const out = outputNodeId(useDoc.getState().project);
  if (!out || presented.target !== out) return;
  busy = true;
  try {
    const img = await decimate(engine.gl, presented.tex, 256);
    if (!img) return;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    preview = c.toDataURL('image/jpeg', 0.72);
  } catch (e) {
    console.warn('[darkroom] project preview capture failed', e);
  } finally {
    busy = false;
  }
}

let installed = false;
export function startProjectPreview() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  afterRender.add(() => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void capture(), 2000);
  });
}
