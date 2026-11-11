// The generation engine. It uses ml-stable-diffusion's public building blocks (BPETokenizer + TextEncoder, the VAE
// Encoder/Decoder, the PNDM / DPM-Solver++ schedulers, ManagedMLModel) but runs its own denoising loop, because the
// package's StableDiffusionPipeline sums ControlNet residuals with no per-unit weight or step range and has no
// masked inpainting. This loop adds:
//   • per-ControlNet weight and start/end fraction of the steps (like A1111 / ComfyUI),
//   • inpainting with any model: latent-mask blending each step + a pixel composite outside the mask,
//   • the ControlNet-inpaint convention (masked pixels = −1 in the control image),
//   • one UNet for everything: a ControlledUnet is fed zero residuals when no ControlNet is active, so a model
//     needs only one UNet compiled for the Neural Engine (and the plain Unet.mlmodelc can be left out).
import Accelerate
import CoreML
import Foundation
import StableDiffusion

struct HelperError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var v = false
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return v }
    func set() { lock.lock(); v = true; lock.unlock() }
}

typealias Progress = (_ phase: String, _ step: Int, _ total: Int, _ message: String) -> Void

func computeUnits(_ s: String) throws -> MLComputeUnits {
    switch s {
    case "cpuAndNeuralEngine": return .cpuAndNeuralEngine
    case "cpuAndGPU": return .cpuAndGPU
    case "all": return .all
    case "cpuOnly": return .cpuOnly
    default: throw HelperError("badRequest", "computeUnits must be cpuAndNeuralEngine, cpuAndGPU or all (got \(s)).")
    }
}

/// FNV-1a: a stable key for the "already compiled" markers (Swift's Hasher is seeded per process).
func fnv(_ s: String) -> String {
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    for b in s.utf8 { h = (h ^ UInt64(b)) &* 0x100_0000_01b3 }
    return String(h, radix: 16)
}

private func mtime(_ u: URL) -> Double {
    ((try? FileManager.default.attributesOfItem(atPath: u.path)[.modificationDate]) as? Date)?.timeIntervalSince1970 ?? 0
}

