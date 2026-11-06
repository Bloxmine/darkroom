/**
 * App-wide effects of preferences that don't belong to one component:
 * viewer pixelation / checker background, fit-on-change, pause-while-dragging,
 * texture pool size, plugin policy, AI provider, node-id overlay and the FPS
 * overlay. Imported once from main.tsx (after App, so the Viewer has already
 * wrapped engine.present).
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './prefs.css';
import { pluginPolicy } from '../../core/plugins';
import { useDoc } from '../../store/doc';
import { afterRender, engine, requestRender, suspendRender } from '../../store/engine';
import * as settings from '../../store/settings';
import { useSettings } from '../../store/settings';
import { useUi } from '../../store/ui';
import { commands, handleKeyDown } from '../commands';

const get = () => useSettings.getState();

// --- viewer: pixelated zoom + checkerboard background -------------------------------
const CHECKER_FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;
uniform vec4 u_rect;
void main() {
  vec2 p = gl_FragCoord.xy;
  if (all(greaterThanEqual(p, u_rect.xy)) && all(lessThan(p, u_rect.xy + u_rect.zw))) discard;
  vec2 c = floor(p / 12.0);
  fragColor = vec4(vec3(mod(c.x + c.y, 2.0) < 1.0 ? 0.40 : 0.30), 1.0);
}`;

if (engine) {
  const inner = engine.present.bind(engine);
  engine.present = (tex, opts) => {
    const s = get();
    inner(tex, { ...opts, pixelated: s.pixelZoom ? opts.pixelated : false });
    if (s.viewerBg !== 'checker') return;
    try {
      const g = engine.gl;
      const H = g.gl.drawingBufferHeight;
      const r = tex ? opts.rect : { x: 0, y: 0, w: 0, h: 0 };
      g.draw(g.program(CHECKER_FRAG), null, {}, { u_rect: [r.x, H - r.y - r.h, r.w, r.h] });
    } catch (e) {
      console.warn('[darkroom] checker background failed', e);
    }
  };
  engine.gl.poolLimit = get().poolSize;
}

useSettings.subscribe((s, p) => {
  if (s.viewerBg !== p.viewerBg || s.pixelZoom !== p.pixelZoom || s.previewCap !== p.previewCap) requestRender();
  if (engine && s.poolSize !== p.poolSize) engine.gl.poolLimit = s.poolSize;
  if (s.aiPreferWebGPU !== p.aiPreferWebGPU) void import('../../core/ai/runtime').then((m) => m.setEpPreference(s.aiPreferWebGPU ? 'auto' : 'wasm'));
  if (s.showNodeIds !== p.showNodeIds) applyNodeIds();
});

// --- AI: keep the runtime's provider preference in line at startup ---------------------
try {
  if (!get().aiPreferWebGPU) localStorage.setItem('darkroom.ai.ep', 'wasm');
} catch {
  /* storage unavailable */
}

// --- plugins ---------------------------------------------------------------------------
pluginPolicy.allowCode = () => get().allowCodePlugins;

// --- zoom to fit when the viewed image changes size ------------------------------------
useUi.subscribe((s, p) => {
  if (!get().fitOnChange || s.fit) return;
  if (!p.fullWidth || !s.fullWidth) return;
  if (s.fullWidth !== p.fullWidth || s.fullHeight !== p.fullHeight) useUi.setState({ fit: true, panX: 0, panY: 0 });
});

// --- pause rendering while dragging sliders -------------------------------------------
let held = false;
const release = () => {
  if (!held) return;
  held = false;
  suspendRender(false);
  requestRender();
};
window.addEventListener(
  'pointerdown',
  (e) => {
    if (get().dragRender !== 'pause') return;
    const t = e.target as HTMLElement | null;
    if (!t?.closest?.('.side input[type="range"], .side .curve-editor, .side svg')) return;
    held = true;
    suspendRender(true);
  },
  true,
);
window.addEventListener('pointerup', release, true);
window.addEventListener('pointercancel', release, true);
window.addEventListener('blur', release);

// --- flattened node ids (CSS reads data-id + the group path prefix) ----------------------
function applyNodeIds() {
  const r = document.documentElement;
  if (!get().showNodeIds) {
    delete r.dataset.showNodeIds;
    return;
  }
  r.dataset.showNodeIds = '';
  const path = useDoc.getState().path;
  r.style.setProperty('--dr-node-path', JSON.stringify(path.length ? path.join('/') + '/' : ''));
}
applyNodeIds();
useDoc.subscribe((s, p) => s.path !== p.path && applyNodeIds());

// --- FPS / render-time overlay -----------------------------------------------------------
let frames = 0;
afterRender.add(() => frames++);

function FpsOverlay() {
  const ms = useUi((s) => s.renderMs);
  const w = useUi((s) => s.renderWidth);
  const h = useUi((s) => s.renderHeight);
  const [fps, setFps] = useState(0);
  const [host, setHost] = useState<Element | null>(() => document.querySelector('.viewer-host'));
  useEffect(() => {
    const t = { last: performance.now() };
    frames = 0;
    const id = window.setInterval(() => {
      const now = performance.now();
      setFps((frames * 1000) / (now - t.last));
      frames = 0;
      t.last = now;
      setHost((h) => (h?.isConnected ? h : document.querySelector('.viewer-host')));
    }, 500);
    return () => clearInterval(id);
  }, []);
  if (!host) return null;
  return createPortal(
    <div className="dr-fps">{`${fps.toFixed(1)} fps  ${ms.toFixed(1)} ms\n${w}×${h}  pool ${engine ? (engine.gl.bytes / 1e6).toFixed(0) : 0} MB`}</div>,
    host,
  );
}

/** Mounted next to <App/>: preference-driven overlays + the console hook. */
export function PrefsHost() {
  const fps = useSettings((s) => s.showFps);
  useEffect(() => {
    const w = window as unknown as { __darkroom?: Record<string, unknown> };
    if (w.__darkroom) w.__darkroom.prefs = { ...settings, commands, handleKeyDown };
  }, []);
  return fps ? <FpsOverlay /> : null;
}
