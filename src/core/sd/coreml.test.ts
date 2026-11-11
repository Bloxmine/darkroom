import { describe, expect, it } from 'vitest';
import type { CoreMLModelList } from '../../native/api';
import {
  buildCoreMLRequest,
  cleanIpcError,
  coremlScheduler,
  cropOutputSize,
  fitToModel,
  kindOf,
  resolveControlNet,
  resolveModel,
} from './coreml';
import { CATALOG_BASES, catalogControlNet, catalogInstallPath, catalogItem, catalogSelect, CONTROL_KINDS } from './coreml-catalog';
import { applyStyle, STYLE_NAMES } from './styles';
import type { GenSpec } from './types';

const list: CoreMLModelList = {
  models: [
    { id: 'darkroom:sd15-se', name: 'sd15-se', root: 'Darkroom', kind: 'sd15', attention: 'splitEinsum', width: 512, height: 512, controlNetSupport: true, img2img: true, bytes: 1, deletable: true },
    { id: 'darkroom:sd15-768', name: 'sd15-768', root: 'Darkroom', kind: 'sd15', attention: 'original', width: 768, height: 512, controlNetSupport: true, img2img: true, bytes: 1, deletable: true },
    { id: 'fabc:plain', name: 'plain', root: 'Mochi', kind: 'sd15', attention: 'original', width: 512, height: 512, controlNetSupport: false, img2img: false, bytes: 1, deletable: false },
    { id: 'fabc:xl', name: 'xl', root: 'Mochi', kind: 'sdxl', attention: 'original', width: 1024, height: 1024, controlNetSupport: false, img2img: true, bytes: 1, deletable: false },
  ],
  controlNets: [
    { id: 'darkroom:controlnet/Canny-SE.mlmodelc', name: 'Canny-SE', root: 'Darkroom', attention: 'splitEinsum', width: 512, height: 512, version: 'lllyasviel/control_v11p_sd15_canny', bytes: 1, deletable: true },
    { id: 'darkroom:controlnet/Canny-7x5.mlmodelc', name: 'Canny-7x5', root: 'Darkroom', attention: 'original', width: 768, height: 512, version: 'lllyasviel/control_v11p_sd15_canny', bytes: 1, deletable: true },
    { id: 'darkroom:controlnet/InPaint-SE.mlmodelc', name: 'InPaint-SE', root: 'Darkroom', attention: 'splitEinsum', width: 512, height: 512, version: 'lllyasviel/control_v11p_sd15_inpaint', bytes: 1, deletable: true },
  ],
};
const se = list.models[0];

describe('Core ML fitting', () => {
  it('letterbox keeps the whole source and crops the result back to its aspect', () => {
    const f = fitToModel(1600, 1067, 512, 512, 'letterbox');
    expect(f.draw.w).toBeCloseTo(512);
    expect(f.draw.h).toBeCloseTo(341.44, 1);
    expect(f.draw.y).toBeCloseTo(85.28, 1);
    expect(f.keep).toEqual({ x: 0, y: 85, w: 512, h: 342 });
    expect(f.aspect).toBeCloseTo(1600 / 1067);
  });
  it('letterbox for a portrait source pads left/right', () => {
    const f = fitToModel(600, 900, 512, 512, 'letterbox');
    expect(f.keep.y).toBe(0);
    expect(f.keep.h).toBe(512);
    expect(f.keep.x).toBe(85);
    expect(f.keep.w).toBe(342);
  });
  it('crop covers the frame and keeps all of the result; output = centre crop at the model aspect', () => {
    const f = fitToModel(1600, 1067, 512, 512, 'crop');
    expect(f.draw.h).toBeCloseTo(512);
    expect(f.draw.w).toBeCloseTo(767.77, 1);
    expect(f.draw.x).toBeCloseTo(-127.9, 1);
    expect(f.keep).toEqual({ x: 0, y: 0, w: 512, h: 512 });
    expect(f.aspect).toBe(1);
    expect(cropOutputSize(1600, 1067, 512, 512)).toEqual([1067, 1067]);
    expect(cropOutputSize(1600, 1067, 768, 512)).toEqual([1600, 1067]);
    expect(cropOutputSize(1000, 1000, 768, 512)).toEqual([1000, 667]);
  });
  it('stretch maps the whole frame both ways; a matching aspect is the identity', () => {
    expect(fitToModel(1600, 1067, 512, 512, 'stretch').keep).toEqual({ x: 0, y: 0, w: 512, h: 512 });
    expect(fitToModel(1536, 1024, 768, 512, 'letterbox').keep).toEqual({ x: 0, y: 0, w: 768, h: 512 });
  });
});

