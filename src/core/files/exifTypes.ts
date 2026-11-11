export type { ExifSummary } from './types';

/** The subset of src/core/types.ts › RawMeta used here (kept separate so the main process doesn't pull in core types). */
export interface RawMetaLike {
  make: string;
  model: string;
  iso: number;
  shutter: number;
  aperture: number;
  focalLength: number;
  lens?: string;
  timestamp?: number;
  width: number;
  height: number;
  flip: number;
}
