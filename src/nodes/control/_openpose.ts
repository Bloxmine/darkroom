/**
 * OpenPose rendering conventions (controlnet_aux `open_pose/util.py`, as used by sd-webui-controlnet and
 * ComfyUI) and the MediaPipe → OpenPose keypoint mapping. Pure data/functions, unit-tested.
 * Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

/** OpenPose BODY-18 (COCO) keypoint names, in order. */
export const OPENPOSE_KEYPOINTS = [
  'Nose', 'Neck', 'RShoulder', 'RElbow', 'RWrist', 'LShoulder', 'LElbow', 'LWrist',
  'RHip', 'RKnee', 'RAnkle', 'LHip', 'LKnee', 'LAnkle', 'REye', 'LEye', 'REar', 'LEar',
] as const;

/** `limbSeq` (1-based, as upstream). Limb i is drawn in COLORS[i] × 0.6. */
export const LIMB_SEQ: [number, number][] = [
  [2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10],
  [10, 11], [2, 12], [12, 13], [13, 14], [2, 1], [1, 15], [15, 17], [1, 16], [16, 18],
];

/** The 18 standard colours (RGB). Joint k is drawn in COLORS[k]; limb i in COLORS[i] × 0.6. */
export const OPENPOSE_COLORS: [number, number, number][] = [
  [255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0],
  [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255],
  [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85],
];

/** Limb colour as upstream: `int(float(c) * 0.6)`. */
export const limbColor = (i: number): [number, number, number] => OPENPOSE_COLORS[i].map((c) => Math.floor(c * 0.6)) as [number, number, number];

/**
 * MediaPipe Pose (33) index for each OpenPose keypoint; -1 = Neck (midpoint of the shoulders).
 * MediaPipe "left" = the person's left = OpenPose "L".
 */
export const MP33_TO_OPENPOSE18 = [0, -1, 12, 14, 16, 11, 13, 15, 24, 26, 28, 23, 25, 27, 5, 2, 8, 7];

/** One person: 18 keypoints, normalised (x, y) or null when missing / not visible enough. */
export type Body18 = ([number, number] | null)[];

/** MediaPipe 33 × (x, y, z, visibility) → OpenPose 18 keypoints. */
export function mediapipeToOpenpose(lm: ArrayLike<number>, minVisibility = 0.5): Body18 {
  const pt = (i: number): [number, number] | null => {
    const x = lm[i * 4], y = lm[i * 4 + 1], v = lm[i * 4 + 3];
    if (!(v >= minVisibility) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [x, y];
  };
  return MP33_TO_OPENPOSE18.map((m) => {
    if (m >= 0) return pt(m);
    const l = pt(11), r = pt(12);
    return l && r ? [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2] : null;
  });
}

/** OpenPose hand edges (21 points: wrist, then 4 per finger), coloured by HSV hue ie/len(edges). */
export const HAND_EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [0, 9], [9, 10],
  [10, 11], [11, 12], [0, 13], [13, 14], [14, 15], [15, 16], [0, 17], [17, 18], [18, 19], [19, 20],
];

/** matplotlib hsv_to_rgb([h, 1, 1]) × 255 (what draw_handpose uses). */
export function handEdgeColor(i: number): [number, number, number] {
  const h = (i / HAND_EDGES.length) * 6;
  const k = (n: number) => {
    const t = (n + h) % 6;
    return 255 * (1 - Math.max(0, Math.min(1, Math.min(t, 4 - t))));
  };
  return [k(5), k(3), k(1)];
}

/**
 * MediaPipe Face Mesh (478) indices approximating the 68 dlib / OpenPose face points:
 * jaw 0–16, brows 17–26, nose 27–35, eyes 36–47, mouth 48–67. OpenPose draws them as white dots.
 */
export const MESH_TO_FACE68 = [
  // jaw, from the person's right ear (image left) over the chin
  234, 93, 132, 58, 172, 136, 150, 176, 152, 400, 379, 365, 397, 288, 361, 323, 454,
  // right brow, left brow
  70, 63, 105, 66, 107, 336, 296, 334, 293, 300,
  // nose bridge, nostrils
  168, 197, 5, 4, 98, 97, 2, 326, 327,
  // right eye, left eye
  33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380,
  // outer lips, inner lips
  61, 40, 37, 0, 267, 270, 291, 321, 314, 17, 84, 91, 78, 81, 13, 311, 308, 402, 14, 178,
];
