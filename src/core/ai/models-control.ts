/**
 * Models used only by the ControlNet preprocessor nodes (src/nodes/control), registered into the shared
 * catalog. The other control nodes reuse models that are already registered (Depth Anything V2, MoGe-2,
 * Informative Drawings, DETR panoptic, MediaPipe Pose). Licences/attribution: docs/CONTROLNET.md.
 */
import { registerModel } from './models';

const hf = (repo: string, sha: string, file: string) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`;

const MLSD_REPO = 'mlboydaisuke/M-LSD-tiny-OpenVINO';
const MLSD_SHA = 'db488937a8c23fa5f2f6b59f5be70b5044960deb';

registerModel({
  id: 'mlsd-tiny',
  name: 'M-LSD tiny (straight lines)',
  task: 'line-art',
  licence: 'Apache-2.0',
  page: `https://huggingface.co/${MLSD_REPO}`,
  credit: 'M-LSD (Gu et al., AAAI 2022, NAVER), tiny model; converted from the LiteRT export (litert-community) to ONNX by mlboydaisuke',
  // fp32 weights despite the file name. Fixed input [1,4,512,512] (RGB + ones, x/127.5 − 1);
  // output [1,9,256,256] = upstream tpMap[:, 7:]: ch0 centre logits, ch1–4 start/end displacement.
  files: [{ precision: 'fp32', url: hf(MLSD_REPO, MLSD_SHA, 'mlsd_fp16.onnx'), bytes: 2637523 }],
});

/** MediaPipe Hand Landmarker (21 points per hand, the same order as the OpenPose hand model). Run via core/ai/mediapipe getTask(). */
export const MP_HAND = {
  id: 'mp-hand-landmarker',
  name: 'MediaPipe Hand Landmarker',
  url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  bytes: 7819105,
};
registerModel({
  id: MP_HAND.id,
  name: MP_HAND.name,
  task: 'pose',
  licence: 'Apache-2.0',
  page: 'https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker',
  credit: 'MediaPipe Hand Landmarker: palm detector + 21 hand landmarks (Google)',
  files: [{ precision: 'fp16', url: MP_HAND.url, bytes: MP_HAND.bytes }],
  external: true,
});
