import AppKit
import SpriteKit
import simd

/// Frame-local geometry, in the ORIGINAL image's normalized top-left coordinates.
/// No geometry is inferred from a face detector or from captured user content.
struct AvatarMeshGeometry: Equatable {
    let mouthRect: CGRect?
    let headRect: CGRect?

    init(mouthRect: [Double]? = nil, headRect: [Double]? = nil) {
        self.mouthRect = Self.rectangle(mouthRect, mouth: true)
        self.headRect = Self.rectangle(headRect, mouth: false)
    }

    private static func rectangle(_ values: [Double]?, mouth: Bool) -> CGRect? {
        guard let v = values, v.count == 4, v.allSatisfy({ $0.isFinite }),
              v[0] >= 0, v[1] >= 0, v[2] > 0, v[3] > 0,
              v[0] + v[2] <= 1, v[1] + v[3] <= 1 else { return nil }
        // Bad/missing metadata must never paint a large oval across the face.
        if mouth && (v[2] > 0.12 || v[3] > 0.075 || v[2] < 0.002 || v[3] < 0.002) { return nil }
        return CGRect(x: v[0], y: v[1], width: v[2], height: v[3])
    }
}

struct AvatarMeshMotionProfile: Equatable {
    var breath: CGFloat
    var head: CGFloat
    var hair: CGFloat
    var period: Double

    /// Parameters describe small mesh movement, not additional hand-drawn poses.
    static let actions: [String: AvatarMeshMotionProfile] = [
        "idle": .init(breath: 0.0025, head: 0.0030, hair: 0.0020, period: 4.7),
        "waiting": .init(breath: 0.0021, head: 0.0020, hair: 0.0015, period: 5.0),
        "thinking": .init(breath: 0.0017, head: 0.0045, hair: 0.0018, period: 5.4),
        "working": .init(breath: 0.0019, head: 0.0025, hair: 0.0014, period: 4.2),
        "working_search": .init(breath: 0.0018, head: 0.0040, hair: 0.0019, period: 4.9),
        "working_command": .init(breath: 0.0016, head: 0.0022, hair: 0.0013, period: 4.0),
        "success": .init(breath: 0.0032, head: 0.0055, hair: 0.0032, period: 3.6),
        "error": .init(breath: 0.0020, head: 0.0035, hair: 0.0012, period: 5.8),
        "dragging": .init(breath: 0.0010, head: 0.0030, hair: 0.0038, period: 3.3),
        "dragging_release": .init(breath: 0.0028, head: 0.0040, hair: 0.0034, period: 3.9),
        "head_pat": .init(breath: 0.0030, head: 0.0060, hair: 0.0030, period: 4.4),
        "poke": .init(breath: 0.0023, head: 0.0050, hair: 0.0028, period: 3.8),
        "skirt": .init(breath: 0.0020, head: 0.0035, hair: 0.0035, period: 4.6),
        "eat_token": .init(breath: 0.0024, head: 0.0030, hair: 0.0018, period: 3.5),
        "idle_stretch": .init(breath: 0.0038, head: 0.0065, hair: 0.0033, period: 4.1),
        "idle_yawn": .init(breath: 0.0031, head: 0.0038, hair: 0.0022, period: 6.0),
        "shy": .init(breath: 0.0022, head: 0.0048, hair: 0.0021, period: 5.3),
        "concern": .init(breath: 0.0020, head: 0.0052, hair: 0.0017, period: 5.7),
        "tease": .init(breath: 0.0026, head: 0.0068, hair: 0.0027, period: 4.3),
        "sleep": .init(breath: 0.0030, head: 0.0008, hair: 0.0007, period: 6.8),
        "replying": .init(breath: 0.0027, head: 0.0037, hair: 0.0020, period: 4.5),
        "waiting_approval": .init(breath: 0.0016, head: 0.0015, hair: 0.0010, period: 6.2),
        "idle_look": .init(breath: 0.0023, head: 0.0070, hair: 0.0025, period: 5.6),
        "wave": .init(breath: 0.0033, head: 0.0062, hair: 0.0037, period: 3.4)
    ]

