// PNG ⇄ CGImage ⇄ planar float tensors (ml-stable-diffusion keeps its own converters internal).
import CoreGraphics
import CoreML
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct RGBA8 {
    var width: Int
    var height: Int
    var bytes: [UInt8]
}

func decodeImage(base64: String) throws -> CGImage {
    guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
          let src = CGImageSourceCreateWithData(data as CFData, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        throw HelperError("badImage", "Could not decode an input image (expected a base64 PNG or JPEG).")
    }
    return img
}

let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

/// Draw into an sRGB RGBA8 buffer of exactly w×h (the image is scaled if it differs).
func rgba(_ img: CGImage, _ w: Int, _ h: Int) -> RGBA8 {
    var buf = [UInt8](repeating: 0, count: w * h * 4)
    buf.withUnsafeMutableBytes { p in
        let ctx = CGContext(data: p.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: sRGB,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.interpolationQuality = .high
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return RGBA8(width: w, height: h, bytes: buf)
}

func requireSize(_ img: CGImage, _ w: Int, _ h: Int, _ what: String) throws {
    if img.width != w || img.height != h {
        throw HelperError("wrongResolution", "\(what) is \(img.width)×\(img.height) but this model works at \(w)×\(h) only. Resize or crop it to \(w)×\(h) first (Darkroom does this automatically).")
    }
}

/// [1, 3, H, W] planar RGB mapped from 0…255 to lo…hi. `masked`: pixels where mask > 0.5 become `maskValue`.
func planar(_ im: RGBA8, lo: Float, hi: Float, mask: [Float]? = nil, maskValue: Float = -1) -> MLShapedArray<Float32> {
    let n = im.width * im.height
    var out = [Float32](repeating: 0, count: 3 * n)
    let k = (hi - lo) / 255
    for i in 0..<n {
        let m = mask.map { $0[i] > 0.5 } ?? false
        for c in 0..<3 { out[c * n + i] = m ? maskValue : lo + Float(im.bytes[i * 4 + c]) * k }
    }
    return MLShapedArray(scalars: out, shape: [1, 3, im.height, im.width])
}

/// Mask (white = regenerate) from the red channel, 0…1, H×W.
func maskValues(_ im: RGBA8) -> [Float] {
    (0..<(im.width * im.height)).map { Float(im.bytes[$0 * 4]) / 255 }
}

/// Box-downsample a W×H mask to the latent grid (W/8 × H/8).
func latentMask(_ m: [Float], _ w: Int, _ h: Int) -> [Float] {
    let lw = w / 8, lh = h / 8
    var out = [Float](repeating: 0, count: lw * lh)
    for y in 0..<lh {
        for x in 0..<lw {
            var s: Float = 0
            for yy in 0..<8 { for xx in 0..<8 { s += m[(y * 8 + yy) * w + x * 8 + xx] } }
            out[y * lw + x] = s / 64
        }
    }
    return out
}

func pngData(_ img: CGImage) throws -> Data {
    let d = NSMutableData()
    guard let dst = CGImageDestinationCreateWithData(d, UTType.png.identifier as CFString, 1, nil) else { throw HelperError("encode", "PNG encoder unavailable") }
    CGImageDestinationAddImage(dst, img, nil)
    guard CGImageDestinationFinalize(dst) else { throw HelperError("encode", "PNG encoding failed") }
    return d as Data
}

func cgImage(_ im: RGBA8) -> CGImage {
    let data = Data(im.bytes) as CFData
    let prov = CGDataProvider(data: data)!
    return CGImage(width: im.width, height: im.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: im.width * 4, space: sRGB,
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: prov, decode: nil,
                   shouldInterpolate: true, intent: .defaultIntent)!
}

/// Inpainting: keep the original outside the (soft) mask so unmasked pixels are untouched by the VAE round trip.
func composite(generated: CGImage, original: RGBA8, mask: [Float]) -> CGImage {
    var g = rgba(generated, original.width, original.height)
    for i in 0..<(original.width * original.height) {
        let a = mask[i]
        for c in 0..<3 {
            let j = i * 4 + c
            g.bytes[j] = UInt8(max(0, min(255, (Float(g.bytes[j]) * a + Float(original.bytes[j]) * (1 - a)).rounded())))
        }
        g.bytes[i * 4 + 3] = 255
    }
    return cgImage(g)
}