describe('Core ML model / ControlNet resolution', () => {
  it('picks the first ControlNet-capable SD model by default, skips SDXL', () => {
    expect(resolveModel('', list, true).id).toBe('darkroom:sd15-se');
    expect(resolveModel('plain', list, false).id).toBe('fabc:plain');
    expect(() => resolveModel('plain', list, true)).toThrow(/no ControlNet support/);
    expect(() => resolveModel('xl', list, false)).toThrow(/not installed/);
    expect(() => resolveModel('', { models: [], controlNets: [] }, false)).toThrow(/No Core ML/);
  });
  it('a kind keyword picks the variant matching the model', () => {
    expect(resolveControlNet('canny', se, list).name).toBe('Canny-SE');
    expect(resolveControlNet('canny', list.models[1], list).name).toBe('Canny-7x5');
    // a concrete but mismatched file falls back to the matching variant of the same kind
    expect(resolveControlNet('Canny-7x5', se, list).name).toBe('Canny-SE');
    expect(() => resolveControlNet('depth', se, list)).toThrow(/No depth ControlNet.*split-einsum/);
  });
  it('kindOf reads model card ids and file names', () => {
    expect(kindOf('lllyasviel/control_v11p_sd15s2_lineart_anime')).toBe('lineart_anime');
    expect(kindOf('LineArt-5x5')).toBe('lineart');
    expect(kindOf('lllyasviel/control_v11f1p_sd15_depth')).toBe('depth');
    expect(kindOf('NormalBAE-SE')).toBe('normalbae');
    expect(kindOf('Segmentation-SE')).toBe('seg');
    expect(kindOf('InstrP2P-SE')).toBe('ip2p');
    expect(kindOf('SoftEdge-SE')).toBe('softedge');
    expect(kindOf('foo')).toBeNull();
  });
});

describe('Core ML request builder', () => {
  const spec: GenSpec<Uint8Array> = {
    checkpoint: '', positive: 'a canoe', negative: 'blurry', steps: 20.4, cfg: 7.5, sampler: 'dpm++ karras', scheduler: '', seed: -5 >>> 0,
    width: 512, height: 512, denoise: 0.65, controls: [{ image: new Uint8Array([1]), model: 'canny', weight: 0.8, start: 0, end: 0.9 }],
  };
  const ctx = { jobId: 'j1', model: se, controlNets: [list.controlNets[0]], computeUnits: 'cpuAndNeuralEngine' as const, reduceMemory: false };
  it('txt2img + ControlNet', () => {
    const r = buildCoreMLRequest(spec, ctx);
    expect(r).toMatchObject({ jobId: 'j1', modelId: 'darkroom:sd15-se', computeUnits: 'cpuAndNeuralEngine', steps: 20, guidance: 7.5, scheduler: 'dpm++karras', prompt: 'a canoe' });
    expect(r.controls).toEqual([{ controlNetId: 'darkroom:controlnet/Canny-SE.mlmodelc', image: new Uint8Array([1]), weight: 0.8, start: 0, end: 0.9 }]);
    expect(r).not.toHaveProperty('init');
    expect(r).not.toHaveProperty('strength');
    expect(r.seed).toBe(4294967291);
  });
  it('img2img inpaint: strength, mask, and the inpaint ControlNet uses the masked-cond convention', () => {
    const r = buildCoreMLRequest(
      { ...spec, init: new Uint8Array([2]), mask: new Uint8Array([3]), denoise: 1.4, controls: [{ ...spec.controls[0], model: 'inpaint' }] },
      { ...ctx, controlNets: [list.controlNets[2]] },
    );
    expect(r.init).toEqual(new Uint8Array([2]));
    expect(r.mask).toEqual(new Uint8Array([3]));
    expect(r.strength).toBe(1);
    expect(r.controls[0]).toEqual({ controlNetId: 'darkroom:controlnet/InPaint-SE.mlmodelc', maskedCond: true, weight: 0.8, start: 0, end: 0.9 });
  });
  it('rejects a size other than the model’s', () => {
    expect(() => buildCoreMLRequest({ ...spec, width: 768 }, ctx)).toThrow(/512×512 only/);
  });
  it('maps samplers to the two Core ML schedulers', () => {
    expect(coremlScheduler('', '')).toBe('dpm++');
    expect(coremlScheduler('DPM++ 2M', 'Karras')).toBe('dpm++karras');
    expect(coremlScheduler('PLMS', '')).toBe('pndm');
    expect(coremlScheduler('euler', 'normal')).toBe('dpm++');
  });
  it('unwraps IPC errors', () => {
    expect(cleanIpcError(new Error("Error invoking remote method 'darkroom:coreml-generate': Error: [attentionMismatch] Use the SE ControlNets"))).toEqual({
      code: 'attentionMismatch',
      message: 'Use the SE ControlNets',
    });
  });
});

