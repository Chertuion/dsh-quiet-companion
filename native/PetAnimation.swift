import AppKit
import ImageIO

/// Plays the licensed manifest's actual frames and retains at most twelve
/// decoded frames from one clip. No network fetch or asset mutation occurs.
final class PetAnimationPlayer {
    private struct Clip: Decodable {
        let frames: [String]
        let frameMs: Double
        let loop: Bool
    }
    private struct Manifest: Decodable {
        let clips: [String: Clip]
        let stateMap: [String: String]
        let workingActivityMap: [String: String]
    }
    private let root: URL
    private let manifest: Manifest?
    private let onFrame: (NSImage) -> Void
    private var timer: Timer?
    private var frameIndex = 0
    private var decoded: [Int: NSImage] = [:]
    private var cacheOrder: [Int] = []
    private var completion: (() -> Void)?
    private var transient = false
    private var reduced = false
    private var baseClip = "idle"
    private(set) var currentClip = ""
    var available: Bool { manifest?.clips["idle"]?.frames.isEmpty == false }

    init(root: URL, onFrame: @escaping (NSImage) -> Void) {
        self.root = root
        self.onFrame = onFrame
        if let data = try? Data(contentsOf: root.appendingPathComponent("pet-manifest.json")) {
            manifest = try? JSONDecoder().decode(Manifest.self, from: data)
        } else { manifest = nil }
    }

    func firstFrame() -> NSImage? { image(at: 0, clip: "idle") }
    func firstFrameDecodes() -> Bool { decodeFrame(at: 0, clip: "idle") != nil }

    private func decodeFrame(at index: Int, clip name: String) -> CGImage? {
        guard let clip = manifest?.clips[name], clip.frames.indices.contains(index) else { return nil }
        let path = clip.frames[index]
        guard !path.hasPrefix("/"), !path.split(separator: "/").contains("..") else { return nil }
        let url = root.appendingPathComponent("pet", isDirectory: true).appendingPathComponent(path)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
    }

    private func image(at index: Int, clip name: String) -> NSImage? {
        guard let clip = manifest?.clips[name], clip.frames.indices.contains(index) else { return nil }
        if name == currentClip, let cached = decoded[index] { return cached }
        guard let image = decodeFrame(at: index, clip: name) else { return nil }
        let decodedImage = NSImage(cgImage: image, size: NSSize(width: image.width, height: image.height))
        if name == currentClip {
            decoded[index] = decodedImage
            cacheOrder.append(index)
            while cacheOrder.count > 12 { decoded.removeValue(forKey: cacheOrder.removeFirst()) }
        }
        return decodedImage
    }

    func setReducedMotion(_ enabled: Bool) {
        reduced = enabled
        if enabled { timer?.invalidate(); timer = nil }
        else if !currentClip.isEmpty { play(currentClip, transient: transient, force: true) }
    }

    func setState(_ phase: String, activity: String = "") {
        let aliases = ["RUNNING": "WORKING", "BUSY": "WORKING", "TOOL": "WORKING", "EXECUTING": "WORKING",
                       "QUEUED": "WAITING", "BLOCKED": "WAITING", "APPROVAL": "WAITING", "WAITING-USER": "WAITING",
                       "COMPLETED": "SUCCESS", "DONE": "SUCCESS", "FINISHED": "SUCCESS", "FAILED": "ERROR"]
        let normalized = aliases[phase.uppercased()] ?? phase.uppercased()
        if normalized == "WORKING", let activityClip = manifest?.workingActivityMap[activity] { baseClip = activityClip }
        else { baseClip = manifest?.stateMap[normalized] ?? "idle" }
        if !transient { play(baseClip) }
    }

    func interaction(_ kind: String) {
        let map = ["head": "head_pat", "body": "poke", "tail": "tail", "feed": "eat_token",
                   "drag-hold": "dragging", "landing": "dragging_release", "sleep": "idle_yawn", "wake": "idle_stretch"]
        guard let name = map[kind], manifest?.clips[name] != nil else { return }
        play(name, transient: true, force: true)
    }

    func mood(_ value: String) {
        if value == "happy" || value == "success" { play("success", transient: true) }
        else if value == "error" { play("error", transient: true) }
    }

    private func play(_ name: String, transient isTransient: Bool = false, force: Bool = false) {
        guard let clip = manifest?.clips[name], !clip.frames.isEmpty else { return }
        if !force, currentClip == name, timer != nil { return }
        timer?.invalidate()
        timer = nil
        currentClip = name
        transient = isTransient
        frameIndex = 0
        decoded.removeAll(keepingCapacity: true)
        cacheOrder.removeAll(keepingCapacity: true)
        if let frame = image(at: 0, clip: name) { onFrame(frame) }
        guard !reduced else { return }
        timer = Timer.scheduledTimer(withTimeInterval: max(0.016, clip.frameMs / 1000), repeats: true) { [weak self] _ in self?.advance() }
    }

    private func advance() {
        guard let clip = manifest?.clips[currentClip] else { return }
        frameIndex += 1
        if frameIndex >= clip.frames.count {
            if clip.loop { frameIndex = 0 }
            else {
                timer?.invalidate()
                timer = nil
                transient = false
                if let completion { self.completion = nil; completion() }
                else { play(baseClip, force: true) }
                return
            }
        }
        if let frame = image(at: frameIndex, clip: currentClip) { onFrame(frame) }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        decoded.removeAll()
        cacheOrder.removeAll()
    }

    func resume() {
        transient = false
        play(baseClip, force: true)
    }
}
