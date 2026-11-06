import { defineNode } from '../../core/registry';
import type { NodeDef } from '../../core/types';

export default [
  defineNode({
    id: 'util.reroute',
    name: 'Reroute',
    category: 'Utility',
    description: 'Passes the image through unchanged — use it to tidy up wires.',
    tags: ['dot', 'passthrough', 'wire', 'tidy'],
    color: '#8b8d98',
    inputs: { image: { type: 'image' } },
    params: {},
    passes: [{ frag: `void main(){ fragColor = texture(u_image, v_uv); }` }],
  }),
] satisfies NodeDef[];
