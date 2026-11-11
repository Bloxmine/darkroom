/**
 * Curated Core ML Stable Diffusion downloads for the built-in engine (Mac app). Pure data, imported by Electron main
 * (which does the downloading) and by Preferences › Generation (which lists it). Every file is pinned to a Hugging
 * Face commit; sizes are the bytes actually fetched (Darkroom extracts only the needed entries from each zip — see
 * electron/coreml/zipfetch.ts). Nothing here is bundled with the app.
 *
 * Base models must be converted with `--unet-support-controlnet` (a ControlledUnet.mlmodelc next to the Unet): the
 * coreml-community “_cn” conversions are. Darkroom's engine uses the ControlledUnet for everything (zero residuals
 * without ControlNet), so the plain Unet.mlmodelc (1.6 GB) is skipped.
 */

export type Attention = 'splitEinsum' | 'original';

export const OPENRAIL_URL = 'https://huggingface.co/spaces/CompVis/stable-diffusion-license';
export const OPENRAIL_NAME = 'CreativeML OpenRAIL-M';
/** Plain-language summary of the license's use restrictions (Attachment A), shown before every download. */
export const OPENRAIL_SUMMARY = [
  'You may use, share and modify the model and what you make with it, including commercially, but not:',
  '• to break any law or regulation, or to exploit or harm minors;',
  '• to generate or spread verifiably false information meant to harm others, or personal information to harm someone;',
  '• to defame, disparage or harass people, or to impersonate someone without their consent;',
  '• for fully automated decisions that affect people’s legal rights, or to discriminate against people or groups;',
  '• for medical advice or interpreting medical results, or to exploit anyone’s vulnerabilities.',
  'If you share the model, you must pass these same restrictions on. You are responsible for what you generate.',
];

export interface CatalogFile {
  repo: string;
  commit: string;
  /** Path of the zip inside the repo. */
  file: string;
  zipBytes: number;
}

export interface CatalogBase extends CatalogFile {
  id: string;
  name: string;
  description: string;
  attention: Attention;
  width: number;
  height: number;
  /** Bytes fetched (zip minus the skipped Unet.mlmodelc). */
  bytes: number;
  license: string;
  licenseUrl: string;
}

export const hfResolve = (f: CatalogFile) => `https://huggingface.co/${f.repo}/resolve/${f.commit}/${f.file.split('/').map(encodeURIComponent).join('/')}`;
export const hfPage = (f: CatalogFile) => `https://huggingface.co/${f.repo}/tree/${f.commit}`;

const SD15 = { repo: 'coreml-community/coreml-stable-diffusion-v1-5_cn', commit: '57b9414c88e33809d4c0d602c2307af8e2646f23' };
const DS8 = { repo: 'coreml-community/cormel-DreamShaper-v8_cn', commit: 'f8b91839c9da0a88486e18cc6cb146bd4dd9126c' };
const RV51 = { repo: 'coreml-community/coreml-realisticVision-v51VAE_cn', commit: '3977db78690c99dcac019ac8b19f846a5af30dc2' };
const lic = { license: OPENRAIL_NAME, licenseUrl: OPENRAIL_URL };
const UNET = 1_597_713_000; // the skipped plain Unet.mlmodelc (compressed)

