/**
 * Segmentation palettes for control.seg. The ControlNet seg model (control_v11p_sd15_seg) was trained on
 * ADE20K maps coloured with the mmseg / UniFormer ADE20K palette (150 classes, below — copied from
 * ControlNet-v1-1-nightly annotator/uniformer/mmseg/datasets/ade.py). Darkroom's scene model is DETR
 * panoptic (COCO panoptic categories), so each COCO category is mapped to the closest ADE20K class.
 * Pure data, unit-tested. Exports an empty NodeDef[] so the auto-registration glob is satisfied.
 */
import type { NodeDef } from '../../core/types';

export default [] as NodeDef[];

export const ADE20K_CLASSES = [
  'wall', 'building', 'sky', 'floor', 'tree', 'ceiling', 'road', 'bed', 'windowpane', 'grass', 'cabinet', 'sidewalk',
  'person', 'earth', 'door', 'table', 'mountain', 'plant', 'curtain', 'chair', 'car', 'water', 'painting', 'sofa',
  'shelf', 'house', 'sea', 'mirror', 'rug', 'field', 'armchair', 'seat', 'fence', 'desk', 'rock', 'wardrobe', 'lamp',
  'bathtub', 'railing', 'cushion', 'base', 'box', 'column', 'signboard', 'chest of drawers', 'counter', 'sand',
  'sink', 'skyscraper', 'fireplace', 'refrigerator', 'grandstand', 'path', 'stairs', 'runway', 'case', 'pool table',
  'pillow', 'screen door', 'stairway', 'river', 'bridge', 'bookcase', 'blind', 'coffee table', 'toilet', 'flower',
  'book', 'hill', 'bench', 'countertop', 'stove', 'palm', 'kitchen island', 'computer', 'swivel chair', 'boat',
  'bar', 'arcade machine', 'hovel', 'bus', 'towel', 'light', 'truck', 'tower', 'chandelier', 'awning', 'streetlight',
  'booth', 'television receiver', 'airplane', 'dirt track', 'apparel', 'pole', 'land', 'bannister', 'escalator',
  'ottoman', 'bottle', 'buffet', 'poster', 'stage', 'van', 'ship', 'fountain', 'conveyer belt', 'canopy', 'washer',
  'plaything', 'swimming pool', 'stool', 'barrel', 'basket', 'waterfall', 'tent', 'bag', 'minibike', 'cradle',
  'oven', 'ball', 'food', 'step', 'tank', 'trade name', 'microwave', 'pot', 'animal', 'bicycle', 'lake',
  'dishwasher', 'screen', 'blanket', 'sculpture', 'hood', 'sconce', 'vase', 'traffic light', 'tray', 'ashcan', 'fan',
  'pier', 'crt screen', 'plate', 'monitor', 'bulletin board', 'shower', 'radiator', 'glass', 'clock', 'flag',
];
export const ADE20K_PALETTE: [number, number, number][] = [
  [120, 120, 120], [180, 120, 120], [6, 230, 230], [80, 50, 50], [4, 200, 3], [120, 120, 80], [140, 140, 140],
  [204, 5, 255], [230, 230, 230], [4, 250, 7], [224, 5, 255], [235, 255, 7], [150, 5, 61], [120, 120, 70],
  [8, 255, 51], [255, 6, 82], [143, 255, 140], [204, 255, 4], [255, 51, 7], [204, 70, 3], [0, 102, 200],
  [61, 230, 250], [255, 6, 51], [11, 102, 255], [255, 7, 71], [255, 9, 224], [9, 7, 230], [220, 220, 220],
  [255, 9, 92], [112, 9, 255], [8, 255, 214], [7, 255, 224], [255, 184, 6], [10, 255, 71], [255, 41, 10],
  [7, 255, 255], [224, 255, 8], [102, 8, 255], [255, 61, 6], [255, 194, 7], [255, 122, 8], [0, 255, 20],
  [255, 8, 41], [255, 5, 153], [6, 51, 255], [235, 12, 255], [160, 150, 20], [0, 163, 255], [140, 140, 140],
  [250, 10, 15], [20, 255, 0], [31, 255, 0], [255, 31, 0], [255, 224, 0], [153, 255, 0], [0, 0, 255], [255, 71, 0],
  [0, 235, 255], [0, 173, 255], [31, 0, 255], [11, 200, 200], [255, 82, 0], [0, 255, 245], [0, 61, 255],
  [0, 255, 112], [0, 255, 133], [255, 0, 0], [255, 163, 0], [255, 102, 0], [194, 255, 0], [0, 143, 255],
  [51, 255, 0], [0, 82, 255], [0, 255, 41], [0, 255, 173], [10, 0, 255], [173, 255, 0], [0, 255, 153], [255, 92, 0],
  [255, 0, 255], [255, 0, 245], [255, 0, 102], [255, 173, 0], [255, 0, 20], [255, 184, 184], [0, 31, 255],
  [0, 255, 61], [0, 71, 255], [255, 0, 204], [0, 255, 194], [0, 255, 82], [0, 10, 255], [0, 112, 255], [51, 0, 255],
  [0, 194, 255], [0, 122, 255], [0, 255, 163], [255, 153, 0], [0, 255, 10], [255, 112, 0], [143, 255, 0],
  [82, 0, 255], [163, 255, 0], [255, 235, 0], [8, 184, 170], [133, 0, 255], [0, 255, 92], [184, 0, 255],
  [255, 0, 31], [0, 184, 255], [0, 214, 255], [255, 0, 112], [92, 255, 0], [0, 224, 255], [112, 224, 255],
  [70, 184, 160], [163, 0, 255], [153, 0, 255], [71, 255, 0], [255, 0, 163], [255, 204, 0], [255, 0, 143],
  [0, 255, 235], [133, 255, 0], [255, 0, 235], [245, 0, 255], [255, 0, 122], [255, 245, 0], [10, 190, 212],
  [214, 255, 0], [0, 204, 255], [20, 0, 255], [255, 255, 0], [0, 153, 255], [0, 41, 255], [0, 255, 204],
  [41, 0, 255], [41, 255, 0], [173, 0, 255], [0, 245, 255], [71, 0, 255], [122, 0, 255], [0, 255, 184], [0, 92, 255],
  [184, 255, 0], [0, 133, 255], [255, 214, 0], [25, 194, 194], [102, 255, 0], [92, 0, 255],
];

