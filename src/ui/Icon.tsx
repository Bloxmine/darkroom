import { GROUP, GROUP_INPUT, GROUP_OUTPUT, IMAGE, OUTPUT } from '../core/graph';
import { getNodeDef, listPresets } from '../core/registry';

/** A FatCow Farm-Fresh icon (CC BY 3.0) from public/icons/fatcow. */
export function Icon({ name, size = 16, title, className }: { name: string; size?: 16 | 32; title?: string; className?: string }) {
  return (
    <img
      className={'icon' + (className ? ' ' + className : '')}
      src={`/icons/fatcow/${size}x${size}/${name}.png`}
      width={size}
      height={size}
      alt=""
      title={title}
      draggable={false}
    />
  );
}

/**
 * One distinct icon per category (exact, case-insensitive). Every built-in node and preset category
 * is listed so no two categories share an icon.
 */
const CATEGORY_ICON: Record<string, string> = {
  // sources & structure
  input: 'folder_image',
  utility: 'cog',
  custom: 'script_code',
  // colour
  color: 'color_wheel',
  'color management': 'color_management',
  // filters & geometry
  filter: 'filter',
  distort: 'draw_wave',
  transform: 'transform_rotate',
  lens: 'camera_lens',
  optical: 'weather_sun',
  // compositing & masks
  composite: 'layers',
  mix: 'arrow_join',
  mask: 'layer_mask',
  local: 'draw_airbrush',
  // Blender-style math & procedural
  math: 'math_functions',
  vector: 'vector',
  converter: 'arrow_switch',
  texture: 'draw_spiral',
  procedural: 'rainbow',
  // looks
  stylize: 'palette',
  artistic: 'paintbrush',
  analog: 'film_photo',
  camera: 'camera',
  photo: 'photos',
  process: 'flask',
  print: 'printer',
  retro: 'joystick',
  fun: 'emotion_happy',
  video: 'vhs',
  motion: 'film_go',
  pro: 'medal_gold_blue',
  // AI & generation
  ai: 'brain',
  controlnet: 'node_design',
  generation: 'magic_wand_2',
  // presets
  'my presets': 'star',
  presets: 'award_star_gold_blue',
};

/** Fallback keywords for categories not listed above (e.g. from plugins). */
const CATEGORY_KEYWORDS: [RegExp, string][] = [
  [/^input|source|load/, 'folder_image'],
  [/generat|diffusion|\bsd\b/, 'magic_wand_2'],
  [/colou?r|grade|tone|lut/, 'color_wheel'],
  [/blur|filter|sharp|convol/, 'filter'],
  [/composit|blend|merge|layer/, 'layers'],
  [/mask|matte|key/, 'layer_mask'],
  [/\bai\b|neural|model/, 'brain'],
  [/video|vhs|tape/, 'vhs'],
  [/print|halftone/, 'printer'],
];

/** Spare icons for unknown categories: picked by a stable hash so each keeps the same icon. */
const SPARE_ICONS = ['ruby', 'diamond', 'rocket', 'lightning', 'crown_gold', 'draw_star', 'sitemap', 'hammer', 'cd', 'speedometer', 'draw_ink', 'pencil_ruler'];

export function categoryIcon(category: string): string {
  const c = category.trim().toLowerCase();
  if (CATEGORY_ICON[c]) return CATEGORY_ICON[c];
  for (const [re, icon] of CATEGORY_KEYWORDS) if (re.test(c)) return icon;
  if (!c) return 'brick';
  let h = 0;
  for (let i = 0; i < c.length; i++) h = (h * 31 + c.charCodeAt(i)) >>> 0;
  return SPARE_ICONS[h % SPARE_ICONS.length];
}

const TYPE_ICONS: Record<string, string> = {
  [IMAGE]: 'image',
  'core.raw': 'camera',
  [OUTPUT]: 'monitor',
  [GROUP]: 'bricks',
  [GROUP_INPUT]: 'door_in',
  [GROUP_OUTPUT]: 'door_out',
};

/** Icon for a node type; pass the node itself so preset groups get their category's icon. */
export function nodeIcon(type: string, node?: { group?: { category?: string; name?: string } }): string {
  if (type === GROUP && node?.group) {
    // older projects: find the preset this group was made from by name
    const cat = node.group.category ?? listPresets().find((p) => p.name === node.group!.name || p.group.name === node.group!.name)?.category;
    if (cat) return categoryIcon(cat);
  }
  return TYPE_ICONS[type] ?? categoryIcon(getNodeDef(type)?.category ?? '');
}

/** Per-category accent colours (used when a def has no `color`). Muted, 2000s-pro. */
const CATEGORY_COLORS: [RegExp, string][] = [
  [/^input|source/, '#5b7fb5'],
  [/generat|pattern/, '#7a6aa8'],
  [/colou?r|grade|tone|curve/, '#b0894a'],
  [/blur|filter|sharp/, '#5d8f7a'],
  [/distort|warp|transform/, '#8a6d9e'],
  [/composit|blend|merge|layer|mask/, '#4f8a96'],
  [/math|channel|util|core/, '#7d7d7d'],
  [/stylize|paint|print|halftone/, '#a0645f'],
  [/analog|film|video|vhs|tv|crt|camera/, '#9a5a7c'],
  [/light|glow|lens/, '#b39a3c'],
  [/noise|grain/, '#6f7d55'],
];

export function categoryColor(category: string): string {
  const c = category.toLowerCase();
  for (const [re, col] of CATEGORY_COLORS) if (re.test(c)) return col;
  return '#6e7f8f';
}

export function nodeColor(type: string): string {
  if (type === GROUP) return '#8f7a52';
  if (type === GROUP_INPUT || type === GROUP_OUTPUT) return '#6c6c6c';
  const def = getNodeDef(type);
  return def?.color ?? categoryColor(def?.category ?? '');
}
