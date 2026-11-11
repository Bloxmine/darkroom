/**
 * Shared types of the file browser (src/ui/browser) and its two file-system backends
 * (Electron IPC: electron/files/*, web: File System Access API). Type-only: imported by
 * the Electron main process, the preload script and the renderer.
 */

export type FileKind = 'image' | 'raw' | 'video' | 'project' | 'other';

/** A directory entry. `path` is absolute (Electron) or virtual `/<rootId>/a/b.jpg` (web). */
export interface FsEntry {
  path: string;
  name: string;
  dir: boolean;
  /** Bytes (0 for folders). */
  size: number;
  /** Last modified, ms since epoch. */
  mtime: number;
  /** Created (birth time) where the platform reports one, ms since epoch. */
  btime?: number;
  /** Lower-case extension without the dot ('' for folders). */
  ext: string;
  kind: FileKind | 'folder';
  hidden?: boolean;
}

/** A top-level location the user granted (or a suggested default). */
export interface FsRoot {
  path: string;
  name: string;
  /** 'granted' = picked in a folder dialog / via Finder, 'default' = ~/Pictures etc. */
  source: 'granted' | 'default';
  /** Web backend: the handle needs a permission re-request (user gesture) before use. */
  needsPermission?: boolean;
}

/** Normalised EXIF/IPTC summary (see src/core/files/exif.ts). All fields optional. */
export interface ExifSummary {
  make?: string;
  model?: string;
  lens?: string;
  /** Seconds. */
  exposureTime?: number;
  fNumber?: number;
  iso?: number;
  /** mm. */
  focalLength?: number;
  focalLength35?: number;
  exposureBias?: number;
  exposureProgram?: string;
  meteringMode?: string;
  flash?: string;
  whiteBalance?: string;
  /** Date taken (DateTimeOriginal), ms since epoch (wall clock as UTC). */
  dateTaken?: number;
  width?: number;
  height?: number;
  /** EXIF orientation 1–8. */
  orientation?: number;
  gps?: { lat: number; lon: number; alt?: number };
  colorProfile?: string;
  colorSpace?: string;
  software?: string;
  artist?: string;
  copyright?: string;
  /** IPTC (legacy IIM) fields, used when there's no XMP. */
  iptc?: { title?: string; description?: string; keywords?: string[]; creator?: string; copyright?: string; city?: string; country?: string };
  /** Raw embedded XMP packet (JPEG/TIFF/DNG), parsed with src/core/files/xmp.ts. */
  xmp?: string;
  /** Video duration in seconds (web backend, from the <video> element). */
  duration?: number;
  /** Where the metadata came from (e.g. 'exifr', 'libraw'). */
  source?: string;
}

/** Result of `files.meta(paths)`: EXIF summary + the XMP sidecar text, if any. */
export interface FileMetaResult {
  path: string;
  exif: ExifSummary | null;
  /** Sidecar path that was read (or would be written). */
  sidecarPath: string;
  sidecar: string | null;
  error?: string;
}

/** A thumbnail produced by the backend (QuickLook in the Mac app). */
export interface ThumbResult {
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
}

export interface RenamePair {
  from: string;
  /** New file name (not a path): renames stay in the same folder. */
  to: string;
}

export interface RenameOutcome {
  from: string;
  to: string;
  ok: boolean;
  error?: string;
}

export interface FsChange {
  dir: string;
  /** Changed names (may be empty when the OS doesn't say). */
  names: string[];
}

/** What a backend can do (the UI disables the rest with a tooltip saying why). */
export interface FsCaps {
  rename: boolean;
  move: boolean;
  copy: boolean;
  trash: boolean;
  reveal: boolean;
  openDefault: boolean;
  mkdir: boolean;
  /** XMP sidecars are written next to the files (otherwise kept in IndexedDB). */
  sidecarOnDisk: boolean;
  watch: boolean;
  /** Why the disabled operations are unavailable (tooltip). */
  why?: string;
}
