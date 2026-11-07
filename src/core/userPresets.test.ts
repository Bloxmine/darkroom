import { describe, expect, it } from 'vitest';
import { getPreset } from './registry';
import { deleteUserPreset, listUserPresets, loadUserPresets, parsePresetFile, presetToFile, saveUserPreset } from './userPresets';
import { sanitizePrefs } from '../store/prefs';

const group = { name: 'G', graph: { nodes: [], edges: [] }, exposed: [] };

describe('user presets', () => {
  it('saves, registers, exports, re-imports under a fresh id, and deletes', async () => {
    const p = await saveUserPreset({ id: 'user.preset.warm', name: 'Warm', category: 'My Presets', group });
    expect(getPreset(p.id)?.name).toBe('Warm');
    expect(await loadUserPresets()).toEqual([]);
    expect(listUserPresets().map((x) => x.id)).toContain('user.preset.warm');
    const again = parsePresetFile(presetToFile(p.id));
    expect(again.id).not.toBe(p.id);
    expect(again.name).toBe('Warm');
    expect(() => parsePresetFile('{"darkroom":"nodes"}')).toThrow();
    await deleteUserPreset(p.id);
    expect(getPreset(p.id)).toBeUndefined();
  });
});

describe('graph-editor prefs', () => {
  it('keeps string lists and validates the new enums', () => {
    const s = sanitizePrefs({ addFavorites: ['n:a', 3, 'n:a', 'p:b'], minimapPos: 'middle', gridSize: 20, confirmDeleteOver: 7 });
    expect(s.addFavorites).toEqual(['n:a', 'p:b']);
    expect(s.minimapPos).toBe('bottom-right');
    expect(s.gridSize).toBe(20);
    expect(s.confirmDeleteOver).toBe(10);
  });
});