export const CATALOG_BASES: CatalogBase[] = [
  {
    id: 'sd15-cn-split-einsum',
    name: 'Stable Diffusion 1.5 · Neural Engine · 512×512',
    description: 'The original SD 1.5 (RunwayML) converted for the Neural Engine, with ControlNet support. Fastest and coolest on Apple silicon; first use compiles for a few minutes.',
    attention: 'splitEinsum', width: 512, height: 512,
    ...SD15, file: 'split_einsum/stable-diffusion-_v1-5_split-einsum_cn.zip', zipBytes: 3_579_678_550, bytes: 3_579_678_550 - 1_597_783_408, ...lic,
  },
  {
    id: 'sd15-cn-original-512',
    name: 'Stable Diffusion 1.5 · GPU · 512×512',
    description: 'SD 1.5 with original attention for the GPU (cpuAndGPU), with ControlNet support. Use the non-SE ControlNets with it.',
    attention: 'original', width: 512, height: 512,
    ...SD15, file: 'original/stable-diffusion-_v1-5_original_cn.zip', zipBytes: 3_579_541_554, bytes: 3_579_541_554 - 1_597_713_336, ...lic,
  },
  {
    id: 'sd15-cn-original-768x512',
    name: 'Stable Diffusion 1.5 · GPU · 768×512 landscape',
    description: 'SD 1.5 for the GPU at 768×512 (3:2 landscape photos keep more detail than in a 512² letterbox).',
    attention: 'original', width: 768, height: 512,
    ...SD15, file: 'original/768x512/stable-diffusion-_v1-5_original_768x512_cn.zip', zipBytes: 3_579_544_471, bytes: 3_579_544_471 - 1_597_713_766, ...lic,
  },
  {
    id: 'sd15-cn-original-512x768',
    name: 'Stable Diffusion 1.5 · GPU · 512×768 portrait',
    description: 'SD 1.5 for the GPU at 512×768 (2:3 portrait).',
    attention: 'original', width: 512, height: 768,
    ...SD15, file: 'original/512x768/stable-diffusion-_v1-5_original_512x768_cn.zip', zipBytes: 3_579_540_964, bytes: 3_579_540_964 - UNET, ...lic,
  },
  {
    id: 'dreamshaper8-cn-split-einsum',
    name: 'DreamShaper 8 · Neural Engine · 512×512',
    description: 'A popular general-purpose SD 1.5 fine-tune (illustration, fantasy, portraits), split-einsum with ControlNet support.',
    attention: 'splitEinsum', width: 512, height: 512,
    ...DS8, file: 'split_einsum/DreamShaper-v8_split-einsum_cn.zip', zipBytes: 3_578_375_753, bytes: 3_578_375_753 - 1_597_628_999, ...lic,
  },
  {
    id: 'dreamshaper8-cn-original-512',
    name: 'DreamShaper 8 · GPU · 512×512',
    description: 'DreamShaper 8 with original attention for the GPU, with ControlNet support.',
    attention: 'original', width: 512, height: 512,
    ...DS8, file: 'original/DreamShaper-v8_original_cn.zip', zipBytes: 3_578_242_093, bytes: 3_578_242_093 - 1_597_562_171, ...lic,
  },
  {
    id: 'realisticvision51-cn-split-einsum',
    name: 'Realistic Vision 5.1 · Neural Engine · 512×512',
    description: 'A photorealistic SD 1.5 fine-tune (baked VAE), split-einsum with ControlNet support.',
    attention: 'splitEinsum', width: 512, height: 512,
    ...RV51, file: 'split_einsum/realisticVision-v51VAE_split-einsum_cn.zip', zipBytes: 3_579_089_329, bytes: 3_579_089_329 - 1_597_794_416, ...lic,
  },
  {
    id: 'realisticvision51-cn-original-512',
    name: 'Realistic Vision 5.1 · GPU · 512×512',
    description: 'Realistic Vision 5.1 with original attention for the GPU, with ControlNet support.',
    attention: 'original', width: 512, height: 512,
    ...RV51, file: 'original/realisticVision-v51VAE_original_cn.zip', zipBytes: 3_578_955_548, bytes: 3_578_955_548 - 1_597_727_797, ...lic,
  },
];

/** ControlNet 1.1 kinds (lllyasviel/control_v11*_sd15_*), in the order the model manager lists them. */
export const CONTROL_KINDS = [
  'canny', 'depth', 'softedge', 'lineart', 'lineart_anime', 'openpose', 'scribble', 'tile', 'seg', 'normalbae', 'inpaint', 'mlsd', 'shuffle', 'ip2p',
] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];

export const CONTROL_LABELS: Record<ControlKind, string> = {
  canny: 'Canny edges', depth: 'Depth', softedge: 'Soft edge (HED / PiDiNet)', lineart: 'Line art', lineart_anime: 'Line art (anime)',
  openpose: 'OpenPose', scribble: 'Scribble', tile: 'Tile (detail / upscale)', seg: 'Segmentation (ADE20K)', normalbae: 'Normal map (BAE)',
  inpaint: 'Inpaint', mlsd: 'M-LSD straight lines', shuffle: 'Shuffle (content reshuffle)', ip2p: 'Instruct Pix2Pix',
};

/** The darkroom preprocessor node that makes the map each ControlNet expects (standard conventions). */
export const CONTROL_PREPROCESSOR: Partial<Record<ControlKind, string>> = {
  canny: 'control.canny', depth: 'control.depth', softedge: 'control.softEdge', lineart: 'control.lineart', lineart_anime: 'control.lineart',
  openpose: 'control.openpose', scribble: 'control.scribble', tile: 'control.tile', seg: 'control.seg', normalbae: 'control.normal',
  inpaint: 'control.inpaintMask', mlsd: 'control.mlsd', shuffle: 'control.shuffle',
};

