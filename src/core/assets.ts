import { uid } from './graph';
import type { Asset } from './types';

const readAsDataUrl = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

/** Load a File/Blob into an Asset (decodes images, reads text files). */
export async function loadAsset(file: Blob, name = (file as File).name ?? 'file', id = uid('a')): Promise<Asset> {
  const mime = file.type || guessMime(name);
  const dataUrl = await readAsDataUrl(file);
  if (mime.startsWith('image/')) {
    const image = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    return { id, name, mime, dataUrl, image, width: image.width, height: image.height };
  }
  return { id, name, mime, dataUrl, text: await file.text() };
}

export async function assetFromDataUrl(s: { id: string; name: string; mime: string; dataUrl: string }): Promise<Asset> {
  const blob = await (await fetch(s.dataUrl)).blob();
  return loadAsset(new Blob([blob], { type: s.mime }), s.name, s.id);
}

export async function assetFromUrl(url: string, id = uid('a')): Promise<Asset> {
  const blob = await (await fetch(url)).blob();
  return loadAsset(blob, url.split('/').pop() ?? 'image', id);
}

function guessMime(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', cube: 'text/plain' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
}
