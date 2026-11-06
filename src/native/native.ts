import type { DarkroomNative } from './api';

declare global {
  interface Window {
    /** Present only in the Electron desktop app (electron/preload.ts). */
    darkroomNative?: DarkroomNative;
  }
}

/** The desktop bridge, or undefined in the browser / PWA. */
export const native: DarkroomNative | undefined = typeof window !== 'undefined' ? window.darkroomNative : undefined;

/** macOS desktop app: native menu bar replaces the in-app one, traffic lights sit in the toolbar. */
export const nativeMac = native?.platform === 'darwin';