const CN_REPO = { repo: 'coreml-community/ControlNet-Models-For-Core-ML', commit: '2a21985be1700534a439ce89fbd7115735b6df92' };
/** Zip base names in CN/ (…-SE.zip holds one split-einsum 512² model; ….zip holds original 5x5, 5x7, 7x5, 7x7). */
const CN_ZIP: Record<ControlKind, string> = {
  canny: 'Canny', depth: 'Depth', softedge: 'SoftEdge', lineart: 'LineArt', lineart_anime: 'LineArtAnime', openpose: 'OpenPose', scribble: 'Scribble',
  tile: 'Tile', seg: 'Segmentation', normalbae: 'NormalBAE', inpaint: 'InPaint', mlsd: 'MLSD', shuffle: 'Shuffle', ip2p: 'InstrP2P',
};
/** Measured: every ControlNet is ~671 MB compressed, whichever variant. */
const CN_BYTES = 671_100_000;
const CN_ORIG_ZIP: Record<ControlKind, number> = {
  canny: 2_684_325_569, depth: 2_684_218_740, softedge: 2_684_336_802, lineart: 2_684_293_415, lineart_anime: 2_684_199_067, openpose: 2_684_102_380,
  scribble: 2_684_261_674, tile: 2_684_254_127, seg: 2_684_145_727, normalbae: 2_684_235_562, inpaint: 2_684_233_492, mlsd: 2_684_251_908,
  shuffle: 2_684_202_842, ip2p: 2_684_219_194,
};
const CN_SE_ZIP: Record<ControlKind, number> = {
  canny: 671_106_215, depth: 671_079_289, softedge: 671_107_728, lineart: 671_097_331, lineart_anime: 671_074_052, openpose: 671_050_285,
  scribble: 671_090_030, tile: 671_088_313, seg: 671_060_663, normalbae: 671_083_451, inpaint: 671_083_141, mlsd: 671_087_608,
  shuffle: 671_075_244, ip2p: 671_079_254,
};

export interface CatalogControlNet extends CatalogFile {
  id: string;
  kind: ControlKind;
  attention: Attention;
  width: number;
  height: number;
  /** The `<name>.mlmodelc` folder inside the zip (and the name it is installed as). */
  entry: string;
  bytes: number;
  license: string;
  licenseUrl: string;
}

const RES_CODE = (w: number, h: number) => `${w === 768 ? 7 : 5}x${h === 768 ? 7 : 5}`;

/**
 * The ControlNet download matching a base model's attention variant and resolution, or null if none exists
 * (split-einsum ControlNets are 512² only; originals exist at 512/768 in each direction).
 */
export function catalogControlNet(kind: ControlKind, attention: Attention, width: number, height: number): CatalogControlNet | null {
  const z = CN_ZIP[kind];
  if (attention === 'splitEinsum') {
    if (width !== 512 || height !== 512) return null;
    return { id: `cn-${kind}-se`, kind, attention, width, height, ...CN_REPO, file: `CN/${z}-SE.zip`, zipBytes: CN_SE_ZIP[kind], entry: `${z}-SE`, bytes: CN_BYTES, ...lic };
  }
  if (![512, 768].includes(width) || ![512, 768].includes(height)) return null;
  const code = RES_CODE(width, height);
  return { id: `cn-${kind}-${code}`, kind, attention, width, height, ...CN_REPO, file: `CN/${z}.zip`, zipBytes: CN_ORIG_ZIP[kind], entry: `${z}-${code}`, bytes: CN_BYTES, ...lic };
}

/** Catalog id → download description (base or ControlNet), used by Electron main to validate renderer requests. */
export function catalogItem(id: string): CatalogBase | CatalogControlNet | null {
  const b = CATALOG_BASES.find((x) => x.id === id);
  if (b) return b;
  const m = /^cn-([a-z0-9_]+)-(se|[57]x[57])$/.exec(id);
  if (!m || !(CONTROL_KINDS as readonly string[]).includes(m[1])) return null;
  const kind = m[1] as ControlKind;
  if (m[2] === 'se') return catalogControlNet(kind, 'splitEinsum', 512, 512);
  const [a, b2] = m[2].split('x').map((d) => (d === '7' ? 768 : 512));
  return catalogControlNet(kind, 'original', a, b2);
}

/** Which zip entries to install, relative to the install folder (null = skip). */
export function catalogSelect(item: CatalogBase | CatalogControlNet): (name: string) => string | null {
  if ('entry' in item) {
    const marker = `${item.entry}.mlmodelc/`;
    return (name) => {
      const i = name.indexOf(marker);
      if (i < 0 || (i > 0 && name[i - 1] !== '/')) return null;
      return name.slice(i + marker.length) || null;
    };
  }
  return (name) => {
    const rest = name.split('/').slice(1).join('/'); // strip the zip's top folder
    if (!rest || rest.startsWith('Unet.mlmodelc/') || rest.startsWith('UnetChunk') || rest.startsWith('SafetyChecker.mlmodelc/')) return null;
    return rest;
  };
}

/** Folder (relative to the Darkroom models folder) an item installs into. */
export const catalogInstallPath = (item: CatalogBase | CatalogControlNet) => ('entry' in item ? `controlnet/${item.entry}.mlmodelc` : item.id);
