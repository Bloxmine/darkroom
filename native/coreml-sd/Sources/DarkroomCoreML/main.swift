// darkroom-coreml — Darkroom's Core ML Stable Diffusion helper.
//
// Protocol: JSON lines. Requests arrive on stdin, one object per line: {"id": "…", "cmd": "…", …}.
// Replies go to stdout: {"id": "…", "ok": true, "result": {…}} or {"id": "…", "ok": false, "error": {"code", "message"}},
// plus events {"event": "progress", "id": "…", "phase", "step", "total", "message"} and {"event": "state", …}.
// Why stdio and not a localhost socket: nothing else on the machine can reach the helper (no port, no token to
// leak), the parent owns its lifetime (stdin EOF = exit), and there is nothing to configure or firewall.
// Anything the frameworks print goes to stderr: stdout is reserved for the protocol.
//
// Commands: hello · listModels {roots} · load {modelDir, computeUnits, controlNets[], reduceMemory?, idleUnloadSeconds?}
//           · generate {prompt, negative, seed, steps, guidance, scheduler, startingImage?, strength?, mask?,
//             controlNetInputs[{name, image?, weight, start, end, maskedCond?}], width, height} · cancel {target?}
//           · unload · status · shutdown
// CLI: `darkroom-coreml --version`, `darkroom-coreml --list <dir>…` (prints the listModels JSON).
import CoreML
import Foundation

let VERSION = "1.0.0"
setvbuf(stderr, nil, _IONBF, 0)

// Reserve the real stdout for the protocol; send fd 1 (print() inside frameworks) to stderr.
let protoFD = dup(STDOUT_FILENO)
dup2(STDERR_FILENO, STDOUT_FILENO)
let out = FileHandle(fileDescriptor: protoFD, closeOnDealloc: false)
let outLock = NSLock()

func send(_ obj: [String: Any]) {
    guard var d = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) else { return }
    d.append(0x0a)
    outLock.lock()
    out.write(d)
    outLock.unlock()
}
func reply(_ id: String, _ result: [String: Any]) { send(["id": id, "ok": true, "result": result]) }
func fail(_ id: String, _ e: Error) {
    let he = e as? HelperError ?? HelperError("error", (e as NSError).localizedDescription)
    send(["id": id, "ok": false, "error": ["code": he.code, "message": he.message]])
}

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: name), i + 1 < a.count else { return nil }
    return a[i + 1]
}

func hello() -> [String: Any] {
    var info: [String: Any] = ["version": VERSION, "os": ProcessInfo.processInfo.operatingSystemVersionString, "memoryBytes": ProcessInfo.processInfo.physicalMemory, "pid": getpid()]
    #if arch(arm64)
    info["arch"] = "arm64"
    #else
    info["arch"] = "x86_64"
    #endif
    if #available(macOS 14.0, *) {
        info["neuralEngine"] = MLComputeDevice.allComputeDevices.contains { if case .neuralEngine = $0 { return true } else { return false } }
    } else {
        #if arch(arm64)
        info["neuralEngine"] = true
        #else
        info["neuralEngine"] = false
        #endif
    }
    return info
}

func listModels(_ roots: [URL]) -> [String: Any] {
    let r = scanModels(roots: roots)
    return ["models": r.bases.map(\.json), "controlNets": r.controlNets.map(\.json)]
}

if CommandLine.arguments.contains("--version") {
    FileHandle.standardError.write("darkroom-coreml \(VERSION)\n".data(using: .utf8)!)
    send(hello())
    exit(0)
}
if let i = CommandLine.arguments.firstIndex(of: "--compute-plan"), i + 2 < CommandLine.arguments.count {
    let sem = DispatchSemaphore(value: 0)
    Task { await printComputePlan(CommandLine.arguments[i + 1], CommandLine.arguments[i + 2]); sem.signal() }
    sem.wait()
    exit(0)
}
if CommandLine.arguments.contains("--list") {
    let dirs = CommandLine.arguments.drop { $0 != "--list" }.dropFirst().map { URL(fileURLWithPath: $0) }
    send(listModels(Array(dirs)))
    exit(0)
}

let stateDir = arg("--state-dir").map { URL(fileURLWithPath: $0, isDirectory: true) }
if let stateDir { try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true) }
let engine = Engine(stateDir: stateDir)
let work = DispatchQueue(label: "darkroom.coreml.work")
let stateQ = DispatchQueue(label: "darkroom.coreml.state")
var current: (id: String, cmd: String, cancel: CancelFlag)? = nil
var idleTimer: DispatchWorkItem? = nil
var idleSeconds: Double = Double(arg("--idle-unload") ?? "") ?? 300

