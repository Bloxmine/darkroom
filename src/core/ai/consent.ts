/**
 * Download consent for large AI models. The first time a model bigger than
 * Preferences › Plugins & AI › "Ask before downloading…" is needed, the app asks once (models
 * download from Hugging Face / Google; nothing is uploaded). Approvals are remembered per file URL.
 * Explicit downloads (the AI Models table) count as approval.
 */
import { create } from 'zustand';
import { currentPrefs, setPref } from '../../store/settings';
import { isCached } from './cache';

const KEY = 'darkroom.aiApproved';
const approved = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  })(),
);
const persist = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify([...approved]));
  } catch {
    /* private mode: remember for this session only */
  }
};

export interface ConsentRequest {
  url: string;
  label: string;
  bytes: number;
  resolve: (ok: boolean) => void;
}

export const useConsent = create<{ queue: ConsentRequest[] }>(() => ({ queue: [] }));

/** Mark URLs as approved (explicit user download). */
export function approve(...urls: string[]) {
  urls.forEach((u) => approved.add(u));
  persist();
}

/** Answer the front request (called by the prompt UI). */
export function answer(ok: boolean, opts: { always?: boolean } = {}) {
  const [req, ...rest] = useConsent.getState().queue;
  if (!req) return;
  if (ok) approve(req.url);
  if (ok && opts.always) setPref('aiConfirmMB', 0);
  // the same answer applies to every queued request for the same file
  const same = rest.filter((r) => r.url === req.url);
  useConsent.setState({ queue: rest.filter((r) => r.url !== req.url) });
  for (const r of [req, ...same]) r.resolve(ok);
}

/** Resolve when the download may proceed; throws if the user declines. */
export async function ensureConsent(url: string, label: string, bytes: number): Promise<void> {
  const limit = currentPrefs().aiConfirmMB;
  if (!limit || bytes < limit * 1e6 || approved.has(url)) return;
  if (!/^https?:/i.test(url) || new URL(url, location.href).origin === location.origin) return; // bundled with the app
  if (await isCached(url)) return;
  const ok = await new Promise<boolean>((resolve) => useConsent.setState((s) => ({ queue: [...s.queue, { url, label, bytes, resolve }] })));
  if (!ok) throw new Error(`Download of “${label}” (${(bytes / 1e6).toFixed(0)} MB) was declined. Change a parameter or use Plugins › AI Models › Download to fetch it.`);
}
