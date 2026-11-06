import {
  BufferTarget,
  CanvasSource,
  canEncodeVideo,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
  ALL_FORMATS,
  BlobSource,
  Input,
  type AudioCodec,
  type EncodedPacket,
  type Quality,
  type VideoCodec,
} from 'mediabunny';
import { flattenGraph } from '../core/graph';
import { sourceTime } from '../core/video';
import { videoHasAudio } from '../core/videoAssets';
import { outputNodeId, useDoc } from './doc';
import { engine, previewScale, requestRender, suspendRender, viewerCanvas } from './engine';
import { prepareVideoFrames, useTimeline, VIDEO } from './timeline';

/**
 * Offline video export: for every frame t = i / fps the graph is rendered at the export
 * resolution with engine.time = t / engine.frame = i (video sources decoded frame-accurately),
 * presented 1:1 onto the engine canvas, and captured with mediabunny's CanvasSource
 * (`new VideoFrame(canvas)` → WebCodecs VideoEncoder → MP4/WebM muxer). See docs/VIDEO.md.
 */
export type VideoContainer = 'mp4' | 'webm';
export type QualityName = 'low' | 'medium' | 'high' | 'very-high';

export interface VideoExportOptions {
  container: VideoContainer;
  codec: VideoCodec;
  /** Render scale relative to the output's full resolution. */
  scale: number;
  fps: number;
  /** Seconds. */
  duration: number;
  /** Fixed bitrate in Mbit/s; 0 = use `quality`. */
  bitrateMbps: number;
  quality: QualityName;
  /** Copy the encoded audio of the (first) video source (speed 1, no loop wrap). */
  audio: boolean;
}

export interface VideoExportResult {
  blob: Blob;
  ms: number;
  frames: number;
  width: number;
  height: number;
  mime: string;
  ext: string;
  audio: string | null;
}

export const CODECS: Record<VideoContainer, { codec: VideoCodec; label: string }[]> = {
  mp4: [
    { codec: 'avc', label: 'H.264 (most compatible)' },
    { codec: 'hevc', label: 'H.265 / HEVC' },
    { codec: 'av1', label: 'AV1' },
  ],
  webm: [
    { codec: 'vp9', label: 'VP9' },
    { codec: 'av1', label: 'AV1' },
    { codec: 'vp8', label: 'VP8' },
  ],
};

const QUALITIES: Record<QualityName, Quality> = { low: QUALITY_LOW, medium: QUALITY_MEDIUM, high: QUALITY_HIGH, 'very-high': QUALITY_VERY_HIGH };

/** Encoded frame size: the output at `scale`, rounded down to even numbers (4:2:0 chroma). */
export function exportSize(full: { width: number; height: number }, scale: number) {
  const even = (v: number) => Math.max(2, Math.floor(Math.max(1, Math.round(v * scale)) / 2) * 2);
  return { width: even(full.width), height: even(full.height) };
}

/** null if the encoder supports this configuration, else a human-readable reason. */
export async function checkVideoSupport(o: VideoExportOptions, width: number, height: number): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return 'This browser has no WebCodecs VideoEncoder (try a recent Chrome, Edge or Safari).';
  const ok = await canEncodeVideo(o.codec, {
    width,
    height,
    frameRate: o.fps,
    ...(o.bitrateMbps > 0 ? { bitrate: o.bitrateMbps * 1e6 } : { quality: QUALITIES[o.quality] }),
  }).catch(() => false);
  if (!ok) {
    const name = CODECS[o.container].find((c) => c.codec === o.codec)?.label ?? o.codec;
    return `${name} encoding at ${width}×${height} is not supported by this browser (VideoEncoder.isConfigSupported failed). Try another codec/format or a smaller size.`;
  }
  return null;
}

/** First non-bypassed video source with its asset (for audio passthrough). */
function audioSource() {
  const g = useDoc.getState().project.graph;
  const n = flattenGraph(g).nodes.find((x) => x.type === VIDEO && !x.bypass);
  const a = n && engine?.assets.get(String(n.params.asset ?? ''));
  return n && a?.blob ? { node: n, asset: a } : null;
}

export function canPassAudio() {
  const s = audioSource();
  return !!s && videoHasAudio(s.asset.id) && Math.abs(Number(s.node.params.speed ?? 1) - 1) < 1e-6;
}

/** Render the output once with every source ready (decoded video frame, loaded assets) and return its full size. */
export async function measureVideoOutput(): Promise<{ width: number; height: number }> {
  if (!engine) return { width: 0, height: 0 };
  const doc = useDoc.getState();
  const nodeId = outputNodeId(doc.project);
  await prepareVideoFrames(doc.project.graph, engine.time);
  let r = engine.render(doc.project.graph, { nodeId, scale: previewScale });
  for (let i = 0; i < 3 && (engine.cpuBusy || engine.errors.size); i++) {
    await engine.whenCpuIdle();
    r = engine.render(doc.project.graph, { nodeId, scale: previewScale });
  }
  requestRender();
  return { width: r.fullWidth, height: r.fullHeight };
}

