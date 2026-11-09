import { create } from 'zustand';
import { flattenGraph } from '../core/graph';
import type { Graph, TimelineSettings } from '../core/types';
import { clipLength, releaseVideoSources, sourceTime, videoSource } from '../core/video';
import { releaseWebcams, webcamKey } from '../core/webcam';
import { commitProject, useDoc } from './doc';
import { engine, renderImmediately, requestRender } from './engine';

/**
 * Project timeline: time, fps, duration, playback. Drives `engine.time` / `engine.frame`
 * (u_time / u_frame) while the project is "in motion" (a video/webcam source is present, or
 * Animate is on); otherwise both stay 0 so stills render exactly as before. See docs/VIDEO.md.
 */
export const VIDEO = 'core.video';
export const WEBCAM = 'core.webcam';
/** Other video-file sources (own decoders, same params as core.video): they also put the project in motion and set its length. */
export const VIDEO_LIKE = new Set([VIDEO, 'ai.videoSlowMo', 'core.videoFrameOffset']);

export interface TimelineState extends Required<TimelineSettings> {
  /** Seconds. */
  time: number;
  playing: boolean;
  /** The graph contains a (non-bypassed) video source. */
  hasVideo: boolean;
  /** The graph contains a live source (webcam): renders continuously. */
  hasLive: boolean;
  /** Measured preview frame rate while playing. */
  measuredFps: number;
  /** A video export owns the engine. */
  exporting: boolean;
}

export const DEFAULT_TIMELINE: Required<TimelineSettings> = { fps: 30, duration: 5, loop: true, animate: false, realtime: true };

export const useTimeline = create<TimelineState>(() => ({
  ...DEFAULT_TIMELINE,
  time: 0,
  playing: false,
  hasVideo: false,
  hasLive: false,
  measuredFps: 0,
  exporting: false,
}));

const get = () => useTimeline.getState();

/** Is time running for this project (transport shown, u_frame live)? */
export const inMotion = (s: TimelineState = get()) => s.animate || s.hasVideo || s.hasLive;
export const frameOf = (t: number, fps: number) => Math.floor(t * fps + 1e-6);
export const frameCount = (s: Pick<TimelineState, 'duration' | 'fps'> = get()) => Math.max(1, Math.round(s.duration * s.fps));

// ---------------------------------------------------------------------------
// engine sync
// ---------------------------------------------------------------------------

function syncEngine() {
  const s = get();
  if (!engine || s.exporting) return;
  const m = inMotion(s);
  const t = m ? s.time : 0;
  const f = m ? frameOf(s.time, s.fps) : 0;
  if (engine.time !== t || engine.frame !== f) {
    engine.time = t;
    engine.frame = f;
    requestRender();
  }
}
useTimeline.subscribe(syncEngine);

/** Decode the frames every video source needs at timeline time `t` (so the render can use them synchronously). */
export async function prepareVideoFrames(graph: Graph, t: number): Promise<void> {
  if (!engine) return;
  const flat = flattenGraph(graph);
  const jobs: Promise<unknown>[] = [];
  for (const n of flat.nodes) {
    if (n.type !== VIDEO || n.bypass) continue;
    const a = engine.assets.get(String(n.params.asset ?? ''));
    const src = videoSource(a);
    if (!src) continue;
    const lt = sourceTime(n.params, a, t);
    if (!src.frameSync(lt)) jobs.push(src.frameAt(lt).catch((e) => console.warn('[darkroom] video decode failed', e)));
  }
  if (jobs.length) await Promise.all(jobs);
}

// ---------------------------------------------------------------------------
// graph scan: sources present, auto duration, resource release
// ---------------------------------------------------------------------------

let lastVideoSig = '';

function scanGraph(applyAuto: boolean) {
  const p = useDoc.getState().project;
  const flat = flattenGraph(p.graph);
  const vids = flat.nodes.filter((n) => VIDEO_LIKE.has(n.type) && !n.bypass);
  const cams = flat.nodes.filter((n) => n.type === WEBCAM && !n.bypass);
  releaseVideoSources(new Set(vids.map((n) => String(n.params.asset ?? ''))));
  releaseWebcams(new Set(cams.map((n) => webcamKey(String(n.params.device ?? 'default'), String(n.params.resolution ?? '1280x720')))));
  let dur = 0;
  let fps = 0;
  for (const n of vids) {
    const a = engine?.assets.get(String(n.params.asset ?? ''));
    if (!a?.duration) continue;
    dur = Math.max(dur, clipLength(n.params, a));
    if (!fps && a.fps) fps = a.fps;
  }
  const s = get();
  const patch: Partial<TimelineState> = {};
  if (s.hasVideo !== vids.length > 0) patch.hasVideo = vids.length > 0;
  if (s.hasLive !== cams.length > 0) patch.hasLive = cams.length > 0;
  const sig = `${dur.toFixed(4)}|${fps}`;
  if (applyAuto && sig !== lastVideoSig && dur > 0) {
    // a clip was added / trimmed: follow its length and frame rate
    patch.duration = Math.round(dur * 1000) / 1000;
    patch.fps = Math.round(fps * 1000) / 1000 || s.fps;
    if (s.time > patch.duration) patch.time = 0;
  }
  lastVideoSig = sig;
  if (Object.keys(patch).length) useTimeline.setState(patch);
  if (patch.hasLive && !s.playing) play(); // live sources run
  if (patch.hasLive === false && !get().hasVideo && !get().animate) pause();
  ensureLoop();
}

