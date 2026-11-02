import AppKit
import ImageIO

/// Orange character only. A validated 4x4 PNG sheet manifest supplies four
/// keyframes per clip; unknown identities and incomplete assets fail closed.
final class PetAnimationPlayer {
    static let expectedCharacterID = "orange-book-companion"
    static let requiredClips = [
        "idle", "waiting", "thinking", "working", "working_search", "working_command",
        "success", "error", "dragging", "dragging_release", "head_pat", "poke",
        "skirt", "eat_token", "idle_stretch", "idle_yawn"
    ]

    private struct Frame: Decodable {
        let sheet: String
        let row: Int
        let column: Int
    }
    private struct Clip: Decodable {
        let frames: [Frame]
        let frameMs: Double
        let loop: Bool
    }
    private struct Manifest: Decodable {
        let schemaVersion: Int
        let characterId: String
        let columns: Int
        let rows: Int
        let sheets: [String: String]
        let clips: [String: Clip]
        let stateMap: [String: String]
        let workingActivityMap: [String: String]
        /// Optional normalized rectangles [x,y,width,height], top-left origin.
        let hitRegions: [String: [Double]]?
        /// Optional normalized points [x,y], top-left origin.
        let anchors: [String: [Double]]?
    }

    private let root: URL
    private let manifest: Manifest?
    private let onFrame: (NSImage) -> Void
    private var timer: Timer?
    private var frameIndex = 0
    private var decoded: [Int: NSImage] = [:]
    private var cacheOrder: [Int] = []
    private var sheetImages: [String: CGImage] = [:]
    private var sheetOrder: [String] = []
    private var sheetBytes = 0
    private var transient = false
    private var reduced = false
    private var baseClip = "idle"
    private(set) var currentClip = ""
    var available: Bool { manifest != nil }
    var characterID: String? { manifest?.characterId }
    var clipCount: Int { manifest?.clips.count ?? 0 }
    var frameCount: Int { manifest?.clips.values.reduce(0) { $0 + $1.frames.count } ?? 0 }

    init(root: URL, onFrame: @escaping (NSImage) -> Void) {
        self.root = root
        self.onFrame = onFrame
        if let data = try? Data(contentsOf: root.appendingPathComponent("pet-manifest.json")),
           let decoded = try? JSONDecoder().decode(Manifest.self, from: data),
           Self.validate(decoded, root: root) {
            manifest = decoded
        } else { manifest = nil }
    }

    private static func safeURL(_ path: String, root: URL) -> URL? {
        guard !path.hasPrefix("/"), !path.split(separator: "/").contains(".."),
              path.lowercased().hasSuffix(".png") else { return nil }
        let url = root.appendingPathComponent(path).resolvingSymlinksInPath()
        let prefix = root.resolvingSymlinksInPath().path + "/"
        return url.path.hasPrefix(prefix) ? url : nil
    }