    static func named(_ action: String) -> AvatarMeshMotionProfile { actions[action] ?? actions["idle"]! }

    func blending(toward other: Self, fraction: CGFloat) -> Self {
        let f = min(1, max(0, fraction))
        return .init(breath: breath + (other.breath - breath) * f,
                     head: head + (other.head - head) * f,
                     hair: hair + (other.hair - hair) * f,
                     period: period + (other.period - period) * Double(f))
    }
}

/// Pure geometry shared by rendering, the mouth, and inverse alpha hit testing.
/// Row-only and column-only offsets make every cell AFFINE. With subdivision=0
/// both possible GPU triangle diagonals give the same result as this mapping.
/// This avoids assuming a private SpriteKit triangulation or spline algorithm.
struct AvatarMeshGrid {
    static let columns = 8
    static let rows = 12
    let source: [CGPoint]       // row-major, TOP-left origin
    let destination: [CGPoint]

    static func make(profile: AvatarMeshMotionProfile, time: Double,
                     geometry: AvatarMeshGeometry = .init(), enabled: Bool) -> Self {
        let t = time.isFinite ? time : 0
        let phase = t * 2 * Double.pi / max(2, profile.period)
        let head = geometry.headRect ?? CGRect(x: 0.15, y: 0.03, width: 0.70, height: 0.42)
        let pivot = geometry.mouthRect?.midY ?? head.midY
        func smooth(_ low: CGFloat, _ high: CGFloat, _ value: CGFloat) -> CGFloat {
            let x = min(1, max(0, (value - low) / max(0.001, high - low)))
            return x * x * (3 - 2 * x)
        }
        var source: [CGPoint] = [], destination: [CGPoint] = []
        for row in 0...rows {
            let v = CGFloat(row) / CGFloat(rows)
            let headWeight = 1 - smooth(head.maxY - 0.04, min(0.9, head.maxY + 0.12), v)
            let lean = max(-0.008, min(0.008, profile.head * (v - pivot) / 0.26
                * headWeight * CGFloat(sin(phase * 0.63))))
            let chest = smooth(0.32, 0.50, v) * (1 - smooth(0.65, 0.91, v))
            let rise = max(-0.004, min(0.004, -profile.breath * chest * CGFloat(sin(phase))))
            let nod = profile.head * 0.16 * headWeight * CGFloat(sin(phase * 0.63 + 0.3))
            for column in 0...columns {
                let u = CGFloat(column) / CGFloat(columns)
                // The center/face stays rigid horizontally. On flat artwork this
                // is an edge/hair sway, not independently rigged hair strands.
                let edge = smooth(0.20, 0.47, abs(u - 0.5))
                let side = u < 0.5 ? -1.0 : 1.0
                let hairX = profile.hair * edge * CGFloat(sin(phase * 0.87 + side * 0.6))
                let hairY = profile.hair * 0.38 * edge * CGFloat(cos(phase * 0.87 + side * 0.4))
                let point = CGPoint(x: u, y: v)
                source.append(point)
                destination.append(enabled ? CGPoint(x: u + lean + hairX, y: v + rise + nod + hairY) : point)
            }
        }
        return .init(source: source, destination: destination)
    }

    func forward(_ point: CGPoint) -> CGPoint? {
        guard point.x.isFinite, point.y.isFinite, (0...1).contains(point.x), (0...1).contains(point.y) else { return nil }
        let x = min(Self.columns - 1, Int(point.x * CGFloat(Self.columns)))
        let y = min(Self.rows - 1, Int(point.y * CGFloat(Self.rows)))
        let a = point.x * CGFloat(Self.columns) - CGFloat(x)
        let b = point.y * CGFloat(Self.rows) - CGFloat(y)
        let i = y * (Self.columns + 1) + x
        let p = destination[i], q = destination[i + 1], r = destination[i + Self.columns + 1]
        return CGPoint(x: p.x + (q.x - p.x) * a + (r.x - p.x) * b,
                       y: p.y + (q.y - p.y) * a + (r.y - p.y) * b)
    }