useDoc.subscribe((s, p) => {
  if (s.loadCount !== p.loadCount) {
    // project opened: adopt its timeline settings
    const tl = { ...DEFAULT_TIMELINE, ...(s.project.timeline ?? {}) };
    useTimeline.setState({ ...tl, time: 0, playing: false });
    scanGraph(false);
    return;
  }
  if (s.project.graph !== p.project.graph) scanGraph(true);
});

// store settings in the project (silently: not an undo step)
useTimeline.subscribe((s, p) => {
  if (s.fps === p.fps && s.duration === p.duration && s.loop === p.loop && s.animate === p.animate && s.realtime === p.realtime) return;
  const tl: TimelineSettings = { fps: s.fps, duration: s.duration, loop: s.loop, animate: s.animate, realtime: s.realtime };
  queueMicrotask(() => {
    const cur = useDoc.getState().project.timeline;
    if (cur && JSON.stringify(cur) === JSON.stringify(tl)) return;
    commitProject((pr) => ({ ...pr, timeline: tl }), { silent: true });
  });
});

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

let anchorWall = 0;
let anchorTime = 0;
const resetAnchor = () => {
  anchorWall = performance.now();
  anchorTime = get().time;
};

export function play() {
  const s = get();
  if (s.exporting) return;
  const patch: Partial<TimelineState> = { playing: true };
  if (!inMotion(s)) patch.animate = true;
  if (s.time >= s.duration - 1 / s.fps) patch.time = 0;
  useTimeline.setState(patch);
  resetAnchor();
  ensureLoop();
}

export function pause() {
  if (get().playing) useTimeline.setState({ playing: false, measuredFps: 0 });
}

export function togglePlay() {
  if (get().playing) pause();
  else play();
}

export function seek(t: number) {
  const s = get();
  const time = Math.max(0, Math.min(s.duration, t));
  useTimeline.setState({ time });
  resetAnchor();
}

/** Step whole frames (pauses playback). */
export function stepFrame(delta: number) {
  pause();
  const s = get();
  const n = frameCount(s);
  let f = frameOf(s.time, s.fps) + delta;
  f = s.loop ? ((f % n) + n) % n : Math.max(0, Math.min(n - 1, f));
  seek(f / s.fps);
}

export function goToStart() {
  seek(0);
}

export function setTimeline(patch: Partial<Pick<TimelineState, 'fps' | 'duration' | 'loop' | 'animate' | 'realtime'>>) {
  if (patch.fps !== undefined) patch.fps = Math.max(1, Math.min(240, patch.fps));
  if (patch.duration !== undefined) patch.duration = Math.max(0.1, Math.min(3600, patch.duration));
  useTimeline.setState(patch);
  const s = get();
  if (s.time > s.duration) seek(0);
  if (patch.animate === false && !s.hasVideo && !s.hasLive) pause();
  resetAnchor();
}

// ---------------------------------------------------------------------------
// render loop (only runs while playing or a live source is present)
// ---------------------------------------------------------------------------

let loopRunning = false;
let busy = false;
let fpsCount = 0;
let fpsWall = 0;

function ensureLoop() {
  const s = get();
  if (loopRunning || s.exporting || !(s.playing || s.hasLive)) return;
  loopRunning = true;
  resetAnchor();
  requestAnimationFrame(tick);
}

function tick(now: number) {
  const s = get();
  if (s.exporting || !(s.playing || s.hasLive)) {
    loopRunning = false;
    return;
  }
  if (!busy) {
    busy = true;
    void step(now).finally(() => (busy = false));
  }
  requestAnimationFrame(tick);
}

async function step(now: number) {
  const s = get();
  if (s.hasLive && engine) engine.liveTick++;
  if (s.playing) {
    let t = s.realtime ? anchorTime + (now - anchorWall) / 1000 : s.time + 1 / s.fps;
    let ended = false;
    if (t >= s.duration) {
      if (s.loop) {
        t = s.realtime ? t % s.duration : 0;
        anchorWall = now - t * 1000;
        anchorTime = 0;
      } else {
        t = Math.max(0, s.duration - 1 / s.fps);
        ended = true;
        useTimeline.setState({ playing: false, measuredFps: 0 });
      }
    }
    if (!s.realtime) t = Math.round(t * s.fps) / s.fps; // exact frame times
    await prepareVideoFrames(useDoc.getState().project.graph, t);
    if (get().playing || ended) useTimeline.setState({ time: t });
    fpsCount++;
    if (now - fpsWall > 500) {
      useTimeline.setState({ measuredFps: Math.round((fpsCount * 1000) / (now - fpsWall)) });
      fpsCount = 0;
      fpsWall = now;
    }
  }
  renderImmediately();
  // Every frame: let async steps (AI nodes such as optical flow / datamosh / slow motion) finish, so each frame
  // is complete before the next one starts (realtime playback keeps dropping frames instead)
  if (s.playing && !s.realtime && engine) {
    for (let k = 0; k < 6 && engine.cpuBusy; k++) {
      await engine.whenCpuIdle();
      renderImmediately();
    }
  }
}

// test / console hook
setTimeout(() => {
  const w = window as unknown as { __darkroom?: Record<string, unknown> };
  if (w.__darkroom) w.__darkroom.timeline = { useTimeline, play, pause, seek, stepFrame, setTimeline, prepareVideoFrames, inMotion };
}, 0);
