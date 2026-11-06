import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny';
import type { Asset, Params } from './types';

/**
 * Frame-accurate video decoding for `core.video` (mediabunny + WebCodecs).
 *
 * One `VideoDecoderSource` per video asset. `frameAt(t)` returns the frame whose
 * presentation interval contains `t` (seconds, source time). Sequential requests
 * (playback, export) advance a single pre-decoding sample iterator, so each packet
 * is decoded once; jumps backwards or > 2 s ahead restart it at the nearest keyframe.
 * Requests are serialized; `frameSync(t)` returns the current frame without waiting
 * if it already covers `t` (that is what lets the engine's cpu() step stay synchronous
 * after `prepareVideoFrames()` ran — see store/timeline.ts and store/videoExport.ts).
 */
export class VideoDecoderSource {
  readonly input: Input;
  private track: Promise<InputVideoTrack | null>;
  private sink: Promise<VideoSampleSink | null>;
  private iter: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private cur: { frame: VideoFrame; ts: number; dur: number } | null = null;
  private ahead: VideoSample | null = null;
  private eos = false;
  private queue: Promise<unknown> = Promise.resolve();
  private latest = 0;
  /** Frames replaced recently; closed a little later (an async upload may still hold one). */
  private retired: VideoFrame[] = [];
  disposed = false;

  constructor(blob: Blob) {
    this.input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    this.track = this.input.getPrimaryVideoTrack();
    this.sink = this.track.then((t) => (t ? new VideoSampleSink(t) : null));
  }

  /** The decoded frame covering `t`, if it is the current one. */
  frameSync(t: number): VideoFrame | null {
    return this.covers(t) ? this.cur!.frame : null;
  }

  /** Last decoded frame (any time). */
  current(): VideoFrame | null {
    return this.cur?.frame ?? null;
  }

  /**
   * Decode the frame for source time `t`. With `skipStale`, a request that has been
   * superseded by a newer one before it starts resolves with the current frame instead
   * (used while scrubbing so the queue never backs up).
   */
  frameAt(t: number, skipStale = false): Promise<VideoFrame | null> {
    const ticket = ++this.latest;
    const run = async () => {
      if (this.disposed) return null;
      if (skipStale && ticket !== this.latest) return this.cur?.frame ?? null;
      return this.seek(t);
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  private covers(t: number) {
    const c = this.cur;
    if (!c) return false;
    const eps = 1e-6;
    if (t < c.ts - eps) return false;
    if (this.ahead) return t < this.ahead.timestamp - eps;
    if (this.eos) return true;
    return t < c.ts + Math.max(c.dur, 1e-3) - eps;
  }

  private setCur(s: VideoSample) {
    const frame = s.toVideoFrame();
    const next = { frame, ts: s.timestamp, dur: s.duration };
    s.close();
    if (this.cur) this.retire(this.cur.frame);
    this.cur = next;
  }

  private retire(f: VideoFrame) {
    this.retired.push(f);
    while (this.retired.length > 3) this.retired.shift()!.close();
  }

  private async restart(t: number) {
    const sink = await this.sink;
    if (!sink) throw new Error('No decodable video track');
    await this.iter?.return();
    this.ahead?.close();
    this.ahead = null;
    this.eos = false;
    this.iter = sink.samples(Math.max(0, t));
    const first = await this.iter.next();
    if (first.done) {
      this.eos = true;
      // past the end: show the last frame
      const last = await sink.getSample(Math.max(0, t));
      if (last) this.setCur(last);
      return;
    }
    this.setCur(first.value);
  }

  private async seek(t: number): Promise<VideoFrame | null> {
    if (this.covers(t) && (this.ahead || this.eos)) return this.cur!.frame;
    const c = this.cur;
    if (!this.iter || !c || t < c.ts - 1e-6 || t > c.ts + 2) await this.restart(t);
    // advance until the next sample starts after t
    while (!this.eos) {
      let s = this.ahead;
      this.ahead = null;
      if (!s) {
        const r = await this.iter!.next();
        if (r.done) {
          this.eos = true;
          break;
        }
        s = r.value;
      }
      if (s.timestamp <= t + 1e-6) this.setCur(s);
      else {
        this.ahead = s;
        break;
      }
    }
    return this.cur?.frame ?? null;
  }

  dispose() {
    this.disposed = true;
    void this.iter?.return();
    this.ahead?.close();
    this.cur?.frame.close();
    this.retired.forEach((f) => f.close());
    this.retired = [];
    this.cur = null;
    this.input.dispose();
  }
}

const sources = new Map<string, { blob: Blob; src: VideoDecoderSource }>();

/** Shared decoder for a video asset (null if the asset has no video data). */
export function videoSource(a: Asset | undefined): VideoDecoderSource | null {
  if (!a?.blob) return null;
  const e = sources.get(a.id);
  if (e && e.blob === a.blob) return e.src;
  e?.src.dispose();
  const src = new VideoDecoderSource(a.blob);
  sources.set(a.id, { blob: a.blob, src });
  return src;
}

/** Free decoders of assets no longer referenced. */
export function releaseVideoSources(keep: Set<string>) {
  for (const [id, e] of sources) {
    if (keep.has(id)) continue;
    e.src.dispose();
    sources.delete(id);
  }
}

/** Clip length in seconds (after trim and speed) of a core.video node; Infinity when looping. */
export function clipLength(params: Params, a: Asset | undefined): number {
  const { start, end, speed } = clipParams(params, a);
  return Math.max(0, end - start) / speed;
}

function clipParams(params: Params, a: Asset | undefined) {
  const dur = a?.duration ?? 0;
  const start = Math.max(0, Number(params.start ?? 0) || 0);
  const e = Number(params.end ?? 0) || 0;
  const end = e > start ? Math.min(e, dur || e) : dur;
  const speed = Math.max(0.01, Math.abs(Number(params.speed ?? 1) || 1));
  return { start, end, speed, loop: params.loop !== false };
}

/** Map timeline time → source time for a core.video node (trim, speed, loop / hold). */
export function sourceTime(params: Params, a: Asset | undefined, t: number): number {
  const { start, end, speed, loop } = clipParams(params, a);
  const len = Math.max(0, end - start);
  const fd = a?.fps ? 1 / a.fps : 1 / 30;
  let lt = Math.max(0, t) * speed;
  if (len <= 0) return start;
  if (loop) lt = lt % len;
  else lt = Math.min(lt, Math.max(0, len - fd * 0.5));
  return start + lt;
}
