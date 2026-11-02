import AppKit

/// Original AppKit drawings. These views are projections of Host inventory;
/// clicking offers an id and never consumes or generates a snack locally.
final class CompanionSnackView: NSView {
    let snackID: String
    let kind: String
    var onOffer: ((String) -> Void)?
    var canOffer = true
    private var arrivalTimer: Timer?
    private var arrivalStarted: Date?
    private(set) var restingFrame = NSRect.zero

    /// A logical destination is updated by layout without restarting the arrival.
    func setRestingFrame(_ target: NSRect, reducedMotion: Bool) {
        restingFrame = target
        if reducedMotion { cancelArrival(snapToRest: true) }
        else if arrivalStarted != nil { stepArrival() }
        else { frame = target }
    }

    func animateArrival(reducedMotion: Bool) {
        cancelArrival(snapToRest: true)
        guard !reducedMotion else { return }
        arrivalStarted = Date()
        stepArrival()
        arrivalTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.stepArrival() }
    }

    func cancelArrival(snapToRest: Bool) {
        arrivalTimer?.invalidate(); arrivalTimer = nil; arrivalStarted = nil
        if snapToRest { frame = restingFrame; alphaValue = 1 }
    }

    private func stepArrival() {
        guard let started = arrivalStarted else { return }
        let t = min(1, max(0, Date().timeIntervalSince(started) / 0.55))
        let remaining = 1 - t
        let unit = restingFrame.width / 32
        frame = restingFrame.offsetBy(dx: sin(t * .pi) * 3 * unit * remaining,
                                      dy: 22 * unit * remaining * remaining)
        alphaValue = 0.55 + 0.45 * t
        if t >= 1 { cancelArrival(snapToRest: true) }
    }

    func containsVisibleFood(_ point: NSPoint) -> Bool {
        !isHidden && alphaValue > 0.08 && NSBezierPath(ovalIn: bounds.insetBy(dx: 1, dy: 1)).contains(point)
    }

    deinit { arrivalTimer?.invalidate() }

    init(id: String, kind: String) {
        snackID = id
        self.kind = kind
        super.init(frame: .zero)
        wantsLayer = true
        let names = ["cookie": "曲奇", "candy": "糖果", "fishcake": "鱼糕",
                     "mantou": "馒头", "lamian": "一碗拉面", "dianxin": "精致点心", "cake": "橡木蛋糕卷"]
        toolTip = (names[kind] ?? "零食") + " · 点击递给她，由当前状态决定是否进食"
    }
    required init?(coder: NSCoder) { fatalError("Not a storyboard view") }
    override func mouseDown(with event: NSEvent) {
        if canOffer, containsVisibleFood(convert(event.locationInWindow, from: nil)) { onOffer?(snackID) }
    }
    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current else { return }
        context.saveGraphicsState()
        let transform = NSAffineTransform()
        transform.scaleX(by: bounds.width / 32, yBy: bounds.height / 32)
        transform.concat()
        switch kind {
        case "mantou":
            let bun = NSBezierPath()
            bun.move(to: NSPoint(x: 4, y: 9))
            bun.curve(to: NSPoint(x: 16, y: 29), controlPoint1: NSPoint(x: 2, y: 21), controlPoint2: NSPoint(x: 9, y: 29))
            bun.curve(to: NSPoint(x: 28, y: 9), controlPoint1: NSPoint(x: 23, y: 29), controlPoint2: NSPoint(x: 30, y: 21))
            bun.curve(to: NSPoint(x: 4, y: 9), controlPoint1: NSPoint(x: 26, y: 3), controlPoint2: NSPoint(x: 6, y: 3))
            bun.close()
            NSColor(calibratedRed: 1, green: 0.98, blue: 0.92, alpha: 1).setFill(); bun.fill()
            NSColor(calibratedRed: 0.79, green: 0.73, blue: 0.64, alpha: 1).setStroke()
            bun.lineWidth = 1.1; bun.stroke()
            let fold = NSBezierPath()
            fold.move(to: NSPoint(x: 13, y: 24))
            fold.curve(to: NSPoint(x: 16, y: 16), controlPoint1: NSPoint(x: 17, y: 24), controlPoint2: NSPoint(x: 18, y: 19))
            fold.lineWidth = 1; fold.stroke()
        case "lamian":
            NSColor(calibratedRed: 0.30, green: 0.61, blue: 0.76, alpha: 1).setFill()
            let bowl = NSBezierPath()
            bowl.move(to: NSPoint(x: 3, y: 18))
            bowl.curve(to: NSPoint(x: 16, y: 4), controlPoint1: NSPoint(x: 5, y: 5), controlPoint2: NSPoint(x: 10, y: 4))
            bowl.curve(to: NSPoint(x: 29, y: 18), controlPoint1: NSPoint(x: 23, y: 4), controlPoint2: NSPoint(x: 27, y: 7))
            bowl.close(); bowl.fill()
            NSColor(calibratedRed: 1, green: 0.90, blue: 0.66, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: 3, y: 13, width: 26, height: 10)).fill()
            NSColor(calibratedRed: 0.76, green: 0.53, blue: 0.24, alpha: 1).setStroke()
            for y in [16.0, 18.5, 21.0] {
                let noodle = NSBezierPath()
                noodle.move(to: NSPoint(x: 7, y: y))
                noodle.curve(to: NSPoint(x: 25, y: y - 1), controlPoint1: NSPoint(x: 12, y: y + 3), controlPoint2: NSPoint(x: 19, y: y - 3))
                noodle.lineWidth = 1.3; noodle.stroke()
            }
            NSColor(calibratedRed: 0.41, green: 0.25, blue: 0.17, alpha: 1).setStroke()
            for offset in [0.0, 2.5] {
                let stick = NSBezierPath()
                stick.move(to: NSPoint(x: 18 + offset, y: 20))
                stick.line(to: NSPoint(x: 26 + offset, y: 30))
                stick.lineWidth = 1.3; stick.stroke()
            }
        case "cake":
            NSColor(calibratedRed: 0.82, green: 0.56, blue: 0.29, alpha: 1).setFill()
            NSBezierPath(roundedRect: NSRect(x: 3, y: 5, width: 27, height: 23), xRadius: 8, yRadius: 8).fill()
            NSColor(calibratedRed: 1, green: 0.94, blue: 0.77, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: 6, y: 7, width: 21, height: 19)).fill()
            NSColor(calibratedRed: 0.70, green: 0.43, blue: 0.23, alpha: 1).setStroke()
            let cream = NSBezierPath()
            for index in 0...40 {
                let angle = Double(index) / 40 * Double.pi * 3.7
                let radius = 0.6 + Double(index) / 40 * 6.1
                let point = NSPoint(x: 16.5 + cos(angle) * radius, y: 16.5 + sin(angle) * radius)
                if index == 0 { cream.move(to: point) } else { cream.line(to: point) }
            }
            cream.lineWidth = 2; cream.stroke()
        case "candy":
            NSColor(calibratedRed: 1, green: 0.62, blue: 0.73, alpha: 0.95).setFill()
            let left = NSBezierPath()
            left.move(to: NSPoint(x: 2, y: 9)); left.line(to: NSPoint(x: 11, y: 13))
            left.line(to: NSPoint(x: 11, y: 19)); left.line(to: NSPoint(x: 2, y: 23)); left.close(); left.fill()
            let right = NSBezierPath()
            right.move(to: NSPoint(x: 30, y: 9)); right.line(to: NSPoint(x: 21, y: 13))
            right.line(to: NSPoint(x: 21, y: 19)); right.line(to: NSPoint(x: 30, y: 23)); right.close(); right.fill()
            NSColor(calibratedRed: 0.96, green: 0.37, blue: 0.53, alpha: 1).setFill()
            NSBezierPath(roundedRect: NSRect(x: 8, y: 8, width: 16, height: 16), xRadius: 6, yRadius: 6).fill()
            NSColor.white.withAlphaComponent(0.7).setStroke()
            let shine = NSBezierPath(); shine.move(to: NSPoint(x: 13, y: 12)); shine.line(to: NSPoint(x: 18, y: 21))
            shine.lineWidth = 2; shine.stroke()
        case "fishcake":
            NSColor(calibratedRed: 0.97, green: 0.67, blue: 0.75, alpha: 1).setFill()
            let tail = NSBezierPath()
            tail.move(to: NSPoint(x: 2, y: 7)); tail.line(to: NSPoint(x: 11, y: 16))
            tail.line(to: NSPoint(x: 2, y: 25)); tail.close(); tail.fill()
            NSColor(calibratedWhite: 1, alpha: 0.98).setFill()
            let body = NSBezierPath(ovalIn: NSRect(x: 7, y: 5, width: 23, height: 23)); body.fill()
            NSColor(calibratedRed: 0.91, green: 0.53, blue: 0.63, alpha: 1).setStroke()
            body.lineWidth = 1.2; body.stroke()
            let swirl = NSBezierPath()
            for index in 0...40 {
                let angle = Double(index) / 40 * Double.pi * 3.4
                let radius = 0.5 + Double(index) / 40 * 5.2
                let point = NSPoint(x: 17 + cos(angle) * radius, y: 16 + sin(angle) * radius)
                if index == 0 { swirl.move(to: point) } else { swirl.line(to: point) }
            }
            swirl.lineWidth = 1.8; swirl.stroke()
            NSColor(calibratedWhite: 0.25, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: 24, y: 19, width: 2, height: 2)).fill()
        default:
            NSColor(calibratedRed: 0.88, green: 0.65, blue: 0.35, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: 3, y: 3, width: 26, height: 26)).fill()
            NSColor(calibratedRed: 0.98, green: 0.80, blue: 0.50, alpha: 1).setFill()
            NSBezierPath(ovalIn: NSRect(x: 5, y: 6, width: 21, height: 21)).fill()
            NSColor(calibratedRed: 0.39, green: 0.23, blue: 0.16, alpha: 1).setFill()
            for point in [NSPoint(x: 11, y: 10), NSPoint(x: 21, y: 11), NSPoint(x: 16, y: 18), NSPoint(x: 9, y: 23), NSPoint(x: 23, y: 22)] {
                NSBezierPath(roundedRect: NSRect(x: point.x - 1.5, y: point.y - 1.5, width: 3.5, height: 3.5), xRadius: 1, yRadius: 1).fill()
            }
        }
        context.restoreGraphicsState()
    }
}

