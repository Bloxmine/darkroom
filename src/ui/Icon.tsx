import { GROUP, GROUP_INPUT, GROUP_OUTPUT, IMAGE, OUTPUT } from '../core/graph';
import { getNodeDef } from '../core/registry';

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

/** Keyword → icon, matched against lower-cased category names (first hit wins). */
const CATEGORY_ICONS: [RegExp, string][] = [
  [/^input|source|load/, 'folder_image'],
  [/generat|pattern|procedur/, 'rainbow'],
  [/colou?r|grade|tone/, 'color_wheel'],
  [/curve/, 'chart_curve'],
  [/blur|filter|sharp|convol/, 'filter'],
  [/distort|warp|transform|geometr/, 'transform_rotate'],
  [/composit|blend|merge|layer|mix/, 'layers'],
  [/mask|matte|key/, 'layer_mask'],
  [/math|channel|expr/, 'math_functions'],
  [/util|misc|core/, 'cog'],
  [/text|type|font/, 'font'],
  [/light|glow|bloom|lens|optic/, 'lightbulb'],
  [/noise|grain/, 'draw_points'],
  [/stylize|stylise|artist|paint/, 'palette'],
  [/analog|analogue/, 'film_photo'],
  [/film/, 'film'],
  [/video|vhs|tape|broadcast/, 'vhs'],
  [/tv|crt|television|screen|display/, 'television'],
  [/camera|photo/, 'camera'],
  [/print|press|halftone/, 'printer'],
  [/retro|game|pixel|8.?bit/, 'joystick'],
  [/fun|toy/, 'emotion_happy'],
  [/digital|glitch/, 'computer'],
  [/preset/, 'star'],
];

export function categoryIcon(category: string): string {
  const c = category.toLowerCase();
  for (const [re, icon] of CATEGORY_ICONS) if (re.test(c)) return icon;
  return 'brick';
}

const TYPE_ICONS: Record<string, string> = {
  [IMAGE]: 'image',
  [OUTPUT]: 'monitor',
  [GROUP]: 'bricks',
  [GROUP_INPUT]: 'door_in',
  [GROUP_OUTPUT]: 'door_out',
};

export function nodeIcon(type: string): string {
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