    func inverse(_ point: CGPoint) -> CGPoint? {
        guard point.x.isFinite, point.y.isFinite else { return nil }
        for row in 0..<Self.rows {
            for column in 0..<Self.columns {
                let i = row * (Self.columns + 1) + column
                let p = destination[i], q = destination[i + 1], r = destination[i + Self.columns + 1]
                let ax = q.x - p.x, ay = q.y - p.y, bx = r.x - p.x, by = r.y - p.y
                let determinant = ax * by - ay * bx
                guard determinant > 1e-10 else { continue }
                let dx = point.x - p.x, dy = point.y - p.y
                let a = (dx * by - dy * bx) / determinant
                let b = (ax * dy - ay * dx) / determinant
                let epsilon: CGFloat = 1e-7
                if a >= -epsilon && a <= 1 + epsilon && b >= -epsilon && b <= 1 + epsilon {
                    return CGPoint(x: (CGFloat(column) + min(1, max(0, a))) / CGFloat(Self.columns),
                                   y: (CGFloat(row) + min(1, max(0, b))) / CGFloat(Self.rows))
                }
            }
        }
        return nil
    }

    /// Fitted rectangle in scene coordinates (bottom-left origin).
    static func imageRect(imageSize: CGSize, viewport: CGSize) -> CGRect {
        guard imageSize.width.isFinite, imageSize.height.isFinite, viewport.width.isFinite, viewport.height.isFinite,
              imageSize.width > 0, imageSize.height > 0, viewport.width > 0, viewport.height > 0 else { return .zero }
        let padding = min(6, min(viewport.width, viewport.height) * 0.025)
        let factor = min(max(0, viewport.width - padding * 2) / imageSize.width,
                         max(0, viewport.height - padding * 2) / imageSize.height)
        let size = CGSize(width: imageSize.width * factor, height: imageSize.height * factor)
        return CGRect(x: (viewport.width - size.width) / 2, y: (viewport.height - size.height) / 2,
                      width: size.width, height: size.height)
    }

    func scenePoint(for originalUV: CGPoint, imageRect: CGRect) -> CGPoint? {
        guard !imageRect.isEmpty, let p = forward(originalUV) else { return nil }
        return CGPoint(x: imageRect.minX + p.x * imageRect.width, y: imageRect.maxY - p.y * imageRect.height)
    }

    func originalPoint(for scenePoint: CGPoint, imageRect: CGRect) -> CGPoint? {
        guard !imageRect.isEmpty else { return nil }
        return inverse(CGPoint(x: (scenePoint.x - imageRect.minX) / imageRect.width,
                               y: (imageRect.maxY - scenePoint.y) / imageRect.height))
    }

    var maximumDisplacement: CGFloat {
        zip(source, destination).map { hypot($0.x - $1.x, $0.y - $1.y) }.max() ?? 0
    }

    func spriteKitGeometry() -> SKWarpGeometryGrid {
        var s: [SIMD2<Float>] = [], d: [SIMD2<Float>] = []
        for row in (0...Self.rows).reversed() {
            for column in 0...Self.columns {
                let i = row * (Self.columns + 1) + column
                s.append(SIMD2(Float(source[i].x), Float(1 - source[i].y)))
                d.append(SIMD2(Float(destination[i].x), Float(1 - destination[i].y)))
            }
        }
        return SKWarpGeometryGrid(columns: Self.columns, rows: Self.rows, sourcePositions: s, destinationPositions: d)
    }
}

