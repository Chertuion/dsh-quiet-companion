import AppKit
import SpriteKit
import CryptoKit

/// Standalone, silent visual QA. This exports only this process's SpriteKit
/// scene through SKView.texture(from:crop:); it never captures a display/window.
/// Deliberately excluded from build.sh and the shipped helper.
@main
struct AvatarMeshRenderQA {
    struct QAError: Error, CustomStringConvertible {
        let description: String
        init(_ description: String) { self.description = description }
    }

    struct Pixels {
        let width: Int
        let height: Int
        let bytes: [UInt8]

        init(_ image: CGImage) throws {
            let pixelWidth = image.width, pixelHeight = image.height
            var storage = [UInt8](repeating: 0, count: pixelWidth * pixelHeight * 4)
            let made = storage.withUnsafeMutableBytes { pointer -> Bool in
                guard let context = CGContext(data: pointer.baseAddress, width: pixelWidth, height: pixelHeight,
                    bitsPerComponent: 8, bytesPerRow: pixelWidth * 4,
                    space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
                else { return false }
                context.draw(image, in: CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight))
                return true
            }
            guard made else { throw QAError("Cannot create RGBA pixel context") }
            width = pixelWidth; height = pixelHeight; bytes = storage
        }

        var alphaMetrics: [String: Any] {
            var zero = 0, opaque = 0, visible = 0
            var left = width, top = height, right = -1, bottom = -1
            for y in 0..<height { for x in 0..<width {
                let a = bytes[(y * width + x) * 4 + 3]
                if a == 0 { zero += 1 }
                if a >= 250 { opaque += 1 }
                if a > 8 {
                    visible += 1; left = min(left, x); top = min(top, y)
                    right = max(right, x); bottom = max(bottom, y)
                }
            } }
            return ["width": width, "height": height, "transparentPixels": zero,
                    "opaquePixels": opaque, "visiblePixels": visible,
                    "visibleBoundsTopLeft": right >= left ? [left, top, right - left + 1, bottom - top + 1] : [],
                    "cornerAlpha": [bytes[3], bytes[(width - 1) * 4 + 3],
                        bytes[((height - 1) * width) * 4 + 3], bytes[(height * width - 1) * 4 + 3]]]
        }
    }

    @MainActor
    static func main() {
        do { try run() }
        catch {
            FileHandle.standardError.write(Data("Scene QA failed: \(error)\n".utf8))
            exit(1)
        }
    }

    @MainActor
    static func pump(_ seconds: Double) {
        let until = Date().addingTimeInterval(seconds)
        while Date() < until {
            _ = RunLoop.main.run(mode: .default, before: min(until, Date().addingTimeInterval(0.02)))
        }
    }

    @MainActor
    static func wait(_ message: String, _ predicate: () -> Bool) throws {
        let until = Date().addingTimeInterval(3)
        while !predicate(), Date() < until { pump(0.025) }
        guard predicate() else { throw QAError(message) }
    }

    static func findSKView(_ view: NSView) -> SKView? {
        if let value = view as? SKView { return value }
        return view.subviews.lazy.compactMap { findSKView($0) }.first
    }

    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    static func writePNG(_ image: CGImage, _ path: URL) throws {
        guard let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        else { throw QAError("PNG encoding failed: \(path.lastPathComponent)") }
        try data.write(to: path, options: .atomic)
    }

    @MainActor
    static func snapshot(_ view: SKView) throws -> CGImage {
        guard let scene = view.scene,
              let texture = view.texture(from: scene, crop: CGRect(origin: .zero, size: scene.size))
        else { throw QAError("SpriteKit could not export its own scene texture") }
        return texture.cgImage()
    }

