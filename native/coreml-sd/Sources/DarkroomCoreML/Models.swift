// Model discovery: finds Core ML Stable Diffusion base models and ControlNets under the given roots by reading the
// compiled models' metadata.json (no model is loaded). The same metadata is used to validate a load: resolution
// (UNet `sample` shape × 8, ControlNet `controlnet_cond` shape) and attention variant (split-einsum models use
// `einsum` ops for attention, "original" ones `matmul`).
import Foundation

enum Attention: String {
    case splitEinsum, original, unknown
}

struct ModelMeta {
    var inputs: [String: [Int]] = [:]
    var ops: [String: Int] = [:]
    var version: String = ""
    var license: String = ""

    var attention: Attention {
        if (ops["Ios16.einsum"] ?? 0) + (ops["Ios17.einsum"] ?? 0) > 0 { return .splitEinsum }
        if (ops["Ios16.matmul"] ?? 0) + (ops["Ios17.matmul"] ?? 0) > 0 { return .original }
        return .unknown
    }
}

/// Parse `<x>.mlmodelc/metadata.json` (an array with one object; shapes are strings like "[2, 4, 64, 64]").
func readMeta(_ mlmodelc: URL) -> ModelMeta? {
    guard let data = try? Data(contentsOf: mlmodelc.appendingPathComponent("metadata.json")),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], let m = arr.first else { return nil }
    var meta = ModelMeta()
    for item in (m["inputSchema"] as? [[String: Any]]) ?? [] {
        guard let name = item["name"] as? String else { continue }
        let shape = ((item["shape"] as? String) ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "[] "))
            .split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }
        meta.inputs[name] = shape
    }
    meta.ops = (m["mlProgramOperationTypeHistogram"] as? [String: Int]) ?? [:]
    meta.version = (m["version"] as? String) ?? ""
    meta.license = (m["license"] as? String) ?? ""
    return meta
}

struct BaseModelInfo {
    var path: URL
    var name: String
    var kind: String           // "sd15" | "sd2" | "sdxl" | "unknown"
    var attention: Attention
    var width: Int
    var height: Int
    var controlNetSupport: Bool
    var hasPlainUnet: Bool
    var hasEncoder: Bool
    var chunked: Bool
    var bytes: Int64

    var json: [String: Any] {
        ["path": path.path, "name": name, "kind": kind, "attention": attention.rawValue, "width": width, "height": height,
         "controlNetSupport": controlNetSupport, "hasPlainUnet": hasPlainUnet, "img2img": hasEncoder, "chunked": chunked, "bytes": bytes]
    }
}

struct ControlNetInfo {
    var path: URL
    var name: String
    var attention: Attention
    var width: Int
    var height: Int
    var version: String
    var bytes: Int64

    var json: [String: Any] {
        ["path": path.path, "name": name, "attention": attention.rawValue, "width": width, "height": height, "version": version, "bytes": bytes]
    }
}

private let fm = FileManager.default
private func isDir(_ u: URL) -> Bool {
    var d: ObjCBool = false
    return fm.fileExists(atPath: u.path, isDirectory: &d) && d.boolValue
}
private func exists(_ u: URL) -> Bool { fm.fileExists(atPath: u.path) }

func dirBytes(_ u: URL) -> Int64 {
    guard let e = fm.enumerator(at: u, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey]) else { return 0 }
    var n: Int64 = 0
    for case let f as URL in e {
        if let v = try? f.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]), v.isRegularFile == true { n += Int64(v.fileSize ?? 0) }
    }
    return n
}

/// A base model folder: tokenizer files + text encoder + decoder + a (controlled) UNet.
func inspectBase(_ dir: URL, sizes: Bool = true) -> BaseModelInfo? {
    let te = dir.appendingPathComponent("TextEncoder.mlmodelc")
    let dec = dir.appendingPathComponent("VAEDecoder.mlmodelc")
    let unet = dir.appendingPathComponent("Unet.mlmodelc")
    let cunet = dir.appendingPathComponent("ControlledUnet.mlmodelc")
    let chunk1 = dir.appendingPathComponent("UnetChunk1.mlmodelc")
    guard exists(dir.appendingPathComponent("vocab.json")), exists(dir.appendingPathComponent("merges.txt")), isDir(dec),
          isDir(te) || exists(dir.appendingPathComponent("TextEncoder2.mlmodelc")) else { return nil }
    let hasCU = isDir(cunet), hasU = isDir(unet), chunked = isDir(chunk1)
    guard hasCU || hasU || chunked else { return nil }
    let meta = readMeta(hasCU ? cunet : hasU ? unet : chunk1) ?? ModelMeta()
    let sample = meta.inputs["sample"] ?? []
    let hidden = meta.inputs["encoder_hidden_states"] ?? []
    var kind = "unknown"
    if meta.inputs["time_ids"] != nil || meta.inputs["text_embeds"] != nil { kind = "sdxl" }
    else if hidden.count >= 2 && hidden[1] == 768 { kind = "sd15" }
    else if hidden.count >= 2 && hidden[1] == 1024 { kind = "sd2" }
    let h = sample.count == 4 ? sample[2] * 8 : 0
    let w = sample.count == 4 ? sample[3] * 8 : 0
    return BaseModelInfo(path: dir, name: dir.lastPathComponent, kind: kind, attention: meta.attention, width: w, height: h,
                         controlNetSupport: hasCU, hasPlainUnet: hasU, hasEncoder: isDir(dir.appendingPathComponent("VAEEncoder.mlmodelc")),
                         chunked: chunked && !hasCU && !hasU, bytes: sizes ? dirBytes(dir) : 0)
}

func inspectControlNet(_ mlmodelc: URL, sizes: Bool = true) -> ControlNetInfo? {
    guard mlmodelc.pathExtension == "mlmodelc", let meta = readMeta(mlmodelc), let cond = meta.inputs["controlnet_cond"], cond.count == 4 else { return nil }
    return ControlNetInfo(path: mlmodelc, name: mlmodelc.deletingPathExtension().lastPathComponent, attention: meta.attention,
                          width: cond[3], height: cond[2], version: meta.version, bytes: sizes ? dirBytes(mlmodelc) : 0)
}

/// Scan roots (depth ≤ 3) for base models and ControlNets. Mochi Diffusion layouts work: a models folder with one
/// folder per model, and a ControlNet folder with `*.mlmodelc` files directly inside.
func scanModels(roots: [URL]) -> (bases: [BaseModelInfo], controlNets: [ControlNetInfo]) {
    var bases: [BaseModelInfo] = [], cns: [ControlNetInfo] = []
    var seen = Set<String>()
    func walk(_ dir: URL, _ depth: Int) {
        let real = dir.resolvingSymlinksInPath().path
        if seen.contains(real) { return }
        seen.insert(real)
        if let b = inspectBase(dir) {
            bases.append(b)
            // a per-model controlnet/ folder (the ml-stable-diffusion CLI layout)
            let cnDir = dir.appendingPathComponent("controlnet")
            if isDir(cnDir) { walk(cnDir, depth + 1) }
            return
        }
        guard depth < 3, let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey], options: [.skipsHiddenFiles]) else { return }
        for u in items.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where isDir(u) {
            if u.pathExtension == "mlmodelc" {
                if let c = inspectControlNet(u), !seen.contains(u.resolvingSymlinksInPath().path) {
                    seen.insert(u.resolvingSymlinksInPath().path)
                    cns.append(c)
                }
            } else if !u.lastPathComponent.hasSuffix(".partial") {
                walk(u, depth + 1)
            }
        }
    }
    for r in roots where isDir(r) { walk(r, 0) }
    return (bases, cns)
}
