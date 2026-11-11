import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkName, guardPath, isWithin } from './guard';

let base = '';
let root = '';
let outside = '';

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'darkroom-guard-'));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  await mkdir(path.join(root, 'sub'), { recursive: true });
  await mkdir(outside);
  await mkdir(path.join(base, 'root2')); // prefix of "root" + "2": must not count as inside "root"
  await writeFile(path.join(root, 'sub', 'a.jpg'), 'x');
  await writeFile(path.join(outside, 'secret.txt'), 'x');
  await writeFile(path.join(base, 'root2', 'b.jpg'), 'x');
  await symlink(outside, path.join(root, 'escape')); // dir symlink pointing out of the root
  await symlink(path.join(outside, 'secret.txt'), path.join(root, 'sub', 'link.txt')); // file symlink out
  await symlink(path.join(root, 'sub'), path.join(base, 'alias')); // a symlinked root
});
afterAll(() => rm(base, { recursive: true, force: true }));

describe('path guard', () => {
  it('accepts paths inside a granted root (returns the real path)', async () => {
    const p = await guardPath(path.join(root, 'sub', 'a.jpg'), [root]);
    expect(p.endsWith(path.join('root', 'sub', 'a.jpg'))).toBe(true);
    await expect(guardPath(root, [root])).resolves.toBeTruthy();
  });

  it('rejects paths outside every root', async () => {
    await expect(guardPath(path.join(outside, 'secret.txt'), [root])).rejects.toThrow(/Access denied/);
    await expect(guardPath('/etc/passwd', [root])).rejects.toThrow(/Access denied/);
  });

  it('rejects .. traversal', async () => {
    await expect(guardPath(path.join(root, 'sub', '..', '..', 'outside', 'secret.txt'), [root])).rejects.toThrow(/Access denied/);
    await expect(guardPath(`${root}/../outside`, [root])).rejects.toThrow(/Access denied/);
    // .. that stays inside is fine
    await expect(guardPath(path.join(root, 'sub', '..', 'sub', 'a.jpg'), [root])).resolves.toBeTruthy();
  });

  it('rejects symlinks that point outside', async () => {
    await expect(guardPath(path.join(root, 'escape', 'secret.txt'), [root])).rejects.toThrow(/Access denied/);
    await expect(guardPath(path.join(root, 'escape'), [root])).rejects.toThrow(/Access denied/);
    await expect(guardPath(path.join(root, 'sub', 'link.txt'), [root])).rejects.toThrow(/Access denied/);
    // new file "inside" a symlinked-out folder
    await expect(guardPath(path.join(root, 'escape', 'new.jpg'), [root], { mustExist: false })).rejects.toThrow(/Access denied/);
  });

  it('does not treat a sibling with the same prefix as inside', async () => {
    await expect(guardPath(path.join(base, 'root2', 'b.jpg'), [root])).rejects.toThrow(/Access denied/);
    expect(isWithin('/a/root2/x', '/a/root')).toBe(false);
    expect(isWithin('/a/root/x', '/a/root')).toBe(true);
    expect(isWithin('/a/root/..x', '/a/root')).toBe(true); // a file literally named "..x"
  });

  it('resolves symlinked roots', async () => {
    await expect(guardPath(path.join(base, 'alias', 'a.jpg'), [path.join(base, 'alias')])).resolves.toBeTruthy();
    await expect(guardPath(path.join(root, 'sub', 'a.jpg'), [path.join(base, 'alias')])).resolves.toBeTruthy();
  });

  it('handles missing paths and bad input', async () => {
    await expect(guardPath(path.join(root, 'sub', 'missing.jpg'), [root])).rejects.toThrow(/missing/);
    await expect(guardPath(path.join(root, 'sub', 'new.jpg'), [root], { mustExist: false })).resolves.toContain('new.jpg');
    await expect(guardPath(path.join(root, 'nope', 'new.jpg'), [root], { mustExist: false })).rejects.toThrow(/Access denied/);
    await expect(guardPath('relative/a.jpg', [root])).rejects.toThrow(/absolute/);
    await expect(guardPath(42, [root])).rejects.toThrow();
    await expect(guardPath(root + '/a\0b', [root])).rejects.toThrow();
    await expect(guardPath(path.join(root, 'sub', 'a.jpg'), [])).rejects.toThrow(/Access denied/);
  });

  it('validates single file names', () => {
    expect(checkName(' ok.jpg ')).toBe('ok.jpg');
    for (const bad of ['', '..', '.', 'a/b', 'a\\b', 'a:b', 'x\0', 7]) expect(() => checkName(bad)).toThrow();
  });
});
