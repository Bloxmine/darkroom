/**
 * Desktop (Electron) file handling: native open/save dialogs, the current project
 * file path (Save overwrites in place, Save As… picks a new one), Finder open-file.
 * Only called when `native` is present; src/store/io.ts branches into here.
 */
import { create } from 'zustand';
import { markSaved, useDoc } from '../store/doc';
import { importImageFiles, loadProject, serializeProject, validateProject } from '../store/io';
import { status } from '../store/ui';
import type { OpenedFile } from './api';
import { native } from './native';

const PATH_KEY = 'darkroom.projectPath';

/** Path of the .darkroom file the current project was opened from / saved to (null = never saved). */
export const useDocFile = create<{ path: string | null }>(() => {
  let path: string | null = null;
  try {
    path = native ? localStorage.getItem(PATH_KEY) : null;
  } catch {
    /* storage unavailable */
  }
  return { path };
});

export function setDocPath(path: string | null) {
  useDocFile.setState({ path });
  try {
    if (path) localStorage.setItem(PATH_KEY, path);
    else localStorage.removeItem(PATH_KEY);
  } catch {
    /* storage unavailable */
  }
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Load project JSON text that came from disk. */
export async function openProjectText(f: { path: string; name: string; text: string }) {
  try {
    const p = validateProject(JSON.parse(f.text));
    if (!p.name || p.name === 'Untitled') p.name = f.name;
    await loadProject(p);
    setDocPath(f.path);
    status(`Opened ${baseName(f.path)}`);
  } catch (e) {
    status(`Could not open ${baseName(f.path)}: ${(e as Error).message}`, 'error');
  }
}

export async function openProject() {
  const f = await native!.openProject().catch((e: Error) => (status(`Could not open: ${e.message}`, 'error'), null));
  if (f) await openProjectText(f);
}

export async function saveProject(saveAs: boolean) {
  const { project } = useDoc.getState();
  try {
    const r = await native!.saveProject(serializeProject(), { path: useDocFile.getState().path, suggestedName: project.name || 'Untitled', saveAs });
    if (!r) return;
    setDocPath(r.path);
    markSaved();
    status(`Saved ${baseName(r.path)}`);
  } catch (e) {
    status(`Could not save: ${(e as Error).message}`, 'error');
  }
}

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  dng: 'image/x-adobe-dng',
  cr2: 'image/x-canon-cr2',
  cr3: 'image/x-canon-cr3',
  nef: 'image/x-nikon-nef',
  arw: 'image/x-sony-arw',
  raf: 'image/x-fuji-raf',
  orf: 'image/x-olympus-orf',
  rw2: 'image/x-panasonic-rw2',
};

/** Bytes from main → File objects for the same import path browser imports use (io.importImageFiles). */
export const toFiles = (list: { name: string; data: Uint8Array }[]) =>
  list.map((f) => new File([f.data as Uint8Array<ArrayBuffer>], f.name, { type: MIME[f.name.split('.').pop()!.toLowerCase()] ?? '' }));

export async function pickImages(): Promise<File[]> {
  try {
    return toFiles(await native!.openImages());
  } catch (e) {
    status(`Could not read images: ${(e as Error).message}`, 'error');
    return [];
  }
}

/** Save dialog + write. Resolves false if cancelled. */
export async function saveBlob(blob: Blob, suggestedName: string, ext: string, label = ext.toUpperCase() + ' Image'): Promise<boolean> {
  const path = await native!.saveFile(new Uint8Array(await blob.arrayBuffer()), {
    suggestedName,
    filters: [{ name: label, extensions: [ext] }],
  });
  return !!path;
}

/** Files from Finder (double-click / Open With / Dock drop / Open Recent). */
export async function handleOpenedFiles(files: OpenedFile[]) {
  const projects = files.filter((f) => f.kind === 'project');
  const images = files.filter((f) => f.kind === 'image');
  if (projects.length) await openProjectText(projects[projects.length - 1]);
  if (images.length) await importImageFiles(toFiles(images));
}