func setState(_ s: String, _ extra: [String: Any] = [:]) {
    var o: [String: Any] = ["event": "state", "state": s]
    for (k, v) in extra { o[k] = v }
    send(o)
}

/// After a job: free the models' memory if nothing else arrives for a while (the compiled models stay cached on
/// disk by Core ML, so the next generate reloads in seconds).
func scheduleIdleUnload() {
    stateQ.sync {
        idleTimer?.cancel()
        guard idleSeconds > 0 else { return }
        let item = DispatchWorkItem {
            work.async {
                guard engine.isLoaded else { return }
                engine.unloadResources()
                setState("unloaded", ["reason": "idle"])
            }
        }
        idleTimer = item
        DispatchQueue.global().asyncAfter(deadline: .now() + idleSeconds, execute: item)
    }
}

/// Run a job on the serial work queue (one at a time). A second load/generate while one runs is rejected with
/// `busy` (Electron main queues jobs itself); cancel and status are answered immediately.
func runJob(_ id: String, _ cmd: String, _ body: @escaping (CancelFlag) throws -> [String: Any]) {
    let flag = CancelFlag()
    var busy: (String, String)? = nil
    stateQ.sync {
        if let c = current { busy = (c.id, c.cmd) } else { current = (id, cmd, flag); idleTimer?.cancel() }
    }
    if let (bid, bcmd) = busy {
        let compiling = bcmd == "load"
        fail(id, HelperError(compiling ? "compiling" : "busy", compiling ? "The model is still loading (the first load compiles it for the Neural Engine and can take minutes). Try again when it is ready." : "Another generation (\(bid)) is running."))
        return
    }
    work.async {
        do { reply(id, try body(flag)) } catch { fail(id, error) }
        stateQ.sync { current = nil }
        setState(engine.isLoaded ? "ready" : "idle", engine.statusJSON)
        scheduleIdleUnload()
    }
}

func progressFor(_ id: String) -> Progress {
    var last = DispatchTime.now()
    return { phase, step, total, message in
        let now = DispatchTime.now()
        if phase == "denoising" && step < total && now.uptimeNanoseconds - last.uptimeNanoseconds < 50_000_000 { return }
        last = now
        send(["event": "progress", "id": id, "phase": phase, "step": step, "total": total, "message": message])
    }
}

func handle(_ line: String) {
    guard let data = line.data(using: .utf8), let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        send(["id": "", "ok": false, "error": ["code": "badRequest", "message": "Not a JSON object"]])
        return
    }
    let id = (req["id"] as? String) ?? ""
    let cmd = (req["cmd"] as? String) ?? ""
    switch cmd {
    case "hello":
        reply(id, hello())
    case "status":
        var s = engine.statusJSON
        stateQ.sync { s["busy"] = current.map { ["id": $0.id, "cmd": $0.cmd] } as Any? ?? NSNull() }
        reply(id, s)
    case "listModels":
        let roots = ((req["roots"] as? [String]) ?? []).map { URL(fileURLWithPath: $0, isDirectory: true) }
        DispatchQueue.global().async { reply(id, listModels(roots)) }
    case "load":
        guard let dir = req["modelDir"] as? String else { return fail(id, HelperError("badRequest", "load needs modelDir")) }
        let cu = (req["computeUnits"] as? String) ?? "cpuAndNeuralEngine"
        let cns = ((req["controlNets"] as? [String]) ?? []).map { URL(fileURLWithPath: $0, isDirectory: true) }
        let rm = (req["reduceMemory"] as? Bool) ?? false
        if let s = req["idleUnloadSeconds"] as? Double { stateQ.sync { idleSeconds = s } }
        runJob(id, "load") { flag in
            setState("loading", ["modelDir": dir, "computeUnits": cu])
            return try engine.load(modelDir: URL(fileURLWithPath: dir, isDirectory: true), computeUnits: cu, controlNetPaths: cns, reduceMemory: rm, progress: progressFor(id), cancel: flag)
        }
    case "generate":
        runJob(id, "generate") { flag in
            setState("busy", ["job": id])
            return try engine.generate(req, progress: progressFor(id), cancel: flag)
        }
    case "cancel":
        let target = req["target"] as? String
        var hit = false
        stateQ.sync { if let c = current, target == nil || c.id == target { c.cancel.set(); hit = true } }
        reply(id, ["cancelled": hit])
    case "unload":
        work.async {
            engine.unloadAll()
            reply(id, ["unloaded": true])
            setState("idle")
        }
    case "shutdown":
        reply(id, ["bye": true])
        exit(0)
    default:
        fail(id, HelperError("badRequest", "Unknown command “\(cmd)”."))
    }
}

send(["event": "ready", "version": VERSION])
while let line = readLine(strippingNewline: true) {
    if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
    handle(line)
}
// stdin closed: the app quit or crashed
exit(0)
