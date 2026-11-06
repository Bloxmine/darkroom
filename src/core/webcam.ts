/**
 * Shared getUserMedia streams for `core.webcam` nodes, keyed by device + resolution.
 * Streams start lazily on first use and are stopped by `releaseWebcams()` when no node uses them.
 */
export interface Webcam {
  key: string;
  video: HTMLVideoElement;
  stream: MediaStream | null;
  error: string | null;
  ready: Promise<void>;
}

const cams = new Map<string, Webcam>();
let devices: MediaDeviceInfo[] = [];

export const WEBCAM_RESOLUTIONS = ['640x480', '1280x720', '1920x1080', '3840x2160'];
export const WEBCAM_DEVICES = ['default', 'camera 1', 'camera 2', 'camera 3', 'camera 4'];

export function webcamKey(device: string, resolution: string) {
  return `${device}|${resolution}`;
}

/** Labels of the video inputs (available after permission was granted). */
export function webcamDeviceLabels(): string[] {
  return devices.map((d, i) => d.label || `Camera ${i + 1}`);
}

async function refreshDevices() {
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch {
    devices = [];
  }
}

/** Get (starting if needed) the stream for a device option ('default' | 'camera N') and 'WxH'. */
export function getWebcam(device: string, resolution: string): Webcam {
  const key = webcamKey(device, resolution);
  let cam = cams.get(key);
  if (cam) return cam;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  cam = { key, video, stream: null, error: null, ready: Promise.resolve() };
  const c = cam;
  cams.set(key, cam);
  const [w, h] = resolution.split('x').map(Number);
  c.ready = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is not available in this browser (needs HTTPS or localhost).');
    if (!devices.length) await refreshDevices();
    const idx = device.startsWith('camera ') ? Number(device.slice(7)) - 1 : -1;
    const deviceId = idx >= 0 ? devices[idx]?.deviceId : undefined;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { width: { ideal: w || 1280 }, height: { ideal: h || 720 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    });
    if (!cams.has(key)) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    c.stream = stream;
    video.srcObject = stream;
    await video.play().catch(() => {});
    if (video.readyState < 2) await new Promise<void>((res) => video.addEventListener('loadeddata', () => res(), { once: true }));
    void refreshDevices(); // labels are only exposed after permission
  })().catch((e) => {
    c.error = String((e as Error)?.message ?? e);
    throw e;
  });
  c.ready.catch(() => {});
  return c;
}

/** Stop streams whose key is not in `keep`. */
export function releaseWebcams(keep: Set<string>) {
  for (const [k, c] of cams) {
    if (keep.has(k)) continue;
    c.stream?.getTracks().forEach((t) => t.stop());
    c.video.srcObject = null;
    cams.delete(k);
  }
}