    private static func pngSize(_ url: URL) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              CGImageSourceGetType(source) as String? == "public.png",
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 4096, height <= 4096 else { return nil }
        return (width, height)
    }

    private static func validate(_ value: Manifest, root: URL) -> Bool {
        guard value.schemaVersion == 2, value.characterId == expectedCharacterID,
              value.columns == 4, value.rows == 4, !value.sheets.isEmpty,
              value.sheets.count <= 16, value.clips["tail"] == nil,
              requiredClips.allSatisfy({ value.clips[$0] != nil }),
              value.stateMap["IDLE"] == "idle",
              value.stateMap.values.allSatisfy({ value.clips[$0] != nil }),
              value.workingActivityMap.values.allSatisfy({ value.clips[$0] != nil }) else { return false }
        var cellSize: (Int, Int)?
        for path in value.sheets.values {
            guard let url = safeURL(path, root: root), let size = pngSize(url),
                  size.width >= value.columns, size.height >= value.rows else { return false }
            let current = (size.width, size.height)
            if let previous = cellSize, previous.0 != current.0 || previous.1 != current.1 { return false }
            cellSize = current
        }
        for clip in value.clips.values {
            guard clip.frames.count == 4, clip.frameMs.isFinite,
                  (16...5000).contains(clip.frameMs),
                  clip.frames.allSatisfy({
                      value.sheets[$0.sheet] != nil && (0..<value.rows).contains($0.row)
                          && (0..<value.columns).contains($0.column)
                  }) else { return false }
        }
        for name in ["idle.png", "shy.png"] {
            guard let url = safeURL(name, root: root), pngSize(url) != nil else { return false }
        }
        if let regions = value.hitRegions {
            for (key, rectangle) in regions {
                guard ["head", "body", "skirt"].contains(key), rectangle.count == 4,
                      rectangle.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }),
                      rectangle[2] > 0, rectangle[3] > 0,
                      rectangle[0] + rectangle[2] <= 1, rectangle[1] + rectangle[3] <= 1 else { return false }
            }
        }
        if let anchors = value.anchors {
            for point in anchors.values {
                guard point.count == 2, point.allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }) else { return false }
            }
        }
        return true
    }

    func firstFrameDecodes() -> Bool { decodeFrame(at: 0, clip: "idle") != nil }

    /// Complete non-UI validation of every referenced PNG atlas cell.
    /// This intentionally never creates NSImage or asks for WindowServer access.
    func allFramesDecode() -> Bool {
        guard let manifest else { return false }
        for name in manifest.clips.keys.sorted() {
            guard let clip = manifest.clips[name] else { return false }
            for index in clip.frames.indices {
                guard let image = decodeFrame(at: index, clip: name),
                      image.width > 0, image.height > 0 else { return false }
            }
        }
        return true
    }

    func interactionRegion(at point: CGPoint) -> String {
        let defaults: [String: [Double]] = [
            "head": [0.20, 0.02, 0.60, 0.30],
            "body": [0.22, 0.32, 0.56, 0.31],
            "skirt": [0.10, 0.63, 0.80, 0.35]
        ]
        for kind in ["head", "body", "skirt"] {
            let box = manifest?.hitRegions?[kind] ?? defaults[kind]!
            if CGRect(x: box[0], y: box[1], width: box[2], height: box[3]).contains(point) { return kind }
        }
        return point.y >= 0.63 ? "skirt" : "body"
    }

    var mouthAnchor: CGPoint {
        let point = manifest?.anchors?["mouth"] ?? [0.50, 0.23]
        return CGPoint(x: point[0], y: point[1])
    }

    private func sheet(_ key: String) -> CGImage? {
        guard let manifest, let path = manifest.sheets[key] else { return nil }
        if let cached = sheetImages[key] {
            sheetOrder.removeAll { $0 == key }; sheetOrder.append(key)
            return cached
        }
        guard let url = Self.safeURL(path, root: root),
              let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary) else { return nil }
        let cost = image.bytesPerRow * image.height
        while !sheetOrder.isEmpty && (sheetImages.count >= 4 || sheetBytes + cost > 64 * 1024 * 1024) {
            let oldest = sheetOrder.removeFirst()
            if let removed = sheetImages.removeValue(forKey: oldest) { sheetBytes -= removed.bytesPerRow * removed.height }
        }
        sheetImages[key] = image; sheetOrder.append(key); sheetBytes += cost
        return image
    }

    private func decodeFrame(at index: Int, clip name: String) -> CGImage? {
        guard let manifest, let clip = manifest.clips[name], clip.frames.indices.contains(index) else { return nil }
        let frame = clip.frames[index]
        guard let image = sheet(frame.sheet) else { return nil }
        // Integer floor boundaries cover every source pixel even for 1254px sheets.
        let x = frame.column * image.width / manifest.columns
        let y = frame.row * image.height / manifest.rows
        let right = (frame.column + 1) * image.width / manifest.columns
        let bottom = (frame.row + 1) * image.height / manifest.rows
        return image.cropping(to: CGRect(x: x, y: y, width: right - x, height: bottom - y))
    }

    private func image(at index: Int, clip name: String) -> NSImage? {
        guard let clip = manifest?.clips[name], clip.frames.indices.contains(index) else { return nil }
        if name == currentClip, let cached = decoded[index] { return cached }
        guard let manifest, let image = decodeFrame(at: index, clip: name),
              let source = sheet(clip.frames[index].sheet) else { return nil }
        // Fractional nominal size prevents alternating 313/314px crops from jittering.
        let size = NSSize(width: Double(source.width) / Double(manifest.columns),
                          height: Double(source.height) / Double(manifest.rows))
        let result = NSImage(cgImage: image, size: size)
        if name == currentClip {
            decoded[index] = result; cacheOrder.append(index)
            while cacheOrder.count > 12 { decoded.removeValue(forKey: cacheOrder.removeFirst()) }
        }
        return result
    }

    func setReducedMotion(_ enabled: Bool) {
        reduced = enabled
        if enabled {
            timer?.invalidate(); timer = nil; frameIndex = 0
            if let frame = image(at: 0, clip: currentClip) { onFrame(frame) }
        } else if !currentClip.isEmpty { play(currentClip, transient: transient, force: true) }
    }

    func setState(_ phase: String, activity: String = "") {
        let aliases = ["RUNNING": "WORKING", "BUSY": "WORKING", "TOOL": "WORKING", "EXECUTING": "WORKING",
                       "QUEUED": "WAITING", "BLOCKED": "WAITING", "APPROVAL": "WAITING", "WAITING-USER": "WAITING",
                       "COMPLETED": "SUCCESS", "DONE": "SUCCESS", "FINISHED": "SUCCESS", "FAILED": "ERROR"]
        let normalized = aliases[phase.uppercased()] ?? phase.uppercased()
        if normalized == "WORKING", let clip = manifest?.workingActivityMap[activity] { baseClip = clip }
        else { baseClip = manifest?.stateMap[normalized] ?? "idle" }
        if !transient { play(baseClip) }
    }

    func interaction(_ input: String) {
        let kind = input == "tail" ? "skirt" : input
        let map = ["head": "head_pat", "body": "poke", "skirt": "skirt", "feed": "eat_token",
                   "drag-hold": "dragging", "landing": "dragging_release", "sleep": "idle_yawn", "wake": "idle_stretch"]
        guard let name = map[kind], manifest?.clips[name] != nil else { return }
        play(name, transient: true, force: true)
    }

    func mood(_ value: String) {
        if value == "happy" || value == "success" { play("success", transient: true) }
        else if value == "error" { play("error", transient: true) }
    }

    private func play(_ name: String, transient isTransient: Bool = false, force: Bool = false) {
        guard let clip = manifest?.clips[name] else { return }
        if !force, currentClip == name, timer != nil { return }
        timer?.invalidate(); timer = nil
        currentClip = name; transient = isTransient; frameIndex = 0
        decoded.removeAll(keepingCapacity: true); cacheOrder.removeAll(keepingCapacity: true)
        if let frame = image(at: 0, clip: name) { onFrame(frame) }
        guard !reduced else { return }
        timer = Timer.scheduledTimer(withTimeInterval: clip.frameMs / 1000, repeats: true) { [weak self] _ in self?.advance() }
    }

    private func advance() {
        guard let clip = manifest?.clips[currentClip] else { return }
        frameIndex += 1
        if frameIndex >= clip.frames.count {
            if clip.loop { frameIndex = 0 }
            else {
                timer?.invalidate(); timer = nil; transient = false
                play(baseClip, force: true)
                return
            }
        }
        if let frame = image(at: frameIndex, clip: currentClip) { onFrame(frame) }
    }

    func stop() {
        timer?.invalidate(); timer = nil
        decoded.removeAll(); cacheOrder.removeAll()
        sheetImages.removeAll(); sheetOrder.removeAll(); sheetBytes = 0
    }

    func resume() { transient = false; play(baseClip, force: true) }
}