/// Plain AppKit wrapper: SKView itself is deliberately not subclassed.
/// The owner keeps its existing event proxy and NSWindow alpha passthrough.
private final class AvatarMeshContainer: NSView {
    var onLayout: ((CGSize) -> Void)?
    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func setFrameSize(_ newSize: NSSize) { super.setFrameSize(newSize); onLayout?(bounds.size) }
    override func layout() { super.layout(); onLayout?(bounds.size) }
}

private final class AvatarMeshScene: SKScene {
    weak var renderer: AvatarMeshRenderer?
    override func update(_ currentTime: TimeInterval) { renderer?.updateScene(at: currentTime) }
    override func didFinishUpdate() { renderer?.finishedSceneFrame() }
}

/// Apple-only renderer. It neither observes the desktop nor synthesizes/records
/// audio; setMouthLevel accepts a caller's existing playback-envelope value.
/// All public operations must be called on the AppKit main thread.
final class AvatarMeshRenderer {
    private final class TextureEntry {
        let image: NSImage
        let texture: SKTexture
        let bitmap: NSBitmapImageRep
        let cost: Int
        init(image: NSImage, cgImage: CGImage) {
            self.image = image
            texture = SKTexture(cgImage: cgImage)
            texture.filteringMode = .linear
            bitmap = NSBitmapImageRep(cgImage: cgImage)
            cost = cgImage.bytesPerRow * cgImage.height
        }
    }

    private let container = AvatarMeshContainer(frame: .zero)
    private let renderView = SKView(frame: .zero)
    private let scene = AvatarMeshScene(size: CGSize(width: 1, height: 1))
    private let sprite = SKSpriteNode()
    private let skinMask = SKShapeNode()
    private let mouth = SKShapeNode()
    private var cache: [ObjectIdentifier: TextureEntry] = [:]
    private var cacheOrder: [ObjectIdentifier] = []
    private var cacheBytes = 0
    private var current: TextureEntry?
    private var geometry = AvatarMeshGeometry()
    private var grid = AvatarMeshGrid.make(profile: .named("idle"), time: 0, enabled: false)
    private var fittedRect = CGRect.zero
    private var skinColor: NSColor?
    private var currentAction = "idle"
    private var profile = AvatarMeshMotionProfile.named("idle")
    private var phaseTime = 0.0
    private var lastTime: TimeInterval?
    private var motionEnabled = true
    private var reduced = false
    private var hidden = false
    private var stopped = false
    private var requestedMouthLevel = 0.0
    private var displayedMouthLevel = 0.0
    private(set) var frameCount: UInt64 = 0
    private(set) var warpFrameCount: UInt64 = 0
    private(set) var mouthFrameCount: UInt64 = 0
    var view: NSView { container }

    init() {
        renderView.allowsTransparency = true
        renderView.preferredFramesPerSecond = 30
        renderView.ignoresSiblingOrder = false
        scene.backgroundColor = .clear
        scene.scaleMode = .resizeFill
        scene.renderer = self
        sprite.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        sprite.blendMode = .alpha
        sprite.subdivisionLevels = 0
        sprite.zPosition = 0
        for (node, z) in [(skinMask, CGFloat(1)), (mouth, CGFloat(2))] {
            node.zPosition = z
            node.strokeColor = .clear
            node.lineWidth = 0
            node.isAntialiased = true
            node.isHidden = true
            scene.addChild(node)
        }
        mouth.fillColor = NSColor(calibratedRed: 0.29, green: 0.12, blue: 0.13, alpha: 1)
        scene.addChild(sprite)
        container.addSubview(renderView)
        container.onLayout = { [weak self] size in self?.resize(to: size) }
        renderView.presentScene(scene)
    }

    deinit { stop() }