final class CompanionGrowthBadge: NSView {
    var summary = "" { didSet { needsDisplay = true } }
    var progress = 0.0 { didSet { needsDisplay = true } }
    var onOpen: (() -> Void)?
    override func mouseDown(with event: NSEvent) { onOpen?() }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 1, alpha: 0.92).setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 13, yRadius: 13).fill()
        let textRect = NSRect(x: 7, y: 17, width: bounds.width - 14, height: bounds.height - 23)
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        style.lineBreakMode = .byWordWrapping
        (summary as NSString).draw(in: textRect, withAttributes: [
            .font: NSFont.systemFont(ofSize: min(12, bounds.width / 8), weight: .medium),
            .foregroundColor: NSColor(calibratedRed: 0.15, green: 0.27, blue: 0.37, alpha: 1),
            .paragraphStyle: style])
        let track = NSRect(x: 9, y: 8, width: bounds.width - 18, height: 5)
        NSColor.systemBlue.withAlphaComponent(0.14).setFill()
        NSBezierPath(roundedRect: track, xRadius: 2.5, yRadius: 2.5).fill()
        NSColor.systemBlue.withAlphaComponent(0.7).setFill()
        NSBezierPath(roundedRect: NSRect(x: track.minX, y: track.minY,
                                       width: track.width * min(1, max(0, progress)), height: track.height),
                     xRadius: 2.5, yRadius: 2.5).fill()
    }
}