export async function exportVideo(o: VideoExportOptions, onProgress: (frame: number, frames: number) => void, signal: AbortSignal): Promise<VideoExportResult> {
  if (!engine) throw new Error('WebGL2 is not available.');
  const t0 = performance.now();
  const doc = useDoc.getState();
  const graph = doc.project.graph;
  const nodeId = outputNodeId(doc.project);
  const probe = await measureVideoOutput();
  if (!probe.width) throw new Error('Nothing to export — connect something to the Output node.');
  const { width, height } = exportSize(probe, o.scale);
  const why = await checkVideoSupport(o, width, height);
  if (why) throw new Error(why);

  const frames = Math.max(1, Math.round(o.duration * o.fps));
  const format = o.container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat();
  const target = new BufferTarget();
  const output = new Output({ format, target });

  // --- take over the engine + canvas
  const tl = useTimeline.getState();
  if (tl.playing) useTimeline.setState({ playing: false });
  useTimeline.setState({ exporting: true });
  suspendRender(true);
  const savedInvalidate = engine.onInvalidate;
  engine.onInvalidate = () => {};
  const saved = { w: viewerCanvas.width, h: viewerCanvas.height, time: engine.time, frame: engine.frame, fit: viewerCanvas.style.objectFit };
  viewerCanvas.style.objectFit = 'contain'; // the viewer shows the frames being encoded, letterboxed
  const fitCanvas = () => {
    if (viewerCanvas.width !== width || viewerCanvas.height !== height) {
      viewerCanvas.width = width;
      viewerCanvas.height = height;
    }
  };
  fitCanvas();

  let audioDesc: string | null = null;
  let audioInput: Input | null = null;
  try {
    const video = new CanvasSource(viewerCanvas, {
      codec: o.codec,
      bitrate: o.bitrateMbps > 0 ? o.bitrateMbps * 1e6 : QUALITIES[o.quality],
      keyFrameInterval: 2,
      latencyMode: 'quality',
    });
    output.addVideoTrack(video, { frameRate: o.fps });

    // --- optional audio passthrough (encoded packets copied, no re-encode)
    let audio: { src: EncodedAudioPacketSource; it: AsyncGenerator<EncodedPacket>; next: EncodedPacket | null; meta: EncodedAudioChunkMetadata; offset: number; end: number; first: boolean } | null = null;
    const as = o.audio ? audioSource() : null;
    if (as && canPassAudio()) {
      audioInput = new Input({ source: new BlobSource(as.asset.blob!), formats: ALL_FORMATS });
      const at = await audioInput.getPrimaryAudioTrack();
      const codec = (await at?.getCodec()) as AudioCodec | null;
      if (at && codec && format.getSupportedAudioCodecs().includes(codec)) {
        const cfg = await at.getDecoderConfig();
        const start = sourceTime(as.node.params, as.asset, 0);
        const sink = new EncodedPacketSink(at);
        const firstPkt = await sink.getPacket(start);
        if (cfg && firstPkt) {
          const src = new EncodedAudioPacketSource(codec);
          output.addAudioTrack(src);
          audio = { src, it: sink.packets(firstPkt), next: null, meta: { decoderConfig: cfg }, offset: start, end: start + o.duration, first: true };
          audioDesc = codec;
        }
      } else if (at) audioDesc = `skipped (${codec ?? 'unknown'} audio can't go into ${o.container.toUpperCase()})`;
    }
    await output.start();

    /** Copy audio packets up to source time `until`. */
    const pumpAudio = async (until: number) => {
      if (!audio) return;
      while (true) {
        if (!audio.next) {
          const r = await audio.it.next();
          if (r.done) {
            audio = null;
            return;
          }
          audio.next = r.value;
        }
        const p = audio.next;
        if (p.timestamp > until || p.timestamp >= audio.end) {
          if (p.timestamp >= audio.end) audio = null;
          return;
        }
        audio.next = null;
        const ts = p.timestamp - audio.offset;
        if (ts < 0) continue;
        await audio.src.add(p.clone({ timestamp: ts }), audio.first ? audio.meta : undefined);
        audio.first = false;
      }
    };

    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      const t = i / o.fps;
      engine.time = t;
      engine.frame = i;
      engine.liveTick++; // webcams: grab a fresh frame
      await prepareVideoFrames(graph, t);
      let res = engine.render(graph, { nodeId, scale: o.scale });
      if (engine.cpuBusy) {
        // async sources (first decode, webcam warm-up): wait and render again
        await engine.whenCpuIdle();
        res = engine.render(graph, { nodeId, scale: o.scale });
      }
      fitCanvas();
      engine.present(res.tex, { rect: { x: 0, y: 0, w: width, h: height } });
      await pumpAudio(audio ? audio.offset + t + 1 / o.fps : 0);
      await video.add(t, 1 / o.fps);
      onProgress(i + 1, frames);
    }
    await pumpAudio(Infinity);
    await output.finalize();
    const mime = await output.getMimeType().catch(() => (o.container === 'mp4' ? 'video/mp4' : 'video/webm'));
    const blob = new Blob([target.buffer!], { type: mime.split(';')[0] });
    return { blob, ms: performance.now() - t0, frames, width, height, mime, ext: o.container, audio: audioDesc };
  } catch (e) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    throw e;
  } finally {
    audioInput?.dispose();
    viewerCanvas.width = saved.w;
    viewerCanvas.height = saved.h;
    viewerCanvas.style.objectFit = saved.fit;
    engine.time = saved.time;
    engine.frame = saved.frame;
    engine.onInvalidate = savedInvalidate;
    useTimeline.setState({ exporting: false });
    suspendRender(false);
    requestRender();
  }
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// test / console hook
setTimeout(() => {
  const w = window as unknown as { __darkroom?: Record<string, unknown> };
  if (w.__darkroom) w.__darkroom.video = { exportVideo, checkVideoSupport, exportSize, canPassAudio };
}, 0);