private func msSince(_ t: DispatchTime) -> Int { Int((DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1_000_000) }

struct LoadedControlNet {
    let info: ControlNetInfo
    let model: ManagedMLModel
}

final class Engine {
    let stateDir: URL?
    private(set) var base: BaseModelInfo?
    private(set) var units: String = ""
    private(set) var reduceMemory = false
    private var config = MLModelConfiguration()
    private var textEncoder: TextEncoder?
    private var unet: ManagedMLModel?
    private var unetControlled = false
    /// Where the UNet actually runs ("ane", "gpu", "cpu", or "" when unknown).
    private(set) var unetDevice = ""
    private var unetNote = ""
    private var unetInputs: [String: [Int]] = [:]
    private var encoder: Encoder?
    private var decoder: Decoder?
    private var controlNets: [String: LoadedControlNet] = [:]   // by name
    private var zeroResiduals: [String: MLMultiArray] = [:]
    private var resident = false

    init(stateDir: URL?) { self.stateDir = stateDir }

    var isLoaded: Bool { base != nil }

    var statusJSON: [String: Any] {
        guard let b = base else { return ["loaded": false] }
        return ["loaded": true, "resident": resident, "unetDevice": unetDevice, "modelDir": b.path.path, "computeUnits": units, "width": b.width, "height": b.height,
                "attention": b.attention.rawValue, "controlNets": controlNets.keys.sorted(), "reduceMemory": reduceMemory]
    }

    private func marker(_ what: URL) -> URL? {
        stateDir?.appendingPathComponent("compiled-\(fnv("\(what.path)|\(units)|\(mtime(what))")).txt")
    }

    /// Load (or re-use) a base model + ControlNets. Returns timings and whether this was a first (compiling) load.
    func load(modelDir: URL, computeUnits cu: String, controlNetPaths: [URL], reduceMemory rm: Bool, progress: Progress, cancel: CancelFlag) throws -> [String: Any] {
        let t0 = DispatchTime.now()
        let mlUnits = try computeUnits(cu)
        guard let info = inspectBase(modelDir, sizes: false) else {
            throw HelperError("notFound", "No Core ML Stable Diffusion model in \(modelDir.lastPathComponent) (needs TextEncoder, VAEDecoder, Unet or ControlledUnet .mlmodelc plus vocab.json and merges.txt).")
        }
        if info.kind == "sdxl" { throw HelperError("unsupported", "\(info.name) is an SDXL model. Darkroom's built-in Core ML engine supports SD 1.5-family models (and SD 2.x without ControlNet).") }
        if info.chunked { throw HelperError("unsupported", "\(info.name) has a chunked UNet (an iOS conversion). Use a macOS conversion with a single Unet/ControlledUnet.") }
        var cns: [ControlNetInfo] = []
        for p in controlNetPaths {
            guard let c = inspectControlNet(p, sizes: false) else { throw HelperError("notFound", "\(p.lastPathComponent) is not a Core ML ControlNet (no controlnet_cond input).") }
            cns.append(c)
        }
        if !cns.isEmpty {
            if !info.controlNetSupport {
                throw HelperError("noControlNetUnet", "\(info.name) has no ControlledUnet.mlmodelc: it was converted without --unet-support-controlnet, so it cannot use ControlNet. Download a “_cn” model (e.g. coreml-community/coreml-stable-diffusion-v1-5_cn).")
            }
            for c in cns {
                if c.attention != .unknown && info.attention != .unknown && c.attention != info.attention {
                    throw HelperError("attentionMismatch", "ControlNet \(c.name) is a \(c.attention == .splitEinsum ? "split-einsum (Neural Engine)" : "original (GPU)") conversion but \(info.name) is \(info.attention == .splitEinsum ? "split-einsum" : "original"). Use the matching variant (\(info.attention == .splitEinsum ? "the “-SE” ControlNets" : "the non-SE ControlNets")).")
                }
                if c.width != info.width || c.height != info.height {
                    throw HelperError("wrongResolution", "ControlNet \(c.name) is built for \(c.width)×\(c.height) but \(info.name) generates \(info.width)×\(info.height). Use the ControlNet converted for \(info.width)×\(info.height).")
                }
            }
        }
        let sameBase = base?.path == info.path && units == cu && reduceMemory == rm
        if !sameBase {
            unloadAll()
            config = MLModelConfiguration()
            config.computeUnits = mlUnits
            units = cu
            reduceMemory = rm
            let tok = try BPETokenizer(mergesAt: modelDir.appendingPathComponent("merges.txt"), vocabularyAt: modelDir.appendingPathComponent("vocab.json"))
            textEncoder = TextEncoder(tokenizer: tok, modelAt: modelDir.appendingPathComponent("TextEncoder.mlmodelc"), configuration: config)
            unetControlled = info.controlNetSupport
            let unetURL = modelDir.appendingPathComponent(unetControlled ? "ControlledUnet.mlmodelc" : "Unet.mlmodelc")
            unetDevice = ""
            unetNote = ""
            var unetConfig = config
            if cu == "cpuAndNeuralEngine" || cu == "all" {
                // Core ML silently runs a model it cannot place on the Neural Engine on the CPU (3× slower than the GPU
                // for a UNet). Ask for the compute plan first and give the UNet the GPU in that case.
                progress("planning", 0, 1, "Checking where Core ML can run the UNet…")
                let dev = preferredDevice(unetURL, mlUnits)
                unetDevice = dev ?? ""
                if dev == "cpu" || (cu == "cpuAndNeuralEngine" && dev == "gpu") {
                    unetConfig = MLModelConfiguration()
                    unetConfig.computeUnits = .cpuAndGPU
                    unetDevice = "gpu"
                    unetNote = "Core ML cannot place this UNet on the Neural Engine on this Mac, so it runs on the GPU; the text encoder, VAE and ControlNets stay on the Neural Engine."
                    progress("planning", 1, 1, unetNote)
                }
            }
            unet = ManagedMLModel(modelAt: unetURL, configuration: unetConfig)
            unetInputs = (readMeta(unetURL) ?? ModelMeta()).inputs
            decoder = Decoder(modelAt: modelDir.appendingPathComponent("VAEDecoder.mlmodelc"), configuration: config)
            let enc = modelDir.appendingPathComponent("VAEEncoder.mlmodelc")
            encoder = FileManager.default.fileExists(atPath: enc.path) ? Encoder(modelAt: enc, configuration: config) : nil
            base = info
            resident = false
            zeroResiduals = [:]
        }
        // ControlNets: keep the ones still wanted, add new ones
        let wanted = Dictionary(uniqueKeysWithValues: cns.map { ($0.name, $0) })
        for (k, v) in controlNets where wanted[k]?.path != v.info.path { v.model.unloadResources(); controlNets[k] = nil }
        for c in cns where controlNets[c.name] == nil { controlNets[c.name] = LoadedControlNet(info: c, model: ManagedMLModel(modelAt: c.path, configuration: config)) }

        let compiled = try ensureResident(progress: progress, cancel: cancel)
        return ["ms": msSince(t0), "firstLoad": compiled.first, "parts": compiled.parts, "width": info.width, "height": info.height, "attention": info.attention.rawValue, "controlNetSupport": info.controlNetSupport,
                "unetDevice": unetDevice, "note": unetNote]
    }

    /// The device Core ML prefers for most of a model's estimated cost ("ane" / "gpu" / "cpu"), or nil before macOS 14.4.
    private func preferredDevice(_ url: URL, _ units: MLComputeUnits) -> String? {
        guard #available(macOS 14.4, *) else { return nil }
        let cfg = MLModelConfiguration()
        cfg.computeUnits = units
        let sem = DispatchSemaphore(value: 0)
        final class Box: @unchecked Sendable { var v: String? = nil }
        let box = Box()
        Task.detached {
            defer { sem.signal() }
            guard let plan = try? await MLComputePlan.load(contentsOf: url, configuration: cfg),
                  case let .program(program) = plan.modelStructure, let main = program.functions["main"] else { return }
            var cost: [String: Double] = [:]
            func visit(_ b: MLModelStructure.Program.Block) {
                for op in b.operations {
                    let w = plan.estimatedCost(of: op)?.weight ?? 0
                    switch plan.deviceUsage(for: op)?.preferred {
                    case .some(.neuralEngine): cost["ane", default: 0] += w
                    case .some(.gpu): cost["gpu", default: 0] += w
                    case .some(.cpu): cost["cpu", default: 0] += w
                    default: break
                    }
                    for x in op.blocks { visit(x) }
                }
            }
            visit(main.block)
            box.v = cost.max { $0.value < $1.value }?.key
        }
        sem.wait()
        return box.v
    }

    /// Load every part (Core ML compiles for the chosen compute units the first time — minutes on the Neural Engine).
    private func ensureResident(progress: Progress, cancel: CancelFlag) throws -> (first: Bool, parts: [String: Int]) {
        guard let b = base else { throw HelperError("notLoaded", "No model loaded.") }
        var parts: [String: Int] = [:]
        var anyFirst = false
        var items: [(String, URL, () throws -> Void, () -> Void)] = [
            ("TextEncoder", b.path.appendingPathComponent("TextEncoder.mlmodelc"), { try self.textEncoder?.loadResources() }, { self.textEncoder?.unloadResources() }),
            (unetControlled ? "ControlledUnet" : "Unet", b.path.appendingPathComponent(unetControlled ? "ControlledUnet.mlmodelc" : "Unet.mlmodelc"), { try self.unet?.loadResources() }, { self.unet?.unloadResources() }),
            ("VAEDecoder", b.path.appendingPathComponent("VAEDecoder.mlmodelc"), { try self.decoder?.loadResources() }, { self.decoder?.unloadResources() }),
        ]
        if encoder != nil { items.append(("VAEEncoder", b.path.appendingPathComponent("VAEEncoder.mlmodelc"), { try self.encoder?.loadResources() }, { self.encoder?.unloadResources() })) }
        for (name, c) in controlNets.sorted(by: { $0.key < $1.key }) { items.append(("ControlNet \(name)", c.info.path, { try c.model.loadResources() }, { c.model.unloadResources() })) }
        for (i, (name, url, loadIt, unloadIt)) in items.enumerated() {
            if cancel.isSet { throw HelperError("cancelled", "Cancelled.") }
            let mk = marker(url)
            let first = mk.map { !FileManager.default.fileExists(atPath: $0.path) } ?? false
            anyFirst = anyFirst || first
            let ane = units != "cpuAndGPU" && !(name.hasSuffix("Unet") && unetDevice == "gpu")
            progress(first ? "compiling" : "loading", i, items.count,
                     first ? "Compiling \(name) for the \(ane ? "Neural Engine" : "GPU") (first use; this can take a few minutes)…" : "Loading \(name)…")
            let t = DispatchTime.now()
            do { try loadIt() } catch {
                throw HelperError("loadFailed", "Core ML could not load \(name) with \(units): \(error.localizedDescription)\(units == "cpuAndNeuralEngine" && b.attention == .original ? " — this is an “original” (GPU) conversion; choose GPU compute units for it." : "")")
            }
            parts[name] = msSince(t)
            if reduceMemory && !name.hasPrefix("ControlNet") && name != "ControlledUnet" && name != "Unet" { unloadIt() }
            if let mk, first { try? "\(url.path)\n\(units)\n".write(to: mk, atomically: true, encoding: .utf8) }
        }
        resident = true
        return (anyFirst, parts)
    }

    func unloadResources() {
        textEncoder?.unloadResources()
        unet?.unloadResources()
        decoder?.unloadResources()
        encoder?.unloadResources()
        for c in controlNets.values { c.model.unloadResources() }
        resident = false
    }

    func unloadAll() {
        unloadResources()
        textEncoder = nil; unet = nil; decoder = nil; encoder = nil
        controlNets = [:]
        zeroResiduals = [:]
        base = nil
    }

    // ---------------------------------------------------------------------------------------------- generate
    struct Unit {
        var net: LoadedControlNet
        var cond: MLMultiArray
        var weight: Float
        var start: Float
        var end: Float
    }

    func generate(_ r: [String: Any], progress: Progress, cancel: CancelFlag) throws -> [String: Any] {
        guard let b = base, let textEncoder, let unet, let decoder else { throw HelperError("notLoaded", "Load a model first.") }
        let T0 = DispatchTime.now()
        if !resident { _ = try ensureResident(progress: progress, cancel: cancel) }
        let W = b.width, H = b.height
        if let w = r["width"] as? Int, let h = r["height"] as? Int, w != W || h != H {
            throw HelperError("wrongResolution", "\(b.name) generates \(W)×\(H) only (requested \(w)×\(h)).")
        }
        let prompt = (r["prompt"] as? String) ?? ""
        let negative = (r["negative"] as? String) ?? ""
        let steps = max(1, min(150, (r["steps"] as? Int) ?? 20))
        let guidance = Float((r["guidance"] as? Double) ?? 7.5)
        let seed = UInt32(truncatingIfNeeded: (r["seed"] as? Int) ?? Int.random(in: 0..<Int(UInt32.max)))
        let schedName = (r["scheduler"] as? String) ?? "dpm++"
        var strength = Float((r["strength"] as? Double) ?? 1)
        strength = max(0.01, min(1, strength))

        // inputs
        let init_: RGBA8? = try (r["startingImage"] as? String).map { s in
            let img = try decodeImage(base64: s)
            try requireSize(img, W, H, "The init image")
            return rgba(img, W, H)
        }
        let mask: [Float]? = try (r["mask"] as? String).map { s in
            let img = try decodeImage(base64: s)
            try requireSize(img, W, H, "The mask")
            return maskValues(rgba(img, W, H))
        }
        if mask != nil && init_ == nil { throw HelperError("badRequest", "A mask needs an init image (inpainting).") }
        if init_ != nil && encoder == nil { throw HelperError("noEncoder", "\(b.name) has no VAEEncoder.mlmodelc, so it cannot do img2img or inpainting.") }

        var units: [Unit] = []
        for (i, u) in ((r["controlNetInputs"] as? [[String: Any]]) ?? []).enumerated() {
            guard let name = u["name"] as? String, let net = controlNets[name] else {
                throw HelperError("notLoaded", "ControlNet \(u["name"] ?? "?") is not loaded (load it with the model first).")
            }
            if !unetControlled { throw HelperError("noControlNetUnet", "\(b.name) cannot use ControlNet (no ControlledUnet).") }
            let maskedCond = (u["maskedCond"] as? Bool) ?? false
            var src: RGBA8
            if let s = u["image"] as? String {
                let img = try decodeImage(base64: s)
                try requireSize(img, W, H, "Control image \(i + 1)")
                src = rgba(img, W, H)
            } else if maskedCond, let init_ {
                src = init_
            } else { throw HelperError("badRequest", "Control unit \(i + 1) has no image.") }
            let p = planar(src, lo: 0, hi: 1, mask: maskedCond ? mask : nil, maskValue: -1)
            let both = MLShapedArray<Float32>(concatenating: [p, p], alongAxis: 0)
            units.append(Unit(net: net, cond: MLMultiArray(both), weight: Float((u["weight"] as? Double) ?? 1),
                              start: Float((u["start"] as? Double) ?? 0), end: Float((u["end"] as? Double) ?? 1)))
        }

        // text
        progress("encoding", 0, steps, "Encoding the prompt…")
        let tText = DispatchTime.now()
        let pos = try textEncoder.encode(prompt)
        let neg = try textEncoder.encode(negative)
        if reduceMemory { textEncoder.unloadResources() }
        let hidden = MLMultiArray(toHiddenStates(MLShapedArray<Float32>(concatenating: [neg, pos], alongAxis: 0)))
        let textMs = msSince(tText)
        if cancel.isSet { throw HelperError("cancelled", "Cancelled.") }

        // scheduler + latents (same RNG order as Apple's pipeline: noise first, then the VAE encoder's sample)
        let scheduler: Scheduler
        switch schedName {
        case "pndm": scheduler = PNDMScheduler(stepCount: steps)
        case "dpm++karras": scheduler = DPMSolverMultistepScheduler(stepCount: steps, timeStepSpacing: .karras)
        default: scheduler = DPMSolverMultistepScheduler(stepCount: steps)
        }
        var rng: RandomSource = NumpyRandom(seed: seed)
        let lshape = [1, 4, H / 8, W / 8]
        let noise = MLShapedArray<Float32>(converting: rng.normalShapedArray(lshape, mean: 0, stdev: Double(scheduler.initNoiseSigma)))
        let img2img = init_ != nil && (strength < 1 || mask != nil)
        var x0: MLShapedArray<Float32>? = nil
        var encMs = 0
        if let init_, img2img, let encoder {
            progress("encoding", 0, steps, "Encoding the init image…")
            let t = DispatchTime.now()
            x0 = try encoder.encode(cgImage(init_), scaleFactor: 0.18215, random: &rng)
            if reduceMemory { encoder.unloadResources() }
            encMs = msSince(t)
        }
        let useStrength = img2img && strength < 1
        var latents: MLShapedArray<Float32> = (useStrength && x0 != nil) ? scheduler.addNoise(originalSample: x0!, noise: [noise], strength: strength)[0] : noise
        let timesteps = scheduler.calculateTimesteps(strength: useStrength ? strength : nil)
        let lmask: [Float]? = mask.map { latentMask($0, W, H) }

        // loop
        let tLoop = DispatchTime.now()
        var prof = (cn: 0, mix: 0, unet: 0)
        let n = timesteps.count
        for (i, t) in timesteps.enumerated() {
            if cancel.isSet { throw HelperError("cancelled", "Cancelled.") }
            let latentIn = MLMultiArray(MLShapedArray<Float32>(concatenating: [latents, latents], alongAxis: 0))
            let tArr = MLMultiArray(MLShapedArray<Float32>(scalars: [Float(t), Float(t)], shape: [2]))
            var dict: [String: Any] = ["sample": latentIn, "timestep": tArr, "encoder_hidden_states": hidden]
            if unetControlled {
                let frac = n > 1 ? Float(i) / Float(n - 1) : 0
                let active = units.filter { frac >= $0.start - 1e-4 && frac <= $0.end + 1e-4 && $0.weight != 0 }
                var acc: [String: MLMultiArray] = [:]
                var owned = Set<String>()   // acc entries that are our own fp32 buffers (safe to modify)
                for u in active {
                    if cancel.isSet { throw HelperError("cancelled", "Cancelled.") }
                    let inp = try MLDictionaryFeatureProvider(dictionary: ["sample": latentIn, "timestep": tArr, "encoder_hidden_states": hidden, "controlnet_cond": u.cond])
                    let tc = DispatchTime.now()
                    let out = try u.net.model.perform { try $0.prediction(from: inp) }
                    prof.cn += msSince(tc)
                    let ta = DispatchTime.now()
                    for k in out.featureNames {
                        guard let m = out.featureValue(for: k)?.multiArrayValue else { continue }
                        if let a = acc[k] {
                            let dst = owned.contains(k) ? a : fp32(a)
                            let src = fp32(m)
                            var w = u.weight
                            vDSP_vsma(src.dataPointer.assumingMemoryBound(to: Float.self), 1, &w, dst.dataPointer.assumingMemoryBound(to: Float.self), 1,
                                      dst.dataPointer.assumingMemoryBound(to: Float.self), 1, vDSP_Length(dst.count))
                            acc[k] = dst
                            owned.insert(k)
                        } else if u.weight == 1 {
                            acc[k] = m   // pass Core ML's output straight to the UNet (no copy)
                        } else {
                            let dst = fp32(m)
                            var w = u.weight
                            vDSP_vsmul(dst.dataPointer.assumingMemoryBound(to: Float.self), 1, &w, dst.dataPointer.assumingMemoryBound(to: Float.self), 1, vDSP_Length(dst.count))
                            acc[k] = dst
                            owned.insert(k)
                        }
                    }
                    prof.mix += msSince(ta)
                }
                for (k, shape) in unetInputs where k.hasPrefix("additional_residual") {
                    dict[k] = try acc[k] ?? zeros(k, shape)
                }
            }
            let tu = DispatchTime.now()
            let out = try unet.perform { try $0.prediction(from: MLDictionaryFeatureProvider(dictionary: dict)) }
            prof.unet += msSince(tu)
            guard let name = out.featureNames.first, let m = out.featureValue(for: name)?.multiArrayValue else { throw HelperError("unet", "The UNet returned no output.") }
            let pred = MLShapedArray<Float32>(converting: m).scalars   // [2,4,h,w]: uncond, cond
            let half = pred.count / 2
            let u0 = Array(pred[0..<half]), c0 = Array(pred[half...])
            let guided = vDSP.add(u0, vDSP.multiply(guidance, vDSP.subtract(c0, u0)))
            latents = scheduler.step(output: MLShapedArray(scalars: guided, shape: lshape), timeStep: t, sample: latents)
            if let lmask, let x0 {
                // keep the unmasked area on the original's noise trajectory (latent noise mask)
                let known: [Float]
                if i + 1 < n {
                    let a = scheduler.alphasCumProd[timesteps[i + 1]]
                    known = vDSP.add(vDSP.multiply(a.squareRoot(), x0.scalars), vDSP.multiply((1 - a).squareRoot(), noise.scalars))
                } else { known = x0.scalars }
                let plane = lmask.count
                var s = latents.scalars
                for j in 0..<s.count { let m = lmask[j % plane]; s[j] = s[j] * m + known[j] * (1 - m) }
                latents = MLShapedArray(scalars: s, shape: lshape)
            }
            progress("denoising", i + 1, n, "Step \(i + 1) of \(n)")
        }
        let loopMs = msSince(tLoop)
        if ProcessInfo.processInfo.environment["DARKROOM_COREML_PROFILE"] != nil {
            FileHandle.standardError.write("[profile] loop \(loopMs) ms: controlnet \(prof.cn) ms, mixing \(prof.mix) ms, unet \(prof.unet) ms, other \(loopMs - prof.cn - prof.mix - prof.unet) ms\n".data(using: .utf8)!)
        }
        if reduceMemory {
            unet.unloadResources()
            for c in controlNets.values { c.model.unloadResources() }
        }

        // decode
        progress("decoding", n, n, "Decoding…")
        let tDec = DispatchTime.now()
        guard var img = try decoder.decode([latents], scaleFactor: 0.18215).first else { throw HelperError("decode", "The VAE decoder returned no image.") }
        if reduceMemory { decoder.unloadResources(); resident = false }
        if let mask, let init_ { img = composite(generated: img, original: init_, mask: mask) }
        let png = try pngData(img)
        let decMs = msSince(tDec)
        return ["image": png.base64EncodedString(), "width": img.width, "height": img.height, "seed": Int(seed),
                "timings": ["totalMs": msSince(T0), "textMs": textMs, "encodeMs": encMs, "denoiseMs": loopMs, "decodeMs": decMs,
                            "stepsPerSec": loopMs > 0 ? Double(n) / (Double(loopMs) / 1000) : 0, "steps": n]]
    }

    /// A contiguous fp32 copy (Core ML outputs may be fp16 and/or have padded strides).
    private func fp32(_ m: MLMultiArray) -> MLMultiArray {
        if m.dataType == .float32 && isContiguous(m) { return MLMultiArray(concatenating: [m], axis: 0, dataType: .float32) }
        return MLMultiArray(concatenating: [m], axis: 0, dataType: .float32)
    }

    private func isContiguous(_ m: MLMultiArray) -> Bool {
        var expect = 1
        for (dim, stride) in zip(m.shape.reversed(), m.strides.reversed()) {
            if stride.intValue != expect { return false }
            expect *= dim.intValue
        }
        return true
    }

    private func zeros(_ k: String, _ shape: [Int]) throws -> MLMultiArray {
        if let z = zeroResiduals[k] { return z }
        let z = MLMultiArray(MLShapedArray<Float32>(repeating: 0, shape: shape))
        zeroResiduals[k] = z
        return z
    }

    /// [2, 77, 768] → [2, 768, 1, 77] (the layout Apple's UNet conversions expect).
    private func toHiddenStates(_ e: MLShapedArray<Float32>) -> MLShapedArray<Float32> {
        let s = e.shape, src = e.scalars
        var out = [Float32](repeating: 0, count: src.count)
        for b in 0..<s[0] { for t in 0..<s[1] { for c in 0..<s[2] { out[(b * s[2] + c) * s[1] + t] = src[(b * s[1] + t) * s[2] + c] } } }
        return MLShapedArray(scalars: out, shape: [s[0], s[2], 1, s[1]])
    }
}