    @MainActor
    static func run() throws {
        let arguments = CommandLine.arguments
        guard arguments.count == 3 else {
            throw QAError("Usage: AvatarMeshRenderQA <orange-character-assets> <output-directory>")
        }
        let assets = URL(fileURLWithPath: arguments[1], isDirectory: true)
        let output = URL(fileURLWithPath: arguments[2], isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let manifestData = try Data(contentsOf: assets.appendingPathComponent("pet-manifest.json"))
        guard let manifest = try JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
              manifest["characterId"] as? String == "orange-q-companion",
              manifest["schemaVersion"] as? Int == 3,
              let sheets = manifest["sheets"] as? [String: String],
              let clips = manifest["clips"] as? [String: [String: Any]],
              let frames = clips["replying"]?["frames"] as? [[String: Any]], frames.count == 8,
              let staticMouths = manifest["staticMouths"] as? [String: [Double]]
        else { throw QAError("Expected current Q schema3 assets with eight replying frames") }

        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        application.finishLaunching()
        let renderer = AvatarMeshRenderer()
        renderer.setMotionEnabled(false) // Deterministic comparison: real mouth renderer, identity mesh.
        let window = NSWindow(contentRect: CGRect(x: 30, y: 30, width: 210, height: 270),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.title = "Quiet Companion — own-scene render QA"
        window.isReleasedWhenClosed = false
        window.isOpaque = false; window.backgroundColor = .clear
        window.ignoresMouseEvents = true
        window.contentView = renderer.view
        window.orderFrontRegardless()
        defer { renderer.stop(); window.orderOut(nil); window.close() }
        guard let skView = findSKView(renderer.view) else { throw QAError("Renderer's SKView not found") }
        try wait("Own SpriteKit scene did not render; check session availability") {
            (renderer.diagnostics["sceneFrameCount"] as? UInt64 ?? 0) >= 2
        }

        var records: [[String: Any]] = []
        var contactImages: [(String, CGImage)] = []
        var sourceHashes: [String: String] = ["pet-manifest.json": hash(manifestData)]

        func load(_ relative: String) throws -> CGImage {
            let url = assets.appendingPathComponent(relative)
            let data = try Data(contentsOf: url)
            sourceHashes[relative] = hash(data)
            guard let image = NSImage(data: data)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
            else { throw QAError("Cannot decode \(relative)") }
            return image
        }

        func renderPair(name: String, image: CGImage, mouth: [Double], viewport: CGSize,
                        logicalImageSize: CGSize, action: String) throws {
            guard mouth.count == 4 else { throw QAError("Missing calibration for \(name)") }
            window.setContentSize(viewport)
            renderer.view.frame = CGRect(origin: .zero, size: viewport)
            renderer.setAction(action)
            renderer.setImage(NSImage(cgImage: image, size: logicalImageSize),
                              geometry: AvatarMeshGeometry(mouthRect: mouth))
            renderer.setMouthLevel(0)
            let prior = renderer.diagnostics["sceneFrameCount"] as? UInt64 ?? 0
            try wait("No closed scene frames for \(name)") {
                (renderer.diagnostics["sceneFrameCount"] as? UInt64 ?? 0) >= prior + 2
            }
            let closed = try snapshot(skView)
            let closedPixels = try Pixels(closed)
            let closedName = "\(name)-closed.png"
            try writePNG(closed, output.appendingPathComponent(closedName))

            renderer.setMouthLevel(0.9)
            try wait("Mouth did not open for \(name)") {
                (renderer.diagnostics["mouthLevel"] as? Double ?? 0) > 0.88 &&
                renderer.diagnostics["mouthVisible"] as? Bool == true
            }
            let open = try snapshot(skView)
            let openPixels = try Pixels(open)
            let openName = "\(name)-open.png"
            try writePNG(open, output.appendingPathComponent(openName))
            guard open.width == closed.width, open.height == closed.height else { throw QAError("Scene texture resized unexpectedly") }

            // Texture pixels are top-left rows. SpriteKit scene coordinates are bottom-left.
            let fitted = AvatarMeshGrid.imageRect(imageSize: logicalImageSize, viewport: viewport)
            let scaleX = CGFloat(open.width) / viewport.width, scaleY = CGFloat(open.height) / viewport.height
            let expected = CGRect(x: (fitted.minX + CGFloat(mouth[0]) * fitted.width) * scaleX,
                y: (viewport.height - fitted.maxY + CGFloat(mouth[1]) * fitted.height) * scaleY,
                width: CGFloat(mouth[2]) * fitted.width * scaleX,
                height: CGFloat(mouth[3]) * fitted.height * scaleY)
            let accepted = expected.insetBy(dx: -3, dy: -3)
            var changed = 0, outside = 0
            var left = open.width, top = open.height, right = -1, bottom = -1
            for y in 0..<open.height { for x in 0..<open.width {
                let index = (y * open.width + x) * 4
                let delta = (0..<4).reduce(0) { $0 + abs(Int(closedPixels.bytes[index + $1]) - Int(openPixels.bytes[index + $1])) }
                if delta >= 20 {
                    changed += 1; left = min(left, x); top = min(top, y)
                    right = max(right, x); bottom = max(bottom, y)
                    if !accepted.contains(CGPoint(x: CGFloat(x) + 0.5, y: CGFloat(y) + 0.5)) { outside += 1 }
                }
            } }
            let alpha = openPixels.alphaMetrics
            guard (alpha["visiblePixels"] as? Int ?? 0) > 500,
                  (alpha["transparentPixels"] as? Int ?? 0) > open.width * open.height / 20,
                  (alpha["cornerAlpha"] as? [UInt8] ?? []).allSatisfy({ $0 == 0 })
            else { throw QAError("Missing character or genuine scene alpha for \(name)") }
            guard changed >= 4, outside <= 3 else {
                throw QAError("Mouth changes outside calibrated face region for \(name): changed=\(changed), outside=\(outside), bounds=\([left,top,right,bottom]), expected=\(expected)")
            }
            let point = renderer.mouthPoint()
            records.append(["name": name, "closed": closedName, "open": openName,
                "viewport": [viewport.width, viewport.height], "alpha": alpha,
                "calibratedMouthPixelsTopLeft": [expected.minX, expected.minY, expected.width, expected.height],
                "changedPixels": changed, "changedOutsideCalibrationPlus3px": outside,
                "changedBoundsTopLeft": [left, top, right - left + 1, bottom - top + 1],
                "mouthPointView": point.map { [$0.x, $0.y] } ?? [],
                "diagnostics": renderer.diagnostics])
            contactImages.append((name + " closed", closed)); contactImages.append((name + " open", open))
            renderer.setMouthLevel(0)
        }

        for name in ["idle", "shy"] {
            let image = try load("\(name).png")
            guard let mouth = staticMouths[name] else { throw QAError("No static \(name) calibration") }
            try renderPair(name: "static-\(name)", image: image, mouth: mouth,
                viewport: CGSize(width: 210, height: 270),
                logicalImageSize: CGSize(width: image.width, height: image.height), action: name)
        }
        for (index, frame) in frames.enumerated() {
            guard let sheet = frame["sheet"] as? String, let relative = sheets[sheet],
                  let row = frame["row"] as? Int, let column = frame["column"] as? Int,
                  let mouth = frame["mouth"] as? [Double] else { throw QAError("Bad replying frame \(index)") }
            let sheetImage = try load(relative)
            let x = column * sheetImage.width / 4, y = row * sheetImage.height / 4
            let right = (column + 1) * sheetImage.width / 4, bottom = (row + 1) * sheetImage.height / 4
            guard let cell = sheetImage.cropping(to: CGRect(x: x, y: y, width: right - x, height: bottom - y))
            else { throw QAError("Replying cell crop failed") }
            try renderPair(name: String(format: "replying-%02d", index + 1), image: cell, mouth: mouth,
                viewport: CGSize(width: 280, height: 270), logicalImageSize: CGSize(width: 512, height: 512), action: "replying")
        }
        try contactSheet(contactImages, output.appendingPathComponent("contact-sheet.png"))
        let report: [String: Any] = ["passed": true, "exportMethod": "SKView.texture(from:ownScene,crop:)",
            "desktopScreenshot": false, "audioPlayback": false, "captureOrPermissions": false,
            "characterId": "orange-q-companion", "pairs": records.count,
            "meshMotionForPairComparison": false, "mouthInput": "synthetic level 0 / 0.9; no speech synthesis",
            "productionLogicalViewport": true, "sourceSHA256": sourceHashes,
            "renders": records, "contactSheet": "contact-sheet.png"]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: output.appendingPathComponent("report.json"), options: .atomic)
        print(String(data: try JSONSerialization.data(withJSONObject: ["passed": true,
            "pairs": records.count, "output": output.path, "desktopScreenshot": false,
            "audioPlayback": false], options: [.sortedKeys]), encoding: .utf8)!)
    }

    @MainActor
    static func contactSheet(_ images: [(String, CGImage)], _ path: URL) throws {
        let columns = 4, cellWidth = 300, cellHeight = 306
        let rows = (images.count + columns - 1) / columns
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: columns * cellWidth,
            pixelsHigh: rows * cellHeight, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: rep) else { throw QAError("Contact sheet bitmap allocation failed") }
        NSGraphicsContext.saveGraphicsState(); NSGraphicsContext.current = context
        NSColor(calibratedWhite: 0.94, alpha: 1).setFill()
        CGRect(x: 0, y: 0, width: columns * cellWidth, height: rows * cellHeight).fill()
        for (index, item) in images.enumerated() {
            let x = (index % columns) * cellWidth
            let y = (rows - 1 - index / columns) * cellHeight
            // Checkerboard is composited only in this overview; individual exports retain alpha.
            for cy in 0..<14 { for cx in 0..<15 {
                NSColor(calibratedWhite: (cx + cy) % 2 == 0 ? 0.92 : 0.99, alpha: 1).setFill()
                CGRect(x: x + cx * 20, y: y + cy * 20 + 22, width: 20, height: 20).fill()
            } }
            let image = NSImage(cgImage: item.1, size: CGSize(width: item.1.width, height: item.1.height))
            // SKView exports backing pixels (2x on Retina), while each cell is
            // logical size. Fit rather than letting those pixels overlap cells.
            let fitted = AvatarMeshGrid.imageRect(imageSize: image.size,
                                                  viewport: CGSize(width: cellWidth, height: 280))
            image.draw(in: fitted.offsetBy(dx: CGFloat(x), dy: CGFloat(y + 22)))
            (item.0 as NSString).draw(at: CGPoint(x: x + 10, y: y + 5), withAttributes: [
                .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .medium), .foregroundColor: NSColor.black])
        }
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        guard let image = rep.cgImage else { throw QAError("Contact sheet CGImage missing") }
        try writePNG(image, path)
    }
}
