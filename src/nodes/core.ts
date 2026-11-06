import { defineNode } from '../core/registry';
import type { NodeDef } from '../core/types';

/** Built-in structural nodes. Everything else lives in ./library, ./analog and plugins. */
const nodes: NodeDef[] = [
  defineNode({
    id: 'core.image',
    name: 'Image',
    category: 'Input',
    description: 'A photo loaded from disk. Drop an image onto the canvas to create one.',
    tags: ['photo', 'file', 'load', 'input'],
    color: '#4f8cff',
    inputs: {},
    params: {
      asset: { type: 'asset', default: '', label: 'Image', accept: 'image/*' },
    },
    size: ({ params, getAsset, projectSize }) => {
      const a = getAsset(String(params.asset ?? ''));
      return a?.width && a.height ? [a.width, a.height] : [projectSize.width, projectSize.height];
    },
    cpu: ({ params, getAsset }) => {
      const a = getAsset(String(params.asset ?? ''));
      if (a?.image) return { src: a.image };
      // placeholder: soft gray gradient
      const w = 64, h = 64, d = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, v = 60 + ((x + y) / (w + h)) * 80;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
      }
      return { src: { width: w, height: h, data: d } };
    },
    passes: [{ frag: `void main(){ fragColor = texture(u_src, v_uv); }` }],
  }),
  defineNode({
    id: 'core.output',
    name: 'Output',
    category: 'Utility',
    description: 'The final image. Export renders whatever is connected here.',
    color: '#e5484d',
    inputs: { image: { type: 'image' } },
    outputs: { out: { type: 'image' } },
    params: {},
    passes: [{ frag: `void main(){ fragColor = texture(u_image, v_uv); }` }],
  }),
  defineNode({
    id: 'core.groupInput',
    name: 'Group Input',
    category: 'Utility',
    hidden: true,
    inputs: {},
    params: {
      name: { type: 'string', default: 'image', label: 'Socket name' },
      type: { type: 'enum', default: 'image', options: ['image', 'mask'] },
    },
  }),
  defineNode({
    id: 'core.groupOutput',
    name: 'Group Output',
    category: 'Utility',
    hidden: true,
    inputs: { in: { type: 'image' } },
    outputs: {},
    params: { name: { type: 'string', default: 'out', label: 'Socket name' } },
  }),
];

export default nodes;
