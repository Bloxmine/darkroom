import { defineNode } from '../core/registry';
import type { NodeDef, RawTex } from '../core/types';
import { sourceTime, videoSource } from '../core/video';
import { getWebcam, WEBCAM_DEVICES, WEBCAM_RESOLUTIONS } from '../core/webcam';

/** Moving-image sources: video files and webcams. See docs/VIDEO.md. */

function placeholder(): RawTex {
  const w = 64, h = 36, d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, v = 40 + ((x + y) / (w + h)) * 60;
    d[i] = d[i + 1] = v; d[i + 2] = v + 12; d[i + 3] = 255;
  }
  return { width: w, height: h, data: d };
}

/** Sample u_src at the node's output size; box-filters when downscaling (video frames have no mipmaps). */
const SAMPLE = /* glsl */ `
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

const nodes: NodeDef[] = [
  defineNode({
    id: 'core.video',
    name: 'Video',
    category: 'Input',
    description: 'A video file (MP4, WebM, MOV…), decoded frame-accurately at the timeline time. Drop a video onto the canvas to create one.',
    tags: ['movie', 'clip', 'footage', 'mp4', 'webm', 'file', 'input'],
    color: '#4f8cff',
    inputs: {},
    params: {
      asset: { type: 'asset', default: '', label: 'Video', accept: 'video/*,.mp4,.m4v,.mov,.webm,.mkv' },
      start: { type: 'float', default: 0, min: 0, max: 3600, step: 0.01, label: 'Trim start (s)', description: 'Source time where the clip starts.' },
      end: { type: 'float', default: 0, min: 0, max: 3600, step: 0.01, label: 'Trim end (s)', description: 'Source time where the clip ends (0 = end of the file).' },
      speed: { type: 'float', default: 1, min: 0.05, max: 8, step: 0.01, label: 'Speed' },
      loop: { type: 'bool', default: true, label: 'Loop', description: 'Loop the clip; off = hold the last frame.' },
    },
    volatile: 'time',
    size: ({ params, getAsset, projectSize }) => {
      const a = getAsset(String(params.asset ?? ''));
      return a?.width && a.height ? [a.width, a.height] : [projectSize.width, projectSize.height];
    },
    cpu: ({ params, getAsset, time }) => {
      const a = getAsset(String(params.asset ?? ''));
      const src = videoSource(a);
      if (!src) return { src: placeholder() };
      const t = sourceTime(params, a, time ?? 0);
      const f = src.frameSync(t);
      if (f) return { src: f };
      return src.frameAt(t, true).then((fr) => ({ src: fr ?? placeholder() }));
    },
    passes: [{ frag: SAMPLE + `void main(){ fragColor = vec4(sampleSrc(v_uv).rgb, 1.0); }` }],
  }),
  defineNode({
    id: 'core.webcam',
    name: 'Webcam',
    category: 'Input',
    description: 'Live camera input (asks for camera permission). Renders continuously while present.',
    tags: ['camera', 'live', 'video', 'input', 'getusermedia'],
    color: '#4f8cff',
    inputs: {},
    params: {
      device: { type: 'enum', default: 'default', options: WEBCAM_DEVICES, label: 'Device', description: 'Which camera (in the order the browser lists them).' },
      resolution: { type: 'enum', default: '1280x720', options: WEBCAM_RESOLUTIONS, label: 'Resolution', description: 'Requested capture size (the camera may pick the nearest it supports).' },
      mirror: { type: 'bool', default: true, label: 'Mirror' },
    },
    volatile: 'live',
    size: ({ params }) => {
      const cam = getWebcam(String(params.device ?? 'default'), String(params.resolution ?? '1280x720'));
      if (cam.video.videoWidth) return [cam.video.videoWidth, cam.video.videoHeight];
      const [w, h] = String(params.resolution ?? '1280x720').split('x').map(Number);
      return [w || 1280, h || 720];
    },
    cpu: ({ params }) => {
      const cam = getWebcam(String(params.device ?? 'default'), String(params.resolution ?? '1280x720'));
      if (cam.error) throw new Error(`Webcam: ${cam.error}`);
      if (cam.video.readyState >= 2) return { src: cam.video };
      return cam.ready.then(() => ({ src: cam.video }));
    },
    passes: [{ frag: SAMPLE + `void main(){ vec2 uv = v_uv; if (u_mirror) uv.x = 1.0 - uv.x; fragColor = vec4(sampleSrc(uv).rgb, 1.0); }` }],
  }),
];

export default nodes;
