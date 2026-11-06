/** AI inference worker: ONNX Runtime WASM-only build (smaller runtime, CPU only). */
import * as ort from 'onnxruntime-web/wasm';
import { serveWorker } from './session';

serveWorker(ort);
