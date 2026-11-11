// NumPy-compatible normal RNG (MT19937 + the legacy polar Box–Muller `gauss`), so a seed gives the same starting
// noise as Apple's StableDiffusionSample CLI / Mochi Diffusion (their NumPyRandomSource is internal to the package).
import CoreML
import StableDiffusion

struct NumpyRandom: RandomSource {
    private var mt = [UInt32](repeating: 0, count: 624)
    private var index = 624
    private var cached: Double? = nil

    init(seed: UInt32) {
        mt[0] = seed
        for i in 1..<624 { mt[i] = 1_812_433_253 &* (mt[i - 1] ^ (mt[i - 1] >> 30)) &+ UInt32(i) }
    }

    private mutating func twist() {
        for i in 0..<624 {
            let y = (mt[i] & 0x8000_0000) | (mt[(i + 1) % 624] & 0x7fff_ffff)
            var v = mt[(i + 397) % 624] ^ (y >> 1)
            if y & 1 != 0 { v ^= 0x9908_b0df }
            mt[i] = v
        }
        index = 0
    }

    mutating func nextUInt32() -> UInt32 {
        if index >= 624 { twist() }
        var y = mt[index]
        index += 1
        y ^= y >> 11
        y ^= (y << 7) & 0x9d2c_5680
        y ^= (y << 15) & 0xefc6_0000
        y ^= y >> 18
        return y
    }

    mutating func nextDouble() -> Double {
        let a = Double(nextUInt32() >> 5), b = Double(nextUInt32() >> 6)
        return (a * 67_108_864.0 + b) / 9_007_199_254_740_992.0
    }

    mutating func nextGauss() -> Double {
        if let c = cached { cached = nil; return c }
        var x1 = 0.0, x2 = 0.0, r2 = 0.0
        repeat {
            x1 = 2 * nextDouble() - 1
            x2 = 2 * nextDouble() - 1
            r2 = x1 * x1 + x2 * x2
        } while r2 >= 1 || r2 == 0
        let f = (-2 * log(r2) / r2).squareRoot()
        cached = f * x1
        return f * x2
    }

    mutating func nextNormal(mean: Double, stdev: Double) -> Double { nextGauss() * stdev + mean }

    mutating func normalShapedArray(_ shape: [Int], mean: Double, stdev: Double) -> MLShapedArray<Double> {
        let n = shape.reduce(1, *)
        return MLShapedArray(scalars: (0..<n).map { _ in nextNormal(mean: mean, stdev: stdev) }, shape: shape)
    }
}
