import pack from '../../public/plugins/example-shader-pack.drplugin.json?raw';
import { describe, expect, it } from 'vitest';
import { embedCustomNodes, getNodeOrigin, registerProjectNodes, saveUserNode } from './customNodes';
import { installPlugin, PluginConflictError, setPluginEnabled, TrustRequiredError, uninstallPlugin } from './plugins';
import { getNodeDef, getPreset, missingNodeMessage, unregisterNode } from './registry';
import type { Project } from './types';

const ids = ['example.duotone', 'example.sobelGlow', 'example.kaleidoscope'];
const node = (id: string, type: string) => ({ id, type, params: {}, position: { x: 0, y: 0 } });

describe('plugin lifecycle (data plugin)', () => {
  it('installs, records origins, disables, re-enables, embeds and uninstalls', async () => {
    const st = await installPlugin({ source: pack, url: 'http://x/pack.json' });
    expect(st.status).toBe('loaded');
    expect(st.nodes).toEqual(ids);
    for (const id of ids) expect(getNodeOrigin(id)).toMatchObject({ kind: 'plugin', id: 'example.shaderPack' });
    expect(getPreset('example.neonNight')?.group.graph.nodes.find((n) => n.id === 'sobel')?.params.glow).toBe(1.4); // defaults filled

    await expect(installPlugin({ source: pack })).rejects.toBeInstanceOf(PluginConflictError);

    const project: Project = { version: 1, name: 't', assets: {}, graph: { nodes: [node('a', 'example.sobelGlow'), node('b', 'core.image')], edges: [] } };
    const saved = embedCustomNodes(project);
    expect(saved.customNodes?.map((c) => c.id)).toEqual(['example.sobelGlow']);
    expect(saved.plugins).toEqual([{ id: 'example.shaderPack', name: 'Example Shader Pack', version: '1.0.0', url: 'http://x/pack.json', nodes: ['example.sobelGlow'] }]);

    await setPluginEnabled('example.shaderPack', false);
    for (const id of ids) expect(getNodeDef(id)).toBeUndefined();
    expect(getPreset('example.neonNight')).toBeUndefined();
    expect(missingNodeMessage('example.duotone')).toMatch(/example\.shaderPack.*disabled/);

    await setPluginEnabled('example.shaderPack', true);
    expect(getNodeDef('example.duotone')).toBeDefined();

    await uninstallPlugin('example.shaderPack');
    expect(getNodeDef('example.sobelGlow')).toBeUndefined();

    // opening the saved project elsewhere registers the embedded type
    const r = registerProjectNodes(saved);
    expect(r.registered).toEqual(['example.sobelGlow']);
    expect(getNodeOrigin('example.sobelGlow')).toEqual({ kind: 'project' });
    unregisterNode('example.sobelGlow');
  });

  it('requires trust for code plugins', async () => {
    await expect(installPlugin({ source: 'export default {}', fileName: 'x.js' })).rejects.toBeInstanceOf(TrustRequiredError);
  });

  it('user nodes cannot take built-in or plugin ids; annotations fill params', async () => {
    const def = await saveUserNode({
      id: 'user.t',
      name: 'T',
      category: 'Custom',
      inputs: { image: { type: 'image' } },
      params: {},
      passes: [{ frag: 'uniform float u_k; // @param default=2\nvoid main(){ fragColor = texture(u_image, v_uv) * u_k; }' }],
    });
    expect(def.params.k).toMatchObject({ type: 'float', default: 2 });
    expect(def.passes![0].frag).not.toMatch(/uniform float u_k/);
    await installPlugin({ source: pack });
    await expect(saveUserNode({ id: 'example.duotone', name: 'x', category: 'x', inputs: {}, params: {}, passes: [{ frag: 'void main(){}' }] })).rejects.toThrow(/plugin/);
    await uninstallPlugin('example.shaderPack');
  });
});
