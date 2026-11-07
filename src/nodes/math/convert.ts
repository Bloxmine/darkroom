/**
 * Blender-style Converter nodes: Color Ramp, Float Curve, Separate/Combine Color (RGB/HSV/HSL),
 * Separate/Combine XYZ, RGB to BW, Blackbody, Wavelength, Value, Gamma, Bright/Contrast and
 * Hue/Saturation/Value.
 *
 * Float-valued inputs read an image through Blender's implicit colour → float conversion
 * (luminance), so grey masks pass through unchanged and colour images become their luminance.
 */
import { defineNode } from '../../core/registry';
import type { NodeDef, ParamDef, RawTex } from '../../core/types';
import { sampleCurve } from '../library/shared';
import {
  C_CONVERT, GLSL_BASE, GLSL_BLACKBODY, RAMP_HUE, RAMP_INTERP, RAMP_MAX, RAMP_MODES, WAVELENGTH_RGB,
  bakeRamp, hasDecl, hasInputs, rampFromParams,
} from './_shared';

const RAMP_DEFAULTS: number[][] = [
  [0, 0, 0, 1], [1, 1, 1, 1], [1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1], [1, 1, 0, 1], [0, 1, 1, 1], [1, 0, 1, 1],
];
const rampParams: Record<string, ParamDef> = {
  interpolation: { type: 'enum', default: 'Linear', options: RAMP_INTERP, label: 'Interpolation' },
  colorMode: { type: 'enum', default: 'RGB', options: RAMP_MODES, label: 'Color mode' },
  hueInterpolation: { type: 'enum', default: 'Near', options: RAMP_HUE, label: 'Hue interpolation', description: 'HSV / HSL modes only.' },
  count: { type: 'int', default: 2, min: 1, max: RAMP_MAX, step: 1, label: 'Stops' },
};
for (let i = 0; i < RAMP_MAX; i++) {
  rampParams['pos' + i] = { type: 'float', default: i === 0 ? 0 : i === 1 ? 1 : i / RAMP_MAX, min: 0, max: 1, step: 0.001, label: `Stop ${i + 1} position` };
  rampParams['color' + i] = { type: 'color', default: RAMP_DEFAULTS[i], label: `Stop ${i + 1} color` };
}

