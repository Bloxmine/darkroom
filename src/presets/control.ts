/**
 * ControlNet presets (src/nodes/control): a contact sheet of control maps, and two graphs that send maps to
 * your own Stable Diffusion server (Preferences › Generation; nothing is sent until you press Generate).
 * The ControlNet model names are the standard ControlNet 1.1 SD 1.5 file names; pick yours from the list
 * under Generate (Test connection) if they differ.
 */
import { GraphBuilder } from '../core/graph';
import type { PresetDef } from '../core/types';

const CN_DEPTH = 'control_v11f1p_sd15_depth.pth';
const CN_CANNY = 'control_v11p_sd15_canny.pth';
const CN_OPENPOSE = 'control_v11p_sd15_openpose.pth';

/** Expose the sd.generate knobs every generation preset shares (incl. the hidden run token for the Generate button). */
function exposeGenerate(b: GraphBuilder, gen: string, units: number) {
  b.expose('positive', gen, 'positive', 'Prompt')
    .expose('negative', gen, 'negative', 'Negative prompt')
    .expose('checkpoint', gen, 'checkpoint', 'Checkpoint')
    .expose('seed', gen, 'seed', 'Seed')
    .expose('steps', gen, 'steps', 'Steps')
    .expose('cfg', gen, 'cfg', 'CFG scale');
  for (let i = 1; i <= units; i++) b.expose(`cn${i}Model`, gen, `cn${i}Model`, `ControlNet ${i} model`).expose(`cn${i}Weight`, gen, `cn${i}Weight`, `ControlNet ${i} weight`);
  b.expose('autoRun', gen, 'autoRun', 'Auto-run').expose('run', gen, 'run', 'Run token', { hidden: true });
}

function allMaps(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const canny = b.node('control.canny', {}, { image: img });
  const depth = b.node('control.depth', {}, { image: img });
  const normal = b.node('control.normal', {}, { image: img });
  const soft = b.node('control.softEdge', {}, { image: img });
  const pose = b.node('control.openpose', {}, { image: img });
  const seg = b.node('control.seg', {}, { image: img });
  const sheet = b.node(
    'control.sheet',
    { label1: 'Canny', label2: 'Depth', label3: 'Normal (BAE)', label4: 'Soft edge', label5: 'OpenPose', label6: 'Segmentation (ADE20K)', cellWidth: 640 },
    { map1: canny, map2: depth, map3: normal, map4: soft, map5: pose, map6: seg },
  );
  b.output('out', sheet);
  b.expose('resolution', canny, 'resolution', 'Canny detect resolution')
    .expose('low', canny, 'lowThreshold', 'Canny low')
    .expose('high', canny, 'highThreshold', 'Canny high')
    .expose('softStyle', soft, 'mode', 'Soft edge style')
    .expose('pose', pose, 'preprocessor', 'OpenPose mode')
    .expose('columns', sheet, 'columns', 'Columns')
    .expose('cellWidth', sheet, 'cellWidth', 'Cell width');
  return {
    id: 'control.allMaps',
    name: 'All Control Maps',
    category: 'ControlNet',
    tags: ['controlnet', 'control sheet', 'canny', 'depth', 'normal', 'softedge', 'openpose', 'segmentation', 'preview', 'stable diffusion'],
    description:
      'One photo → a labelled sheet of the six most used ControlNet maps: canny, depth, normal (BAE), soft edge, OpenPose and ADE20K segmentation. ' +
      'Open the group to take any single map out. The model-based maps run locally and download once.',
    group: b.toGroup('All Control Maps'),
  };
}

function restyle(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const depth = b.node('control.depth', {}, { image: img });
  const canny = b.node('control.canny', { lowThreshold: 100, highThreshold: 200 }, { image: img });
  const gen = b.node(
    'sd.generate',
    {
      positive: 'a watercolor painting, soft washes of colour, paper texture',
      denoise: 0.6,
      cn1Model: CN_DEPTH,
      cn1Weight: 0.8,
      cn2Model: CN_CANNY,
      cn2Weight: 0.5,
    },
    { image: img, control1: depth, control2: canny },
  );
  b.output('out', gen);
  exposeGenerate(b, gen, 2);
  b.expose('denoise', gen, 'denoise', 'Denoise');
  return {
    id: 'control.restyle',
    name: 'Restyle (SD + ControlNet)',
    category: 'ControlNet',
    tags: ['controlnet', 'stable diffusion', 'img2img', 'restyle', 'style transfer', 'depth', 'canny', 'comfyui', 'automatic1111'],
    description:
      'Re-paints the photo in another style on your own Stable Diffusion server: img2img at denoise 0.6, held in shape by depth + canny ControlNets. ' +
      'Set the server in Preferences › Generation, write a prompt, pick a checkpoint and press Generate (select this node).',
    group: b.toGroup('Restyle (SD + ControlNet)'),
  };
}

function poseTransfer(): PresetDef {
  const b = new GraphBuilder();
  const img = b.input('image');
  const pose = b.node('control.openpose', { preprocessor: 'openpose_full' }, { image: img });
  const gen = b.node('sd.generate', { positive: 'an astronaut in a white spacesuit, studio photo', cn1Model: CN_OPENPOSE, cn1Weight: 1 }, { control1: pose });
  b.output('out', gen);
  exposeGenerate(b, gen, 1);
  b.expose('poseMode', pose, 'preprocessor', 'OpenPose mode');
  return {
    id: 'control.poseTransfer',
    name: 'Pose Transfer (SD + OpenPose)',
    category: 'ControlNet',
    tags: ['controlnet', 'openpose', 'pose', 'stable diffusion', 'txt2img', 'character', 'comfyui', 'automatic1111'],
    description:
      'Generates a new image in the same pose: the photo’s OpenPose skeleton drives an OpenPose ControlNet on your own Stable Diffusion server (txt2img). ' +
      'Set the server in Preferences › Generation, write a prompt and press Generate.',
    group: b.toGroup('Pose Transfer (SD + OpenPose)'),
  };
}

export default (): PresetDef[] => [allMaps(), restyle(), poseTransfer()];
