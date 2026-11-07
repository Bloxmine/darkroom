import { describe, expect, it } from 'vitest';
import { HAND_EDGES, handEdgeColor, limbColor, LIMB_SEQ, mediapipeToOpenpose, MESH_TO_FACE68, MP33_TO_OPENPOSE18, OPENPOSE_COLORS, OPENPOSE_KEYPOINTS } from './_openpose';
import { ADE20K_CLASSES, ADE20K_PALETTE, adeIndexOfCoco, COCO_TO_ADE } from './_palettes';
import { decodeMlsd } from './_mlsd';
import { detectDims } from './_shared';
import { genSize } from '../../core/sd/size';

describe('OpenPose mapping', () => {
  it('maps MediaPipe 33 to the OpenPose 18 COCO order', () => {
    expect(OPENPOSE_KEYPOINTS).toHaveLength(18);
    expect(MP33_TO_OPENPOSE18).toEqual([0, -1, 12, 14, 16, 11, 13, 15, 24, 26, 28, 23, 25, 27, 5, 2, 8, 7]);
    // MediaPipe 12 = right shoulder → OpenPose 2 RShoulder; 11 = left shoulder → 5 LShoulder
    expect(OPENPOSE_KEYPOINTS[MP33_TO_OPENPOSE18.indexOf(12)]).toBe('RShoulder');
    expect(OPENPOSE_KEYPOINTS[MP33_TO_OPENPOSE18.indexOf(11)]).toBe('LShoulder');
    expect(OPENPOSE_KEYPOINTS[MP33_TO_OPENPOSE18.indexOf(5)]).toBe('REye');
    expect(OPENPOSE_KEYPOINTS[MP33_TO_OPENPOSE18.indexOf(7)]).toBe('LEar');
  });

  it('puts the neck at the shoulder midpoint and drops invisible points', () => {
    const lm = new Float32Array(33 * 4);
    for (let i = 0; i < 33; i++) lm.set([i / 100, i / 50, 0, 1], i * 4);
    lm.set([0.4, 0.3, 0, 1], 11 * 4);
    lm.set([0.6, 0.5, 0, 1], 12 * 4);
    lm[28 * 4 + 3] = 0.1; // right ankle not visible
    const b = mediapipeToOpenpose(lm, 0.5);
    expect(b[1]![0]).toBeCloseTo(0.5);
    expect(b[1]![1]).toBeCloseTo(0.4);
    expect(b[2]).toEqual([expect.closeTo(0.6), expect.closeTo(0.5)]);
    expect(b[10]).toBeNull();
    lm[11 * 4 + 3] = 0;
    expect(mediapipeToOpenpose(lm, 0.5)[1]).toBeNull();
  });

  it('uses the standard limb sequence and colours', () => {
    expect(LIMB_SEQ).toHaveLength(17);
    expect(LIMB_SEQ[0]).toEqual([2, 3]); // neck → right shoulder
    expect(OPENPOSE_COLORS[0]).toEqual([255, 0, 0]);
    expect(OPENPOSE_COLORS[12]).toEqual([0, 0, 255]);
    expect(OPENPOSE_COLORS[17]).toEqual([255, 0, 85]);
    expect(limbColor(0)).toEqual([153, 0, 0]);
    expect(limbColor(1)).toEqual([153, 51, 0]);
    expect(limbColor(4)).toEqual([102, 153, 0]);
  });

  it('colours hand edges like matplotlib hsv_to_rgb', () => {
    expect(HAND_EDGES).toHaveLength(20);
    expect(handEdgeColor(0)).toEqual([255, 0, 0]);
    const c5 = handEdgeColor(5); // h = 0.25 → (127.5, 255, 0)
    expect(c5[0]).toBeCloseTo(127.5);
    expect(c5[1]).toBe(255);
    expect(c5[2]).toBe(0);
    const c10 = handEdgeColor(10); // h = 0.5 → cyan
    expect(c10).toEqual([0, 255, 255]);
  });

  it('has 68 face points', () => {
    expect(MESH_TO_FACE68).toHaveLength(68);
    expect(new Set(MESH_TO_FACE68).size).toBe(68);
    expect(Math.max(...MESH_TO_FACE68)).toBeLessThan(478);
  });
});

describe('segmentation palettes', () => {
  it('ADE20K palette matches the mmseg / ControlNet palette', () => {
    expect(ADE20K_CLASSES).toHaveLength(150);
    expect(ADE20K_PALETTE).toHaveLength(150);
    expect(ADE20K_PALETTE[ADE20K_CLASSES.indexOf('wall')]).toEqual([120, 120, 120]);
    expect(ADE20K_PALETTE[ADE20K_CLASSES.indexOf('sky')]).toEqual([6, 230, 230]);
    expect(ADE20K_PALETTE[ADE20K_CLASSES.indexOf('tree')]).toEqual([4, 200, 3]);
    expect(ADE20K_PALETTE[ADE20K_CLASSES.indexOf('person')]).toEqual([150, 5, 61]);
    expect(ADE20K_PALETTE[ADE20K_CLASSES.indexOf('grass')]).toEqual([4, 250, 7]);
    expect(ADE20K_PALETTE[149]).toEqual([92, 0, 255]); // flag
    for (const c of ADE20K_PALETTE) for (const v of c) expect(v >= 0 && v <= 255).toBe(true);
  });

  it('every COCO mapping names a real ADE20K class', () => {
    for (const [id, name] of Object.entries(COCO_TO_ADE)) expect(ADE20K_CLASSES.indexOf(name), `${id} → ${name}`).toBeGreaterThanOrEqual(0);
    expect(adeIndexOfCoco(187)).toBe(2); // sky-other-merged → sky
    expect(adeIndexOfCoco(1)).toBe(12); // person
    expect(adeIndexOfCoco(184)).toBe(4); // tree-merged → tree
    expect(adeIndexOfCoco(12)).toBe(-1); // unused id
  });
});

describe('preprocessor helpers', () => {
  it('detect resolution rounds like controlnet_aux resize_image', () => {
    expect(detectDims(1600, 1067, 512)).toEqual([768, 512]);
    expect(detectDims(1200, 1500, 512)).toEqual([512, 640]);
    expect(detectDims(100, 100, 512)).toEqual([512, 512]);
  });

  it('decodes M-LSD lines', () => {
    const w = 8, h = 8, n = w * h;
    const tp = new Float32Array(5 * n).fill(-10);
    const idx = 3 * w + 4; // centre (x 4, y 3)
    tp[idx] = 5;
    tp[n + idx] = -2; tp[2 * n + idx] = 0; tp[3 * n + idx] = 2; tp[4 * n + idx] = 1;
    const lines = decodeMlsd(tp, w, h, 0.1, 0.1);
    expect(lines).toHaveLength(1);
    expect(lines[0].slice(0, 4)).toEqual([4, 6, 12, 8]);
    expect(lines[0][4]).toBeGreaterThan(0.99);
  });

  it('generation size follows the input aspect in multiples of 64', () => {
    expect(genSize({ baseSize: '512', width: 0, height: 0 }, 1600 / 1067)).toEqual([768, 512]);
    expect(genSize({ baseSize: '1024', width: 0, height: 0 }, 0.8)).toEqual([1024, 1280]);
    expect(genSize({ baseSize: '512', width: 900, height: 0 }, 1.5)).toEqual([904, 600]);
    expect(genSize({ width: 513, height: 777 }, 1)).toEqual([512, 776]);
  });
});
