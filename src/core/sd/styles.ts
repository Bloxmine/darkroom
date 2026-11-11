/**
 * Curated prompt styles for sd.generate's `style` param (any backend; the Core ML restyle presets expose it).
 * Each style appends a positive snippet and a negative one; 'none' leaves the prompts alone.
 */
export const STYLES = {
  none: ['', ''],
  'oil painting': ['oil painting, visible impasto brush strokes, canvas texture, rich pigments, fine art', 'photo, photograph, smooth skin, 3d render, plastic'],
  watercolor: ['watercolor painting, soft transparent washes, wet-on-wet blooms, white paper showing through, delicate pigment', 'photo, photograph, hard edges, 3d render, oil paint'],
  'anime cel': ['anime cel shading, clean line art, flat colours, crisp shadows, studio anime key visual', 'photo, photorealistic, 3d render, painterly, blurry'],
  'pencil sketch': ['graphite pencil sketch, hatching and cross-hatching, sketchbook paper, monochrome drawing', 'colour, photo, painting, 3d render'],
  'cinematic photo': ['cinematic film still, 35mm, anamorphic lens, dramatic lighting, shallow depth of field, film grain, colour graded', 'cartoon, painting, illustration, drawing, oversaturated'],
  'pixel art': ['pixel art, 16-bit retro game style, limited palette, crisp square pixels, dithering', 'blurry, photo, smooth gradients, painting, anti-aliased'],
  'riso print': ['risograph print, two-colour riso, grainy halftone texture, slight misregistration, flat fluorescent inks on paper', 'photo, 3d render, smooth gradients, glossy'],
  'ink comic': ['black ink comic book art, bold outlines, halftone dots, dramatic inking, graphic novel panel', 'photo, blurry, painterly, 3d render'],
  'ukiyo-e': ['ukiyo-e woodblock print, Edo period, flat colour areas, fine outlines, washi paper texture', 'photo, 3d render, gradients, modern'],
  impressionist: ['impressionist painting, broken colour, dappled light, loose visible brushwork, plein air', 'photo, sharp details, 3d render, line art'],
  charcoal: ['charcoal drawing, smudged tones, expressive strokes, textured paper, high contrast', 'colour, photo, clean lines, 3d render'],
  'stained glass': ['stained glass window, bold lead lines, translucent jewel-toned glass, backlit', 'photo, blurry, soft gradients'],
  'low-poly 3d': ['low poly 3d render, faceted geometry, flat shaded polygons, soft studio lighting', 'photo, painting, sketch, noise'],
} as const satisfies Record<string, readonly [string, string]>;

export type StyleName = keyof typeof STYLES;
export const STYLE_NAMES = Object.keys(STYLES) as StyleName[];

const join = (a: string, b: string) => [a.trim().replace(/[,\s]+$/, ''), b].filter(Boolean).join(', ');

/** Apply a style to the prompts (pure). Unknown names behave like 'none'. */
export function applyStyle(style: string, positive: string, negative: string): { positive: string; negative: string } {
  const s = (STYLES as Record<string, readonly [string, string]>)[style];
  if (!s || !s[0]) return { positive, negative };
  return { positive: join(positive, s[0]), negative: join(negative, s[1]) };
}