describe('styles', () => {
  it('appends curated snippets', () => {
    expect(STYLE_NAMES).toEqual(expect.arrayContaining(['oil painting', 'watercolor', 'anime cel', 'pencil sketch', 'cinematic photo', 'pixel art', 'riso print']));
    const s = applyStyle('pixel art', 'a canoe, ', 'blurry');
    expect(s.positive).toMatch(/^a canoe, pixel art/);
    expect(s.negative).toMatch(/^blurry, /);
    expect(applyStyle('none', 'a', 'b')).toEqual({ positive: 'a', negative: 'b' });
    expect(applyStyle('nope', 'a', 'b')).toEqual({ positive: 'a', negative: 'b' });
  });
});

describe('Core ML catalog', () => {
  it('every item is pinned to a 40-char commit and round-trips through its id', () => {
    for (const b of CATALOG_BASES) {
      expect(b.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(b.bytes).toBeGreaterThan(1.9e9);
      expect(b.bytes).toBeLessThan(2.1e9);
      expect(catalogItem(b.id)).toBe(b);
    }
    for (const k of CONTROL_KINDS) {
      const s = catalogControlNet(k, 'splitEinsum', 512, 512)!;
      expect(catalogItem(s.id)).toEqual(s);
      const o = catalogControlNet(k, 'original', 512, 768)!;
      expect(o.entry).toMatch(/-5x7$/);
      expect(catalogItem(o.id)).toEqual(o);
    }
    expect(catalogControlNet('canny', 'splitEinsum', 768, 512)).toBeNull();
    expect(catalogItem('cn-evil-se')).toBeNull();
    expect(catalogItem('../../etc')).toBeNull();
  });
  it('selects only the needed zip entries', () => {
    const base = catalogSelect(CATALOG_BASES[0]);
    expect(base('Stable-Diffusion-v1-5_split-einsum_cn/ControlledUnet.mlmodelc/weights/weight.bin')).toBe('ControlledUnet.mlmodelc/weights/weight.bin');
    expect(base('Stable-Diffusion-v1-5_split-einsum_cn/Unet.mlmodelc/weights/weight.bin')).toBeNull();
    expect(base('Stable-Diffusion-v1-5_split-einsum_cn/vocab.json')).toBe('vocab.json');
    const cn = catalogControlNet('canny', 'original', 768, 512)!;
    const sel = catalogSelect(cn);
    expect(sel('Canny/Canny-7x5.mlmodelc/weights/weight.bin')).toBe('weights/weight.bin');
    expect(sel('Canny/Canny-5x5.mlmodelc/weights/weight.bin')).toBeNull();
    expect(catalogInstallPath(cn)).toBe('controlnet/Canny-7x5.mlmodelc');
    expect(catalogSelect(catalogControlNet('canny', 'splitEinsum', 512, 512)!)('Canny-SE.mlmodelc/model.mil')).toBe('model.mil');
  });
});