    /// Images are immutable frame assets. Do not mutate an already supplied
    /// NSImage in place; its object identity is the bounded texture-cache key.
    func setImage(_ image: NSImage, geometry: AvatarMeshGeometry = .init()) {
        guard !stopped else { return }
        let key = ObjectIdentifier(image)
        let entry: TextureEntry
        if let saved = cache[key] {
            entry = saved
            cacheOrder.removeAll { $0 == key }; cacheOrder.append(key)
        } else {
            guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil),
                  cg.width > 0, cg.height > 0, cg.width <= 4096, cg.height <= 4096 else { return }
            entry = TextureEntry(image: image, cgImage: cg)
            while !cacheOrder.isEmpty && (cache.count >= 8 || cacheBytes + entry.cost > 32 * 1024 * 1024) {
                let oldest = cacheOrder.removeFirst()
                if let removed = cache.removeValue(forKey: oldest) { cacheBytes -= removed.cost }
            }
            // One <=4096px image may exceed the normal 32MiB cache budget, but
            // still has a hard image-dimension bound and evicts all other entries.
            cache[key] = entry; cacheOrder.append(key); cacheBytes += entry.cost
        }
        current = entry
        self.geometry = geometry
        sprite.texture = entry.texture
        skinColor = sampledSkin(in: entry.bitmap, mouthRect: geometry.mouthRect)
        resize(to: container.bounds.size)
        refreshGeometry()
    }

    func setImage(_ image: NSImage, geometry: [String: [Double]]) {
        setImage(image, geometry: AvatarMeshGeometry(mouthRect: geometry["mouth"], headRect: geometry["head"]))
    }

    func setAction(_ action: String) {
        let key = action.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacingOccurrences(of: "-", with: "_")
        let next = AvatarMeshMotionProfile.actions[key] == nil ? "idle" : key
        if next != currentAction { currentAction = next }
    }

    func setMotionEnabled(_ value: Bool) {
        guard !stopped, motionEnabled != value else { return }
        motionEnabled = value
        if !value { phaseTime = 0; lastTime = nil }
        refreshGeometry()
    }

    func setReducedMotion(_ value: Bool) {
        guard !stopped, reduced != value else { return }
        reduced = value
        if value { requestedMouthLevel = 0; displayedMouthLevel = 0; phaseTime = 0; lastTime = nil }
        refreshGeometry()
    }

    func setHidden(_ value: Bool) {
        guard !stopped, hidden != value else { return }
        hidden = value
        container.isHidden = value
        if value { requestedMouthLevel = 0; displayedMouthLevel = 0; phaseTime = 0 }
        lastTime = nil
        refreshGeometry()
        scene.isPaused = value
        renderView.isPaused = value
    }

    func setMouthLevel(_ value: Double) {
        guard !stopped else { return }
        requestedMouthLevel = !reduced && !hidden && value.isFinite ? min(1, max(0, value)) : 0
        if requestedMouthLevel == 0 {
            displayedMouthLevel = 0
            refreshMouth() // silence/cancellation restores the original closed mouth immediately
        }
    }

    /// The caller can use this UV to query its original image-alpha bitmap.
    func inverseNormalizedPoint(viewPoint: CGPoint) -> CGPoint? {
        guard !stopped, !hidden, current != nil else { return nil }
        let point = renderView.convert(viewPoint, from: container)
        return grid.originalPoint(for: scene.convertPoint(fromView: point), imageRect: fittedRect)
    }

    /// A source top-left UV point projected into the renderer view, including
    /// its actual padding and current mesh deformation.
    func normalizedPoint(for originalUV: CGPoint) -> CGPoint? {
        guard !stopped, !hidden, current != nil,
              let point = grid.scenePoint(for: originalUV, imageRect: fittedRect) else { return nil }
        return renderView.convert(scene.convertPoint(toView: point), to: container)
    }

    func mouthPoint() -> CGPoint? {
        guard let box = geometry.mouthRect else { return nil }
        return normalizedPoint(for: CGPoint(x: box.midX, y: box.midY))
    }

    var diagnostics: [String: Any] {
        ["renderer": "spritekit-affine-grid", "targetFPS": 30,
         "sceneFrameCount": frameCount, "warpFrameCount": warpFrameCount, "mouthFrameCount": mouthFrameCount,
         "action": currentAction, "motionEnabled": motionEnabled, "reducedMotion": reduced, "hidden": hidden,
         "mouthVisible": !mouth.isHidden, "mouthLevel": displayedMouthLevel,
         "mouthGeometryValid": geometry.mouthRect != nil, "skinSampleValid": skinColor != nil,
         "maximumNormalizedDisplacement": Double(grid.maximumDisplacement),
         "textureCacheEntries": cache.count, "estimatedTextureSourceBytes": cacheBytes,
         "gridColumns": AvatarMeshGrid.columns, "gridRows": AvatarMeshGrid.rows,
         "vertices": grid.destination.map { [Double($0.x), Double($0.y)] }]
    }

    func stop() {
        guard !stopped else { return }
        stopped = true
        hidden = true
        requestedMouthLevel = 0; displayedMouthLevel = 0
        container.isHidden = true
        renderView.isPaused = true; scene.isPaused = true
        scene.removeAllActions(); sprite.removeAllActions()
        sprite.texture = nil; sprite.warpGeometry = nil
        skinMask.path = nil; mouth.path = nil
        scene.removeAllChildren(); renderView.presentScene(nil)
        current = nil; skinColor = nil
        cache.removeAll(); cacheOrder.removeAll(); cacheBytes = 0
        container.onLayout = nil
        scene.renderer = nil
    }

    fileprivate func updateScene(at time: TimeInterval) {
        guard !stopped, !hidden, time.isFinite else { return }
        let delta = lastTime.map { min(0.1, max(0, time - $0)) } ?? 0
        lastTime = time
        if motionEnabled && !reduced { phaseTime += delta }
        profile = profile.blending(toward: .named(currentAction), fraction: CGFloat(1 - exp(-delta * 8)))
        let effective = reduced ? 0 : requestedMouthLevel
        let rate = effective > displayedMouthLevel ? 20.0 : 14.0
        let prior = displayedMouthLevel
        displayedMouthLevel += (effective - displayedMouthLevel) * (1 - exp(-delta * rate))
        if abs(prior - displayedMouthLevel) > 0.0001 { mouthFrameCount &+= 1 }
        refreshGeometry()
    }

    fileprivate func finishedSceneFrame() { if !stopped && !hidden { frameCount &+= 1 } }

    private func resize(to size: CGSize) {
        guard !stopped else { return }
        renderView.frame = CGRect(origin: .zero, size: size)
        scene.size = CGSize(width: max(1, size.width), height: max(1, size.height))
        let imageSize = current?.image.size ?? .zero
        fittedRect = AvatarMeshGrid.imageRect(imageSize: imageSize, viewport: size)
        sprite.position = CGPoint(x: fittedRect.midX, y: fittedRect.midY)
        sprite.size = fittedRect.size
        refreshMouth()
    }

    private func refreshGeometry() {
        guard !stopped else { return }
        let next = AvatarMeshGrid.make(profile: profile, time: phaseTime, geometry: geometry,
                                       enabled: motionEnabled && !reduced && !hidden)
        if next.destination != grid.destination {
            grid = next
            sprite.warpGeometry = grid.spriteKitGeometry()
            warpFrameCount &+= 1
        } else if sprite.warpGeometry == nil { sprite.warpGeometry = next.spriteKitGeometry() }
        refreshMouth()
    }

    private func sampledSkin(in bitmap: NSBitmapImageRep, mouthRect: CGRect?) -> NSColor? {
        guard let box = mouthRect else { return nil }
        var samples: [(CGFloat, CGFloat, CGFloat)] = []
        for rise in [0.50, 0.85, 1.2] {
            for offset in [-0.25, 0.0, 0.25] {
                let u = box.midX + box.width * offset
                let v = box.minY - max(box.height, 0.004) * rise
                guard u > 0, u < 1, v > 0, v < 1,
                      let c = bitmap.colorAt(x: min(bitmap.pixelsWide - 1, Int(u * CGFloat(bitmap.pixelsWide))),
                                             y: min(bitmap.pixelsHigh - 1, Int(v * CGFloat(bitmap.pixelsHigh))))?.usingColorSpace(.deviceRGB),
                      c.alphaComponent >= 0.97 else { continue }
                let r = c.redComponent, g = c.greenComponent, b = c.blueComponent
                let light = (r + g + b) / 3
                if light >= 0.48 && max(r, max(g, b)) - min(r, min(g, b)) < 0.40 && r >= b * 0.9 {
                    samples.append((r, g, b))
                }
            }
        }
        guard samples.count >= 3 else { return nil }
        let r = samples.map { $0.0 }.sorted(), g = samples.map { $0.1 }.sorted(), b = samples.map { $0.2 }.sorted()
        return NSColor(calibratedRed: r[r.count / 2], green: g[g.count / 2], blue: b[b.count / 2], alpha: 1)
    }

    private func refreshMouth() {
        guard !stopped, !hidden, !reduced, displayedMouthLevel > 0.025,
              let box = geometry.mouthRect, let color = skinColor, !fittedRect.isEmpty else {
            skinMask.isHidden = true; mouth.isHidden = true
            return
        }
        // Paths are sampled through the SAME forward mesh as the rendered image,
        // not merely attached to an unwarped SpriteKit child-node coordinate.
        func path(points: [CGPoint]) -> CGPath? {
            let result = CGMutablePath()
            for (index, uv) in points.enumerated() {
                guard let p = grid.scenePoint(for: uv, imageRect: fittedRect) else { return nil }
                if index == 0 { result.move(to: p) } else { result.addLine(to: p) }
            }
            result.closeSubpath()
            return result
        }
        let dx = min(box.width * 0.06, 0.0015), dy = min(box.height * 0.08, 0.0015)
        let cover = box.insetBy(dx: -dx, dy: -dy).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        // Split mask edges at every grid boundary. A four-corner rectangle can
        // otherwise miss a bent edge when the mouth straddles two mesh cells.
        let xs = [cover.minX] + (1..<AvatarMeshGrid.columns).map { CGFloat($0) / CGFloat(AvatarMeshGrid.columns) }
            .filter { $0 > cover.minX && $0 < cover.maxX } + [cover.maxX]
        let ys = [cover.minY] + (1..<AvatarMeshGrid.rows).map { CGFloat($0) / CGFloat(AvatarMeshGrid.rows) }
            .filter { $0 > cover.minY && $0 < cover.maxY } + [cover.maxY]
        let boundary = xs.map { CGPoint(x: $0, y: cover.minY) }
            + ys.dropFirst().map { CGPoint(x: cover.maxX, y: $0) }
            + xs.dropLast().reversed().map { CGPoint(x: $0, y: cover.maxY) }
            + ys.dropFirst().dropLast().reversed().map { CGPoint(x: cover.minX, y: $0) }
        skinMask.path = path(points: boundary)
        skinMask.fillColor = color
        let scale = max(0.1, fittedRect.height / 270)
        let width = min(box.width * 0.63, 12 * scale / fittedRect.width)
        let height = min(box.height * 0.72, 5.5 * scale / fittedRect.height) * (0.38 + 0.62 * displayedMouthLevel)
        var curve: [CGPoint] = []
        for index in 0..<20 {
            let angle = Double(index) / 20 * Double.pi * 2
            curve.append(CGPoint(x: box.midX + CGFloat(cos(angle)) * width / 2,
                                 y: box.midY + CGFloat(sin(angle)) * height / 2))
        }
        mouth.path = path(points: curve)
        skinMask.isHidden = skinMask.path == nil
        mouth.isHidden = mouth.path == nil || skinMask.isHidden
    }
}
