/**
 * Video sources for the multi-frame AI nodes:
 *  - `privateDecoder()`: a VideoDecoderSource of its own per (asset, channel), so sampling a clip at
 *    another time (t − 1/fps, or frame k + 1) never makes the shared decoder of core.video seek back
 *    and forth (each seek backwards restarts at a keyframe);
 *  - `core.videoFrameOffset` "Video Frame (offset)": a Video source that shows the frame N frames
 *    before/after the timeline time. Wire it into Optical Flow's frame A (offset −1) for exact frame
 *    pairs at any time (scrubbing), or into Frame Interpolation (offset +1) next to a Video node.
 */
import { defineNode } from '../../core/registry';
import type { Asset, NodeDef, Params, RawTex } from '../../core/types';
import { sourceTime, VideoDecoderSource } from '../../core/video';

const decoders = new Map<string, { blob: Blob; src: VideoDecoderSource }>();

/** A decoder of `asset` that only this `channel` uses (LRU of 6). */
export function privateDecoder(a: Asset | undefined, channel: string): VideoDecoderSource | null {
  if (!a?.blob) return null;
  const key = `${channel}:${a.id}`;
  const e = decoders.get(key);
  if (e && e.blob === a.blob && !e.src.disposed) {
    decoders.delete(key);
    decoders.set(key, e);
    return e.src;
  }
  e?.src.dispose();
  const src = new VideoDecoderSource(a.blob);
  decoders.set(key, { blob: a.blob, src });
  while (decoders.size > 6) {
    const [k, old] = decoders.entries().next().value!;
    old.src.dispose();
    decoders.delete(k);
  }
  return src;
}

export function placeholder(): RawTex {
  const w = 64, h = 36, d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, v = 40 + ((x + y) / (w + h)) * 60;
    d[i] = d[i + 1] = v; d[i + 2] = v + 12; d[i + 3] = 255;
  }
  return { width: w, height: h, data: d };
}

/** Same params as core.video (so a Video node can be swapped for one of these). */
export const VIDEO_PARAMS = {
  asset: { type: 'asset', default: '', label: 'Video', accept: 'video/*,.mp4,.m4v,.mov,.webm,.mkv' },
  start: { type: 'float', default: 0, min: 0, max: 3600, step: 0.01, label: 'Trim start (s)' },
  end: { type: 'float', default: 0, min: 0, max: 3600, step: 0.01, label: 'Trim end (s)', description: '0 = end of the file.' },
  speed: { type: 'float', default: 1, min: 0.05, max: 8, step: 0.01, label: 'Speed' },
  loop: { type: 'bool', default: true, label: 'Loop' },
} as const;

export const videoSize = ({ params, getAsset, projectSize }: { params: Params; getAsset: (id: string) => Asset | undefined; projectSize: { width: number; height: number } }): [number, number] => {
  const a = getAsset(String(params.asset ?? ''));
  return a?.width && a.height ? [a.width, a.height] : [projectSize.width, projectSize.height];
};

/** Sample u_src at the node's output size; box-filters when downscaling (video frames have no mipmaps). */
export const SAMPLE_SRC = /* glsl */ `
vec4 sampleSrc(vec2 uv) {
  vec2 ratio = u_src_size / u_resolution;
  float r = max(ratio.x, ratio.y);
  if (r <= 1.5) return texture(u_src, uv);
  vec2 px = ratio / u_src_size;
  vec4 a = vec4(0.0);
  int n = r > 3.0 ? 4 : 2;
  for (int j = 0; j < 4; j++) {
    if (j >= n) break;
    for (int i = 0; i < 4; i++) {
      if (i >= n) break;
      a += texture(u_src, uv + ((vec2(float(i), float(j)) + 0.5) / float(n) - 0.5) * px);
    }
  }
  return a / float(n * n);
}
`;

const offsetNode = defineNode({
  id: 'core.videoFrameOffset',
  name: 'Video Frame (offset)',
  category: 'Input',
  color: '#4f8cff',
  description:
    'A video file shown N source frames before (negative) or after (positive) the timeline time, with its own decoder. ' +
    'Use offset −1 for the "previous frame" input of Optical Flow, or +1 for the second frame of Frame Interpolation. Same trim/speed/loop as the Video node.',
  tags: ['video', 'previous frame', 'frame offset', 'delay', 'optical flow', 'interpolation', 'input'],
  inputs: {},
  params: {
    ...VIDEO_PARAMS,
    offset: { type: 'int', default: -1, min: -30, max: 30, step: 1, label: 'Frame offset', description: 'Source frames relative to the timeline time (−1 = previous frame).' },
  },
  volatile: 'time',
  size: videoSize,
  cpu: ({ params, getAsset, time }) => {
    const a = getAsset(String(params.asset ?? ''));
    const src = privateDecoder(a, 'offset');
    if (!src || !a) return { src: placeholder() };
    const fps = a.fps || 30;
    const start = Math.max(0, Number(params.start ?? 0) || 0);
    const t = Math.max(start, sourceTime(params, a, time ?? 0) + (Number(params.offset ?? -1) || 0) / fps);
    const f = src.frameSync(t);
    if (f) return { src: f };
    return src.frameAt(t, true).then((fr) => ({ src: fr ?? placeholder() }));
  },
  passes: [{ frag: SAMPLE_SRC + `void main(){ fragColor = vec4(sampleSrc(v_uv).rgb, 1.0); }` }],
});

export default [offsetNode] satisfies NodeDef[];