const colorIn = { color: { type: 'image' as const, label: 'Color' } };
const facIn = { fac: { type: 'mask' as const, label: 'Factor', optional: true } };
const facParam: ParamDef = { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Factor' };

const sepModes = ['RGB', 'HSV', 'HSL'];

export default [
  defineNode({
    id: 'convert.colorRamp',
    name: 'Color Ramp',
    category: 'Converter',
    description: "Blender's Color Ramp: maps a factor (luminance of the input) through up to 8 colour stops. Interpolation Constant / Linear / Ease / Cardinal / B-Spline; RGB, HSV or HSL blending with near/far/clockwise/counter-clockwise hue (HSV/HSL apply to Linear and Ease, as in Blender). Outputs the colour (with stop alpha) and the alpha as a mask.",
    tags: ['gradient', 'ramp', 'colorband', 'gradient map', 'lut', 'false color', 'blender', 'valtorgb'],
    color: C_CONVERT,
    inputs: { fac: { type: 'mask', label: 'Factor' } },
    outputs: { color: { type: 'image', label: 'Color' }, alpha: { type: 'mask', label: 'Alpha' } },
    params: rampParams,
    cpu: ({ params }) => {
      const ramp = rampFromParams(params);
      const tex: RawTex = { width: 256, height: 1, data: bakeRamp(ramp, 256), filter: ramp.interpolation === 'Constant' ? 'nearest' : 'linear' };
      return { ramp: tex };
    },
    passes: [
      {
        output: 'color',
        frag: /* glsl */ `
${GLSL_BASE}
void main(){ float f = bl_float(texture(u_fac, v_uv)); fragColor = texture(u_ramp, vec2((clamp(f, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)); }`,
      },
      { output: 'alpha', frag: `void main(){ float a = texture(u_pass0, v_uv).a; fragColor = vec4(a, a, a, 1.0); }` },
    ],
  }),

  defineNode({
    id: 'convert.floatCurve',
    name: 'Float Curve',
    category: 'Converter',
    description: "Blender's Float Curve: maps each RGB channel (0..1) through a curve, blended by Factor. Alpha is kept.",
    tags: ['curve', 'remap', 'tone', 'blender', 'rgb curves'],
    color: C_CONVERT,
    inputs: { value: { type: 'image', label: 'Value' }, ...facIn },
    params: {
      curve: { type: 'curve', default: [[0, 0], [1, 1]], label: 'Curve' },
      factor: facParam,
    },
    cpu: ({ params }) => {
      const c = sampleCurve(params.curve);
      const data = new Float32Array(256 * 4);
      for (let i = 0; i < 256; i++) data.set([c[i], c[i], c[i], 1], i * 4);
      const tex: RawTex = { width: 256, height: 1, data, filter: 'linear' };
      return { curve: tex };
    },
    passes: [{
      uniforms: hasInputs(['fac']),
      frag: /* glsl */ `
${hasDecl(['fac'])}
${GLSL_BASE}
float lut(float x) { return texture(u_curve, vec2((clamp(x, 0.0, 1.0) * 255.0 + 0.5) / 256.0, 0.5)).r; }
void main(){
  vec4 c = texture(u_value, v_uv);
  float f = u_hasFac > 0.5 ? bl_float(texture(u_fac, v_uv)) : u_factor;
  vec3 o = vec3(lut(c.r), lut(c.g), lut(c.b));
  fragColor = vec4(mix(c.rgb, o, f), c.a);
}` }],
  }),

  defineNode({
    id: 'convert.separateColor',
    name: 'Separate Color',
    category: 'Converter',
    description: "Blender's Separate Color: splits a colour into R/G/B, H/S/V or H/S/L masks (Blender's HSV/HSL conversions), plus alpha.",
    tags: ['split', 'channels', 'hsv', 'hsl', 'hue', 'saturation', 'blender', 'separate rgb'],
    color: C_CONVERT,
    inputs: colorIn,
    outputs: { r: { type: 'mask', label: 'R / H' }, g: { type: 'mask', label: 'G / S' }, b: { type: 'mask', label: 'B / V / L' }, a: { type: 'mask', label: 'Alpha' } },
    params: { mode: { type: 'enum', default: 'RGB', options: sepModes, label: 'Mode' } },
    passes: [
      {
        frag: /* glsl */ `
${GLSL_BASE}
void main(){
  vec4 c = texture(u_color, v_uv);
  vec3 o = u_mode == 1 ? bl_rgb2hsv(c.rgb) : u_mode == 2 ? bl_rgb2hsl(c.rgb) : c.rgb;
  fragColor = vec4(o, c.a);
}`,
      },
      ...['r', 'g', 'b', 'a'].map((ch) => ({ output: ch, frag: `void main(){ float v = texture(u_pass0, v_uv).${ch}; fragColor = vec4(v, v, v, 1.0); }` })),
    ],
  }),

  defineNode({
    id: 'convert.combineColor',
    name: 'Combine Color',
    category: 'Converter',
    description: "Blender's Combine Color: builds a colour from R/G/B, H/S/V or H/S/L masks (unconnected ones use the params), plus an optional alpha.",
    tags: ['merge', 'channels', 'hsv', 'hsl', 'blender', 'combine rgb'],
    color: C_CONVERT,
    inputs: {
      r: { type: 'mask', label: 'R / H', optional: true },
      g: { type: 'mask', label: 'G / S', optional: true },
      b: { type: 'mask', label: 'B / V / L', optional: true },
      a: { type: 'mask', label: 'Alpha', optional: true },
    },
    params: {
      mode: { type: 'enum', default: 'RGB', options: sepModes, label: 'Mode' },
      valueR: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'R / H' },
      valueG: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'G / S' },
      valueB: { type: 'float', default: 0, min: 0, max: 1, step: 0.01, label: 'B / V / L' },
      valueA: { type: 'float', default: 1, min: 0, max: 1, step: 0.01, label: 'Alpha' },
    },
    passes: [{
      uniforms: hasInputs(['r', 'g', 'b', 'a']),
      frag: /* glsl */ `
${hasDecl(['r', 'g', 'b', 'a'])}
${GLSL_BASE}
void main(){
  vec3 v = vec3(
    u_hasR > 0.5 ? bl_float(texture(u_r, v_uv)) : u_valueR,
    u_hasG > 0.5 ? bl_float(texture(u_g, v_uv)) : u_valueG,
    u_hasB > 0.5 ? bl_float(texture(u_b, v_uv)) : u_valueB);
  float a = u_hasA > 0.5 ? bl_float(texture(u_a, v_uv)) : u_valueA;
  vec3 o = u_mode == 1 ? bl_hsv2rgb(v) : u_mode == 2 ? bl_hsl2rgb(v) : v;
  fragColor = vec4(o, a);
}` }],
  }),

  defineNode({
    id: 'convert.separateXYZ',
    name: 'Separate XYZ',
    category: 'Converter',
    description: "Blender's Separate XYZ: splits a vector image (RGB = XYZ) into X, Y, Z float images (values are not clamped).",
    tags: ['split', 'vector', 'components', 'blender'],
    color: C_CONVERT,
    inputs: { vector: { type: 'image', label: 'Vector' } },
    outputs: { x: { type: 'mask', label: 'X' }, y: { type: 'mask', label: 'Y' }, z: { type: 'mask', label: 'Z' } },
    params: {},
    passes: (['x', 'y', 'z'] as const).map((ch) => ({ output: ch, frag: `void main(){ float v = texture(u_vector, v_uv).${ch}; fragColor = vec4(v, v, v, 1.0); }` })),
  }),

  defineNode({
    id: 'convert.combineXYZ',
    name: 'Combine XYZ',
    category: 'Converter',
    description: "Blender's Combine XYZ: builds a vector image from X, Y, Z float images (unconnected ones use the params).",
    tags: ['merge', 'vector', 'components', 'blender'],
    color: C_CONVERT,
    inputs: {
      x: { type: 'mask', label: 'X', optional: true },
      y: { type: 'mask', label: 'Y', optional: true },
      z: { type: 'mask', label: 'Z', optional: true },
    },
    params: {
      valueX: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'X' },
      valueY: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'Y' },
      valueZ: { type: 'float', default: 0, min: -10, max: 10, step: 0.01, label: 'Z' },
    },
    passes: [{
      uniforms: hasInputs(['x', 'y', 'z']),
      frag: /* glsl */ `
${hasDecl(['x', 'y', 'z'])}
${GLSL_BASE}
void main(){
  fragColor = vec4(
    u_hasX > 0.5 ? bl_float(texture(u_x, v_uv)) : u_valueX,
    u_hasY > 0.5 ? bl_float(texture(u_y, v_uv)) : u_valueY,
    u_hasZ > 0.5 ? bl_float(texture(u_z, v_uv)) : u_valueZ, 1.0);
}` }],
  }),

  defineNode({
    id: 'convert.rgbToBw',
    name: 'RGB to BW',
    category: 'Converter',
    description: "Blender's RGB to BW: luminance (Rec.709 weights 0.2126 / 0.7152 / 0.0722) as a float mask.",
    tags: ['greyscale', 'luminance', 'luma', 'black and white', 'blender'],
    color: C_CONVERT,
    inputs: colorIn,
    outputs: { out: { type: 'mask', label: 'Val' } },
    params: {},
    passes: [{ frag: `${GLSL_BASE}\nvoid main(){ float v = bl_float(texture(u_color, v_uv)); fragColor = vec4(v, v, v, 1.0); }` }],
  }),

  defineNode({
    id: 'convert.blackbody',
    name: 'Blackbody',
    category: 'Converter',
    description: "Blender's Blackbody: colour of a black body at a temperature in Kelvin (Cycles' fit, normalised to luminance 1, so values above 1 occur for warm/cool temperatures). Temperature from the optional input (pixel value in K) or the param. Output is sRGB-encoded unless Linear is on.",
    tags: ['kelvin', 'temperature', 'light', 'colour temperature', 'blender'],
    color: C_CONVERT,
    inputs: { temperature: { type: 'mask', label: 'Temperature', optional: true } },
    params: {
      kelvin: { type: 'float', default: 1500, min: 800, max: 12000, step: 10, label: 'Temperature (K)' },
      linear: { type: 'bool', default: false, label: 'Linear output' },
    },
    passes: [{
      uniforms: hasInputs(['temperature']),
      frag: /* glsl */ `
${hasDecl(['temperature'])}
${GLSL_BASE}
${GLSL_BLACKBODY}
void main(){
  float t = u_hasTemperature > 0.5 ? texture(u_temperature, v_uv).r : u_kelvin;
  vec3 c = bl_blackbody(t);
  fragColor = vec4(u_linear ? c : linearToSrgb(c), 1.0);
}` }],
  }),

  defineNode({
    id: 'convert.wavelength',
    name: 'Wavelength',
    category: 'Converter',
    description: "Blender's Wavelength: colour of monochromatic light (CIE 1931 table, 380–780 nm; black outside). Wavelength from the optional input (pixel value in nm) or the param. Output is sRGB-encoded unless Linear is on.",
    tags: ['spectrum', 'rainbow', 'nm', 'light', 'blender'],
    color: C_CONVERT,
    inputs: { wavelength: { type: 'mask', label: 'Wavelength', optional: true } },
    params: {
      nm: { type: 'float', default: 500, min: 380, max: 780, step: 1, label: 'Wavelength (nm)' },
      linear: { type: 'bool', default: false, label: 'Linear output' },
    },
    cpu: () => {
      const data = new Float32Array(81 * 4);
      WAVELENGTH_RGB.forEach((c, i) => data.set([c[0], c[1], c[2], 1], i * 4));
      const tex: RawTex = { width: 81, height: 1, data, filter: 'linear' };
      return { table: tex };
    },
    passes: [{
      uniforms: hasInputs(['wavelength']),
      frag: /* glsl */ `
${hasDecl(['wavelength'])}
void main(){
  float nm = u_hasWavelength > 0.5 ? texture(u_wavelength, v_uv).r : u_nm;
  float ii = (nm - 380.0) / 5.0;
  vec3 c = vec3(0.0);
  if (ii >= 0.0 && ii < 80.0) c = max(texture(u_table, vec2((ii + 0.5) / 81.0, 0.5)).rgb, 0.0);
  fragColor = vec4(u_linear ? c : linearToSrgb(c), 1.0);
}` }],
  }),

  defineNode({
    id: 'convert.value',
    name: 'Value',
    category: 'Converter',
    description: "Blender's Value node: a constant float image (every channel = Value, alpha 1) at the project size.",
    tags: ['constant', 'number', 'float', 'scalar', 'blender'],
    color: C_CONVERT,
    inputs: {},
    outputs: { out: { type: 'mask', label: 'Value' } },
    params: { value: { type: 'float', default: 0.5, min: -10, max: 10, step: 0.01, label: 'Value' } },
    passes: [{ frag: `void main(){ fragColor = vec4(vec3(u_value), 1.0); }` }],
  }),

  defineNode({
    id: 'convert.gamma',
    name: 'Gamma',
    category: 'Color',
    description: "Blender's Gamma node: pow(color, gamma) for positive channels (others unchanged). Gamma from the optional input or the param.",
    tags: ['power', 'gamma', 'midtones', 'blender'],
    color: C_CONVERT,
    inputs: { ...colorIn, gamma: { type: 'mask', label: 'Gamma', optional: true } },
    params: { gammaValue: { type: 'float', default: 1, min: 0.001, max: 10, step: 0.01, label: 'Gamma' } },
    passes: [{
      uniforms: hasInputs(['gamma']),
      frag: /* glsl */ `
${hasDecl(['gamma'])}
${GLSL_BASE}
void main(){
  vec4 c = texture(u_color, v_uv);
  float g = u_hasGamma > 0.5 ? bl_float(texture(u_gamma, v_uv)) : u_gammaValue;
  vec3 o = c.rgb;
  for (int i = 0; i < 3; i++) if (o[i] > 0.0) o[i] = pow(o[i], g);
  fragColor = vec4(o, c.a);
}` }],
  }),

  defineNode({
    id: 'convert.brightContrast',
    name: 'Bright/Contrast',
    category: 'Color',
    description: "Blender's Bright/Contrast node: max((1 + contrast)·c + brightness − contrast/2, 0).",
    tags: ['brightness', 'contrast', 'blender'],
    color: C_CONVERT,
    inputs: colorIn,
    params: {
      bright: { type: 'float', default: 0, min: -1, max: 1, step: 0.01, label: 'Bright' },
      contrast: { type: 'float', default: 0, min: -1, max: 2, step: 0.01, label: 'Contrast' },
    },
    passes: [{
      frag: /* glsl */ `
void main(){
  vec4 c = texture(u_color, v_uv);
  float a = 1.0 + u_contrast, b = u_bright - u_contrast * 0.5;
  fragColor = vec4(max(a * c.rgb + b, 0.0), c.a);
}` }],
  }),

  defineNode({
    id: 'convert.hueSatVal',
    name: 'Hue/Saturation/Value',
    category: 'Color',
    description: "Blender's Hue/Saturation/Value node: hue shift (0.5 = none), saturation and value multipliers in Blender's HSV, mixed by Factor.",
    tags: ['hue', 'saturation', 'value', 'hsv', 'blender'],
    color: C_CONVERT,
    inputs: { ...colorIn, ...facIn },
    params: {
      hue: { type: 'float', default: 0.5, min: 0, max: 1, step: 0.005, label: 'Hue' },
      saturation: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Saturation' },
      value: { type: 'float', default: 1, min: 0, max: 2, step: 0.01, label: 'Value' },
      factor: facParam,
    },
    passes: [{
      uniforms: hasInputs(['fac']),
      frag: /* glsl */ `
${hasDecl(['fac'])}
${GLSL_BASE}
void main(){
  vec4 c = texture(u_color, v_uv);
  float f = u_hasFac > 0.5 ? bl_float(texture(u_fac, v_uv)) : u_factor;
  vec3 hsv = bl_rgb2hsv(c.rgb);
  hsv.x = fract(hsv.x + u_hue + 0.5);
  hsv.y = clamp(hsv.y * u_saturation, 0.0, 1.0);
  hsv.z *= u_value;
  vec3 o = max(bl_hsv2rgb(hsv), 0.0);
  fragColor = vec4(mix(c.rgb, o, f), c.a);
}` }],
  }),
] satisfies NodeDef[];