/**
 * COCO panoptic category id (DETR panoptic logits index) → ADE20K class name. Categories without a sensible
 * ADE20K counterpart are absent; their pixels take the best-scoring mapped class instead.
 */
export const COCO_TO_ADE: Record<number, string> = {
  // things
  1: 'person', 2: 'bicycle', 3: 'car', 4: 'minibike', 5: 'airplane', 6: 'bus', 7: 'bus', 8: 'truck', 9: 'boat',
  10: 'traffic light', 13: 'signboard', 14: 'pole', 15: 'bench',
  16: 'animal', 17: 'animal', 18: 'animal', 19: 'animal', 20: 'animal', 21: 'animal', 22: 'animal', 23: 'animal', 24: 'animal', 25: 'animal',
  27: 'bag', 28: 'canopy', 31: 'bag', 32: 'apparel', 33: 'bag', 34: 'plaything', 37: 'ball', 38: 'plaything', 40: 'apparel',
  44: 'bottle', 46: 'glass', 47: 'glass', 51: 'pot',
  52: 'food', 53: 'food', 54: 'food', 55: 'food', 56: 'food', 57: 'food', 58: 'food', 59: 'food', 60: 'food', 61: 'food',
  62: 'chair', 63: 'sofa', 64: 'plant', 65: 'bed', 67: 'table', 70: 'toilet', 72: 'television receiver', 73: 'computer',
  78: 'microwave', 79: 'oven', 81: 'sink', 82: 'refrigerator', 84: 'book', 85: 'clock', 86: 'vase', 88: 'plaything',
  // stuff (merged COCO panoptic stuff categories)
  92: 'flag', 93: 'blanket', 95: 'bridge', 100: 'box', 107: 'counter', 109: 'curtain', 112: 'door', 118: 'floor',
  119: 'flower', 122: 'food', 125: 'earth', 128: 'house', 130: 'light', 133: 'mirror', 141: 'pillow', 144: 'stage',
  145: 'field', 147: 'road', 148: 'river', 149: 'road', 151: 'building', 154: 'sand', 155: 'sea', 156: 'shelf', 159: 'earth',
  161: 'stairs', 166: 'tent', 168: 'towel', 171: 'wall', 175: 'wall', 176: 'wall', 177: 'wall', 178: 'water',
  180: 'blind', 181: 'windowpane', 184: 'tree', 185: 'fence', 186: 'ceiling', 187: 'sky', 188: 'cabinet', 189: 'table',
  190: 'floor', 191: 'sidewalk', 192: 'mountain', 193: 'grass', 194: 'earth', 196: 'food', 197: 'building', 198: 'rock',
  199: 'wall', 200: 'rug',
};

/** ADE20K class index (0..149) for a COCO panoptic category id, or -1. */
export function adeIndexOfCoco(id: number): number {
  const name = COCO_TO_ADE[id];
  return name ? ADE20K_CLASSES.indexOf(name) : -1;
}
