/** File type detection for the browser (pure; shared with the Electron main process). */
import type { FileKind } from './types';

export const BROWSER_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'tif', 'tiff', 'gif', 'avif', 'bmp'];
export const BROWSER_RAW_EXTS = ['dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'rwl', 'pef', 'srw', 'x3f', '3fr', 'fff', 'iiq', 'mos', 'mrw', 'erf', 'kdc', 'dcr', 'mef', 'gpr'];
export const BROWSER_VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];
export const PROJECT_EXTS = ['darkroom'];

/** Images Chromium decodes itself (everything else goes through QuickLook / embedded previews). */
export const WEB_DECODABLE = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'];

export const extOfName = (name: string) => {
  const m = /\.([^./\\]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
};

export function kindOf(name: string): FileKind {
  const e = extOfName(name);
  if (BROWSER_RAW_EXTS.includes(e)) return 'raw';
  if (BROWSER_IMAGE_EXTS.includes(e)) return 'image';
  if (BROWSER_VIDEO_EXTS.includes(e)) return 'video';
  if (PROJECT_EXTS.includes(e)) return 'project';
  return 'other';
}

/** Shown in the Content panel (sidecars, documents etc. are hidden like Bridge's default filter). */
export const isBrowsable = (name: string) => kindOf(name) !== 'other';

export const MIME_BY_EXT: Record<string, string> = {
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
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  darkroom: 'application/json',
};

/** Human-readable type for the Filter panel / details list ("JPEG file", "Camera Raw (NEF)"…). */
export function typeLabel(name: string, dir = false): string {
  if (dir) return 'Folder';
  const e = extOfName(name);
  const k = kindOf(name);
  if (k === 'raw') return `Camera Raw (${e.toUpperCase()})`;
  if (e === 'jpg' || e === 'jpeg') return 'JPEG file';
  if (e === 'tif' || e === 'tiff') return 'TIFF image';
  if (e === 'heic' || e === 'heif') return 'HEIF image';
  if (k === 'image') return `${e.toUpperCase()} image`;
  if (k === 'video') return `${e.toUpperCase()} video`;
  if (k === 'project') return 'Darkroom project';
  return e ? `${e.toUpperCase()} file` : 'File';
}
