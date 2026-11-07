/**
 * Geometry model for relighting (surface normals + relative depth), registered into the shared catalog.
 * Imported for its side effect by src/nodes/ai/normals.ts. Licences/attribution: docs/AI.md (Relighting).
 */
import { registerModel } from './models';

const hf = (repo: string, sha: string, file: string) => `https://huggingface.co/${repo}/resolve/${sha}/${file}`;

const MOGE_REPO = 'Ruicheng/moge-2-vits-normal-onnx';
const MOGE_SHA = 'e50ffda41565591092adea54c6ac83d6212e1e23';

registerModel({
  id: 'moge-2-vits-normal',
  name: 'MoGe-2 ViT-S (normals + geometry)',
  task: 'normals',
  licence: 'MIT (DINOv2 backbone Apache-2.0)',
  page: `https://huggingface.co/${MOGE_REPO}`,
  credit: 'MoGe-2 (Wang et al., Microsoft, 2025); official ONNX export by the authors',
  // fp32, dynamic H×W; inputs `image` (0..1 RGB, NCHW) and `num_tokens` (int64 scalar).
  // Outputs `points` (affine point map, H×W×3), `normal` (OpenCV camera space, H×W×3), `mask` (H×W), `scale`.
  files: [{ precision: 'fp32', url: hf(MOGE_REPO, MOGE_SHA, 'model.onnx'), bytes: 140852051 }],
});
