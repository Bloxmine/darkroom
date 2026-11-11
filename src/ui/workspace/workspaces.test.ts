import { describe, expect, it } from 'vitest';
import * as L from './layout';
import { allWorkspaces, builtinWorkspaces, deleteWorkspace, overwriteWorkspace, renameWorkspace, sanitizeSaved, saveWorkspace, WorkspaceError, type SavedWorkspace } from './workspaces';

const layout = (): L.Layout => ({ root: L.row([L.stack(['library']), L.stack(['viewer'])], [0.3, 0.7]) });

describe('workspaces', () => {
  it('ships the Bridge-style built-ins referencing the browser panels', () => {
    const b = builtinWorkspaces();
    expect(b.map((w) => w.name)).toEqual(['Essentials', 'Browse', 'Filmstrip', 'Light Table', 'Graph', 'Viewer', 'Metadata']);
    const ids = (id: string) => L.panelIds(b.find((w) => w.id === id)!.layout.root);
    expect(ids('essentials')).toEqual(['library', 'viewer', 'graph', 'properties']);
    expect(ids('browse')).toEqual(expect.arrayContaining(['browser.folders', 'browser.favorites', 'browser.content', 'browser.preview', 'browser.metadata', 'browser.keywords', 'browser.filter']));
    expect(ids('filmstrip')).toEqual(expect.arrayContaining(['browser.preview', 'browser.filmstrip']));
    expect(ids('lightTable')).toEqual(['browser.content']);
    expect(ids('viewer')).toEqual(expect.arrayContaining(['viewer', 'scopes', 'properties']));
    // every built-in serialises losslessly
    for (const w of b) expect(L.deserialize(L.serialize(w.layout))?.root).toEqual(w.layout.root);
  });

  it('creates, overwrites by name, renames and deletes', () => {
    let saved: SavedWorkspace[] = [];
    const a = saveWorkspace(saved, '  My Edit ', layout());
    saved = a.saved;
    expect(a.id).toBe('u-my-edit');
    expect(a.overwritten).toBe(false);
    expect(saved[0].name).toBe('My Edit');
    expect(L.panelIds(L.deserialize(saved[0].layout)!.root)).toEqual(['library', 'viewer']);

    const b = saveWorkspace(saved, 'my edit', { root: L.stack(['graph']) });
    expect(b.overwritten).toBe(true);
    expect(b.id).toBe('u-my-edit');
    expect(b.saved).toHaveLength(1);
    expect(L.panelIds(L.deserialize(b.saved[0].layout)!.root)).toEqual(['graph']);
    saved = b.saved;

    const c = saveWorkspace(saved, 'My-Edit', layout()); // different name, same slug → unique id
    expect(c.id).toBe('u-my-edit-2');
    saved = c.saved;

    saved = renameWorkspace(saved, 'u-my-edit', 'Retouch');
    expect(saved.map((w) => w.name)).toEqual(['Retouch', 'My-Edit']);
    expect(() => renameWorkspace(saved, 'u-my-edit', 'My-Edit')).toThrow(WorkspaceError);
    expect(() => renameWorkspace(saved, 'essentials', 'X')).toThrow(WorkspaceError);

    saved = overwriteWorkspace(saved, 'u-my-edit-2', { root: L.stack(['properties']) });
    expect(L.panelIds(L.deserialize(saved[1].layout)!.root)).toEqual(['properties']);
    expect(() => overwriteWorkspace(saved, 'graph', layout())).toThrow(WorkspaceError);

    saved = deleteWorkspace(saved, 'u-my-edit');
    expect(saved.map((w) => w.id)).toEqual(['u-my-edit-2']);
    expect(() => deleteWorkspace(saved, 'essentials')).toThrow(WorkspaceError);
  });

  it('reserves built-in names and requires a name', () => {
    expect(() => saveWorkspace([], 'essentials', layout())).toThrow(/built-in/);
    expect(() => saveWorkspace([], '   ', layout())).toThrow(WorkspaceError);
  });

  it('saved layouts are copies (ids are fresh, later edits do not leak)', () => {
    const l = layout();
    const { saved } = saveWorkspace([], 'A', l);
    const ids = L.stacks(L.deserialize(saved[0].layout)!.root).map((s) => s.id);
    expect(ids).not.toEqual(L.stacks(l.root).map((s) => s.id));
  });

  it('sanitises stored workspaces and lists built-ins first', () => {
    const { saved } = saveWorkspace([], 'Mine', layout());
    const dirty = [...saved, { id: 'essentials', name: 'Hijack', layout: layout() }, { id: 'x', name: 'Broken', layout: { root: 5 } }, 'junk', { id: 'u-mine', name: 'Dup', layout: layout() }];
    const clean = sanitizeSaved(dirty);
    expect(clean.map((w) => w.name)).toEqual(['Mine']);
    const all = allWorkspaces(clean);
    expect(all[0].id).toBe('essentials');
    expect(all[all.length - 1]).toMatchObject({ id: 'u-mine', name: 'Mine' });
    expect(all.filter((w) => w.builtin)).toHaveLength(7);
    expect(sanitizeSaved(null)).toEqual([]);
  });
});
