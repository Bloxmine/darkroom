// Diagnostic: `darkroom-coreml --compute-plan <x.mlmodelc> <computeUnits>` prints how many ML Program operations
// Core ML would place on the CPU, GPU and Neural Engine (MLComputePlan, macOS 14.4+).
import CoreML
import Foundation

func printComputePlan(_ path: String, _ units: String) async {
    guard #available(macOS 14.4, *) else { print("needs macOS 14.4"); return }
    do {
        let cfg = MLModelConfiguration()
        cfg.computeUnits = try computeUnits(units)
        let plan = try await MLComputePlan.load(contentsOf: URL(fileURLWithPath: path), configuration: cfg)
        guard case let .program(program) = plan.modelStructure, let main = program.functions["main"] else { print("not an ML program"); return }
        var counts: [String: Int] = [:], cost: [String: Double] = [:], cpuOps: [String: Int] = [:]
        func visit(_ block: MLModelStructure.Program.Block) {
            for op in block.operations {
                let dev = plan.deviceUsage(for: op)?.preferred
                let name: String
                switch dev {
                case .some(.cpu): name = "cpu"
                case .some(.gpu): name = "gpu"
                case .some(.neuralEngine): name = "ane"
                default: name = "none"
                }
                counts[name, default: 0] += 1
                cost[name, default: 0] += plan.estimatedCost(of: op)?.weight ?? 0
                if name == "cpu" { cpuOps[op.operatorName, default: 0] += 1 }
                for b in op.blocks { visit(b) }
            }
        }
        visit(main.block)
        FileHandle.standardError.write("ops by device: \(counts)\nestimated cost share: \(cost.mapValues { (($0 * 1000).rounded()) / 1000 })\ncpu ops: \(cpuOps)\n".data(using: .utf8)!)
    } catch {
        FileHandle.standardError.write("compute plan failed: \(error)\n".data(using: .utf8)!)
    }
}
