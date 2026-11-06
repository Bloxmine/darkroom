/** AI inference worker: ONNX Runtime JSEP build (WebGPU EP + WASM CPU fallback). */
import * as ort from 'onnxruntime-web';
import { serveWorker } from './session';

serveWorker(ort);
