/**
 * RAW camera file detection (pure, no DOM). Used by every import path
 * (file picker, drag-drop, clipboard, share target, file handlers, batch).
 */

/** The `core.raw` node type id. */
export const RAW = 'core.raw';

/** Extension → MIME type for the camera RAW formats LibRaw can open. */
export const RAW_FORMATS: Record<string, string> = {
  dng: 'image/x-adobe-dng',
  cr2: 'image/x-canon-cr2',
  cr3: 'image/x-canon-cr3',
  crw: 'image/x-canon-crw',
  nef: 'image/x-nikon-nef',
  nrw: 'image/x-nikon-nrw',
  arw: 'image/x-sony-arw',
  srf: 'image/x-sony-srf',
  sr2: 'image/x-sony-sr2',
  raf: 'image/x-fuji-raf',
  orf: 'image/x-olympus-orf',
  rw2: 'image/x-panasonic-rw2',
  rwl: 'image/x-leica-rwl',
  pef: 'image/x-pentax-pef',
  srw: 'image/x-samsung-srw',
  x3f: 'image/x-sigma-x3f',
  '3fr': 'image/x-hasselblad-3fr',
  fff: 'image/x-hasselblad-fff',
  iiq: 'image/x-phaseone-iiq',
  mos: 'image/x-leaf-mos',
  mrw: 'image/x-minolta-mrw',
  erf: 'image/x-epson-erf',
  kdc: 'image/x-kodak-kdc',
  dcr: 'image/x-kodak-dcr',
  mef: 'image/x-mamiya-mef',
  gpr: 'image/x-gopro-gpr',
  raw: 'image/x-panasonic-raw',
};

export const RAW_EXTENSIONS = Object.keys(RAW_FORMATS);

/** Extra MIME types browsers / OSes use for RAW files. */
const EXTRA_MIMES = ['image/dng', 'image/x-dcraw', 'image/x-raw', 'image/x-panasonic-raw2', 'image/x-fuji-raf', 'image/x-sony-arw'];
export const RAW_MIMES = [...new Set([...Object.values(RAW_FORMATS), ...EXTRA_MIMES])];

/** Generic MIME type stored on RAW assets whose extension is unknown. */
export const RAW_MIME_FALLBACK = 'image/x-raw';

/** Ordinary (browser-decodable) image extensions. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif'];

/** `accept` string for RAW files only. */
export const RAW_ACCEPT = RAW_EXTENSIONS.map((e) => '.' + e).join(',');

/** `accept` string for everything that imports as an Image or RAW node. */
export const IMPORT_ACCEPT = 'image/*,' + RAW_ACCEPT;

export const extOf = (name: string) => {
  const m = /\.([^./\\]+)$/.exec(name ?? '');
  return m ? m[1].toLowerCase() : '';
};

/** True for camera RAW files (by extension first, then MIME type). */
export function isRawFile(name: string, mime = ''): boolean {
  const ext = extOf(name);
  if (ext && ext in RAW_FORMATS) return true;
  const m = mime.toLowerCase();
  return !!m && RAW_MIMES.includes(m);
}

/** True for files the browser can decode itself (PNG/JPEG/WebP…), excluding RAW. */
export function isPlainImageFile(name: string, mime = ''): boolean {
  if (isRawFile(name, mime)) return false;
  return mime.toLowerCase().startsWith('image/') || IMAGE_EXTENSIONS.includes(extOf(name));
}

/** True for anything that imports as an Image or RAW node. */
export const isImportableImage = (name: string, mime = '') => isRawFile(name, mime) || isPlainImageFile(name, mime);

/** True for Darkroom project files. */
export const isProjectFile = (name: string) => /\.darkroom$/i.test(name ?? '');

/** MIME type to record for a RAW file. */
export function rawMimeFor(name: string, mime = ''): string {
  const ext = extOf(name);
  if (ext in RAW_FORMATS) return RAW_FORMATS[ext];
  return mime && RAW_MIMES.includes(mime.toLowerCase()) ? mime.toLowerCase() : RAW_MIME_FALLBACK;
}

/** Prefix of the `dataUrl` placeholder for RAW assets whose bytes live in IndexedDB (see rawStore.ts). */
export const RAW_IDB_PREFIX = 'idb:raw/';
export const isRawStoreRef = (dataUrl: string) => typeof dataUrl === 'string' && dataUrl.startsWith(RAW_IDB_PREFIX);
