import AppKit
import CoreGraphics
import ScreenCaptureKit
import AVFoundation
import Speech
import CoreMedia

private let previewMode = CommandLine.arguments.contains("--preview")
private let screenshotFeatureAvailable = true
private let featureNotice = "跟随 Harness 默认模型。屏幕和系统声音需要单独同意；可随时暂停。"
private let encoderLock = NSLock()

private func emit(_ message: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(message),
          let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
    encoderLock.lock()
    defer { encoderLock.unlock() }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

private func nowMilliseconds() -> Double { Date().timeIntervalSince1970 * 1000 }

private struct CompanionSettings {
    var observationEnabled = false
    var screenEnabled = false
    var captureIntervalSeconds = 3.0
    var snoozeUntil = 0.0
    var provider = ""
    var model = ""
    var consentPair = ""
    var videoAudioEnabled = false
    var voiceEnabled = false
    var voiceIdentifier = ""
    var voiceRate = Double(AVSpeechUtteranceDefaultSpeechRate)
    var speechLanguage = "zh-CN"
    var memoryEnabled = false
    var agentProgressEnabled = true
    var reduceMotion = false
    var dynamicSkinEnabled = true
    var dailyTokenBudget = 0.0
    var dailyBudget = 0.0
    var inputPricePerMillion = 0.0
    var outputPricePerMillion = 0.0
    var pair: String { provider + "\u{001F}" + model }
    var active: Bool { observationEnabled && snoozeUntil <= nowMilliseconds() }
    var json: [String: Any] {
        ["observationEnabled": observationEnabled, "screenEnabled": screenEnabled,
         "captureIntervalSeconds": captureIntervalSeconds, "snoozeUntil": snoozeUntil,
         "provider": provider, "model": model, "consentPair": consentPair, "useDefaultModel": true,
         "videoAudioEnabled": videoAudioEnabled, "voiceEnabled": voiceEnabled,
         "voiceIdentifier": voiceIdentifier, "voiceRate": voiceRate, "speechLanguage": speechLanguage,
         "memoryEnabled": memoryEnabled, "agentProgressEnabled": agentProgressEnabled,
         "reduceMotion": reduceMotion, "dailyTokenBudget": dailyTokenBudget, "dailyBudget": dailyBudget,
         "dynamicSkinEnabled": dynamicSkinEnabled,
         "inputPricePerMillion": inputPricePerMillion, "outputPricePerMillion": outputPricePerMillion]
    }
}

/// Receives only system audio from ScreenCaptureKit and recognizes it on-device.
/// No microphone, audio file, or remote speech service is used.
private final class SystemAudioTranscriber: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private let requestLock = NSLock()
    private let sampleQueue = DispatchQueue(label: "quiet-companion.system-audio")
    private var renewalTimer: Timer?
    private var partialTimer: Timer?
    private var running = false
    private var generation = 0
    private var latestText = ""
    private var emittedText = ""
    private var lastEmission = Date.distantPast
    private var suppressValue = false
    var suppressAudio: Bool {
        get { requestLock.withLock { suppressValue } }
        set { requestLock.withLock { suppressValue = newValue } }
    }
    var onTranscript: ((String) -> Void)?
    var onFailure: ((String) -> Void)?

    static func available(language: String) -> Bool {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)) else { return false }
        return recognizer.supportsOnDeviceRecognition && recognizer.isAvailable
    }
    static func supportsOnDevice(language: String) -> Bool {
        SFSpeechRecognizer(locale: Locale(identifier: language))?.supportsOnDeviceRecognition == true
    }

    func start(language: String) async throws {
        guard !running else { return }
        let attempt = generation
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: language)),
              recognizer.supportsOnDeviceRecognition, recognizer.isAvailable else {
            throw NSError(domain: "QuietCompanion", code: 20,
                          userInfo: [NSLocalizedDescriptionKey: "当前系统／语言没有可用的本机语音识别，未开启系统声音理解。"])
        }
        self.recognizer = recognizer
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard attempt == generation else { throw CancellationError() }
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw NSError(domain: "QuietCompanion", code: 21, userInfo: [NSLocalizedDescriptionKey: "没有可用显示器。"])
        }
        let own = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
        let filter = SCContentFilter(display: display, excludingApplications: own, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 16_000
        config.channelCount = 1
        config.showsCursor = false
        if #available(macOS 15.0, *) { config.captureMicrophone = false }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
        // Register screen output only to keep capture-engine compatibility; discard it immediately.
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        self.stream = stream
        running = true
        startRecognitionSession()
        do { try await stream.startCapture() }
        catch { await stop(); throw error }
    }

    private func startRecognitionSession() {
        guard running, let recognizer else { return }
        generation += 1
        let current = generation
        recognitionTask?.cancel()
        let next = SFSpeechAudioBufferRecognitionRequest()
        next.requiresOnDeviceRecognition = true
        next.shouldReportPartialResults = true
        next.taskHint = .dictation
        if #available(macOS 13.0, *) { next.addsPunctuation = true }
        requestLock.withLock {
            request?.endAudio()
            request = next
        }
        latestText = ""
        emittedText = ""
        recognitionTask = recognizer.recognitionTask(with: next) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.running, self.generation == current else { return }
                if let result {
                    self.latestText = result.bestTranscription.formattedString
                    self.partialTimer?.invalidate()
                    if result.isFinal || Date().timeIntervalSince(self.lastEmission) >= 6 {
                        self.emitTranscript()
                    } else {
                        self.partialTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in self?.emitTranscript() }
                    }
                    if result.isFinal { self.startRecognitionSession() }
                } else if error != nil {
                    self.onFailure?("本机语音识别暂时不可用，已停止系统声音理解。")
                }
            }
        }
        renewalTimer?.invalidate()
        renewalTimer = Timer.scheduledTimer(withTimeInterval: 45, repeats: false) { [weak self] _ in
            self?.emitTranscript()
            self?.startRecognitionSession()
        }
    }

    private func emitTranscript() {
        let text = latestText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text != emittedText else { return }
        let delta = text.hasPrefix(emittedText) ? String(text.dropFirst(emittedText.count)) : text
        emittedText = text
        lastEmission = Date()
        guard !delta.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        onTranscript?(String(delta.prefix(1000)))
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, CMSampleBufferDataIsReady(sampleBuffer), !suppressAudio else { return }
        requestLock.withLock { request?.appendAudioSampleBuffer(sampleBuffer) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        DispatchQueue.main.async { [weak self] in
            guard self?.running == true else { return }
            self?.onFailure?("系统声音捕获中断，已停止声音理解。")
        }
    }

    func stop() async {
        running = false
        generation += 1
        renewalTimer?.invalidate()
        partialTimer?.invalidate()
        requestLock.withLock {
            request?.endAudio()
            request = nil
        }
        recognitionTask?.cancel()
        recognitionTask = nil
        let previousStream = stream
        stream = nil
        if let previousStream { try? await previousStream.stopCapture() }
    }
}

private struct CompanionModel {
    let provider: String
    let model: String
    let label: String
    let vision: Bool
    init?(_ value: [String: Any]) {
        guard let provider = value["provider"] as? String, let model = value["model"] as? String else { return nil }
        self.provider = provider
        self.model = model
        label = value["label"] as? String ?? "\(provider) / \(model)"
        vision = value["vision"] as? Bool ?? false
    }
}

private final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class BubbleView: NSView {
    let text = NSTextField(wrappingLabelWithString: "")
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        text.font = .systemFont(ofSize: 14, weight: .medium)
        text.textColor = NSColor(calibratedRed: 0.15, green: 0.22, blue: 0.30, alpha: 1)
        text.maximumNumberOfLines = 5
        addSubview(text)
    }
    required init?(coder: NSCoder) { fatalError("Not a storyboard view") }
    override func layout() {
        super.layout()
        text.frame = bounds.insetBy(dx: 16, dy: 13)
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.99, alpha: 0.96).setFill()
        let body = bounds.insetBy(dx: 2, dy: 2)
        NSBezierPath(roundedRect: body, xRadius: 18, yRadius: 18).fill()
        NSColor(calibratedRed: 0.57, green: 0.78, blue: 0.93, alpha: 0.85).setStroke()
        let outline = NSBezierPath(roundedRect: body, xRadius: 18, yRadius: 18)
        outline.lineWidth = 1
        outline.stroke()
    }
}

private final class PetImageView: NSImageView {
    weak var companion: CompanionApp?
    private var initialMouse = NSPoint.zero
    private var initialOrigin = NSPoint.zero
    private var dragged = false
    override func mouseDown(with event: NSEvent) {
        initialMouse = NSEvent.mouseLocation
        initialOrigin = window?.frame.origin ?? .zero
        dragged = false
    }
    override func mouseDragged(with event: NSEvent) {
        let mouse = NSEvent.mouseLocation
        if !dragged && hypot(mouse.x - initialMouse.x, mouse.y - initialMouse.y) > 4 {
            dragged = true
            companion?.dragBegan()
        }
        guard dragged else { return }
        window?.setFrameOrigin(NSPoint(x: initialOrigin.x + mouse.x - initialMouse.x,
                                      y: initialOrigin.y + mouse.y - initialMouse.y))
    }
    override func mouseUp(with event: NSEvent) {
        if dragged { companion?.dragEnded(); return }
        if event.clickCount >= 2 { companion?.showChat() }
        else {
            let local = convert(event.locationInWindow, from: nil)
            let kind = local.y > bounds.height * 0.68 ? "head" : (local.x > bounds.width * 0.67 && local.y < bounds.height * 0.55 ? "tail" : "body")
            companion?.interact(kind)
        }
    }
    override func rightMouseDown(with event: NSEvent) {
        guard let companion else { return }
        NSMenu.popUpContextMenu(companion.petMenu(), with: event, for: self)
    }
}

private final class CompanionApp: NSObject, NSApplicationDelegate, NSWindowDelegate, AVSpeechSynthesizerDelegate, NSTextViewDelegate {
    private var settings = CompanionSettings()
    private var models: [CompanionModel] = []
    private var panel: PetPanel!
    private var imageView: PetImageView!
    private var bubble: BubbleView!
    private var sleepLabel: NSTextField!
    private var statusItem: NSStatusItem!
    private var settingsWindow: NSWindow?
    private var chatWindow: NSWindow?
    private var allMemoryWindow: NSWindow?
    private var allMemoryText: NSTextView?
    private var observeCheckbox: NSButton!
    private var screenCheckbox: NSButton!
    private var modelPicker: NSPopUpButton!
    private var disclosureLabel: NSTextField!
    private var statusLabel: NSTextField!
    private var intervalLabel: NSTextField!
    private var intervalSlider: NSSlider!
    private var scaleSlider: NSSlider!
    private var opacitySlider: NSSlider!
    private var audioCheckbox: NSButton!
    private var languagePicker: NSPopUpButton!
    private var audioStatusLabel: NSTextField!
    private var voiceCheckbox: NSButton!
    private var voicePicker: NSPopUpButton!
    private var voiceRateSlider: NSSlider!
    private var memoryCheckbox: NSButton!
    private var agentCheckbox: NSButton!
    private var reduceMotionCheckbox: NSButton!
    private var dynamicSkinCheckbox: NSButton!
    private var memoryText: NSTextView!
    private var memoryStatusLabel: NSTextField!
    private var usageLabel: NSTextField!
    private var agentDetailLabel: NSTextField!
    private var agentPill: NSTextField!
    private var budgetFields: [String: NSTextField] = [:]
    private var voices: [AVSpeechSynthesisVoice] = []
    private var chatInput: NSTextField!
    private var chatReply: NSTextField!
    private var observationTimer: Timer?
    private var animationTimer: Timer?
    private var bubbleTimer: Timer?
    private var passthroughTimer: Timer?
    private var captureInFlight = false
    private var captureGeneration = 0
    private var modelStatus = "正在连接桌面版……"
    private var currentMood = "idle"
    private var sleeping = false
    private var scale = 1.0
    private var opacity = 1.0
    private var floatingPhase = false
    private var isDragging = false
    private var forcedSleep = false
    private var petBitmap: NSBitmapImageRep?
    private var poseTimer: Timer?
    private var lastMetadataKey = ""
    private var lastFingerprint: [UInt8]?
    private var lastFrameTime = Date.distantPast
    private var lastFrameContext = ""
    private var audioConsentPair = ""
    private var audioStarting = false
    private var audioRunning = false
    private var audioStatus = "系统声音理解未开启。仅支持本机离线语音识别，不使用麦克风。"
    private var agentSummary = "暂无进行中的任务"
    private var activeAgentPhase = "idle"
    private var activeAgentActivity = ""
    private var modelPending = false
    private var usageSummary = "还没有读取用量。"
    private var memorySummary = "记忆默认关闭。"
    private var memoryFacts = ""
    private var allMemoryFacts = "尚未读取记忆。请点击刷新记忆。"
    private var memoryDirty = false
    private let audioTranscriber = SystemAudioTranscriber()
    private let speechSynthesizer = AVSpeechSynthesizer()
    private var animationPlayer: PetAnimationPlayer?
    private var isShuttingDown = false
    private let defaults = UserDefaults.standard
    private var assetsDirectory: URL {
        if let index = CommandLine.arguments.firstIndex(of: "--assets-dir"), index + 1 < CommandLine.arguments.count {
            return URL(fileURLWithPath: CommandLine.arguments[index + 1], isDirectory: true)
        }
        return Bundle.main.resourceURL!.appendingPathComponent("pet", isDirectory: true)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let savedScale = defaults.double(forKey: "petScale")
        let savedOpacity = defaults.double(forKey: "petOpacity")
        scale = savedScale > 0 ? min(1.6, max(0.6, savedScale)) : 1
        opacity = savedOpacity > 0 ? min(1, max(0.45, savedOpacity)) : 1
        settings.consentPair = defaults.string(forKey: "screenConsentPair") ?? ""
        audioConsentPair = defaults.string(forKey: "audioConsentPair") ?? ""
        speechSynthesizer.delegate = self
        settings.dynamicSkinEnabled = defaults.object(forKey: "dynamicSkinEnabled") as? Bool ?? true
        makePanel()
        configureAnimation()
        makeStatusItem()
        showSpeech("右键打开陪伴设置，双击可以聊天。", mood: "idle", speak: false)
        animationTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in self?.animatePet() }
        passthroughTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.updateMousePassthrough() }
        readCommands()
        emit(["type": "ready", "protocolVersion": 1, "preview": previewMode])
        emit(["type": "request-models"])
        if previewMode { showSettings() }
    }

    private func makePanel() {
        panel = PetPanel(contentRect: NSRect(x: 0, y: 0, width: 320 * scale, height: 400 * scale),
                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.alphaValue = opacity
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 320 * scale, height: 400 * scale))
        panel.contentView = content
        imageView = PetImageView(frame: .zero)
        imageView.companion = self
        imageView.imageScaling = .scaleProportionallyUpOrDown
        bubble = BubbleView(frame: .zero)
        sleepLabel = label("z Z", font: .systemFont(ofSize: 23, weight: .light))
        sleepLabel.textColor = .systemBlue
        sleepLabel.isHidden = true
        content.addSubview(imageView)
        content.addSubview(bubble)
        content.addSubview(sleepLabel)
        agentPill = label("", font: .systemFont(ofSize: 11, weight: .medium))
        agentPill.alignment = .center
        agentPill.textColor = .secondaryLabelColor
        agentPill.isHidden = true
        content.addSubview(agentPill)
        layoutPet()
        updateImage()
        let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) ?? NSScreen.main!
        let fallback = NSPoint(x: screen.visibleFrame.maxX - panel.frame.width - 24, y: screen.visibleFrame.minY + 20)
        let x = defaults.object(forKey: "petX") as? Double
        let y = defaults.object(forKey: "petY") as? Double
        let saved = NSRect(origin: NSPoint(x: x ?? fallback.x, y: y ?? fallback.y), size: panel.frame.size)
        let valid = NSScreen.screens.contains { $0.visibleFrame.intersection(saved).width >= 60 && $0.visibleFrame.intersection(saved).height >= 60 }
        panel.setFrameOrigin(valid ? saved.origin : fallback)
        panel.orderFrontRegardless()
    }

    private func layoutPet() {
        panel.setContentSize(NSSize(width: 320 * scale, height: 400 * scale))
        let dynamic = settings.dynamicSkinEnabled && animationPlayer?.available == true
        imageView.frame = NSRect(x: (dynamic ? 20 : 55) * scale, y: 4 * scale,
                                width: (dynamic ? 280 : 210) * scale, height: 270 * scale)
        bubble.frame = NSRect(x: 6 * scale, y: 300 * scale, width: 308 * scale, height: 94 * scale)
        agentPill.frame = NSRect(x: 35 * scale, y: 275 * scale, width: 250 * scale, height: 22 * scale)
        bubble.text.font = .systemFont(ofSize: 14 * min(scale, 1.2), weight: .medium)
        sleepLabel.frame = NSRect(x: 250 * scale, y: 240 * scale, width: 65 * scale, height: 35 * scale)
    }

    func savePosition() {
        defaults.set(panel.frame.origin.x, forKey: "petX")
        defaults.set(panel.frame.origin.y, forKey: "petY")
    }

    private func updateImage() {
        if settings.dynamicSkinEnabled, let animationPlayer, animationPlayer.available {
            animationPlayer.mood(currentMood)
            return
        }
        let name = currentMood == "shy" ? "shy.png" : "idle.png"
        imageView.image = NSImage(contentsOf: assetsDirectory.appendingPathComponent(name))
            ?? NSImage(systemSymbolName: "drop.fill", accessibilityDescription: "陪伴小鲸")
        if !FileManager.default.fileExists(atPath: assetsDirectory.appendingPathComponent(name).path) {
            imageView.contentTintColor = .systemBlue
        } else { imageView.contentTintColor = nil }
        if let data = imageView.image?.tiffRepresentation { petBitmap = NSBitmapImageRep(data: data) }
    }

    private func configureAnimation() {
        animationPlayer?.stop()
        animationPlayer = nil
        guard settings.dynamicSkinEnabled else { return }
        let player = PetAnimationPlayer(root: assetsDirectory.appendingPathComponent("animations", isDirectory: true)) { [weak self] frame in
            guard let self, self.settings.dynamicSkinEnabled else { return }
            self.imageView.image = frame
            self.imageView.contentTintColor = nil
            if let image = frame.cgImage(forProposedRect: nil, context: nil, hints: nil) {
                self.petBitmap = NSBitmapImageRep(cgImage: image)
            }
        }
        animationPlayer = player
        player.setReducedMotion(settings.reduceMotion)
        player.setState("IDLE")
        layoutPet()
    }

    private func animatePet() {
        guard !settings.reduceMotion, !isDragging,
              !(settings.dynamicSkinEnabled && animationPlayer?.available == true) else { return }
        floatingPhase.toggle()
        let targetY = (floatingPhase && !sleeping ? 9.0 : 4.0) * scale
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 1.5
            imageView.animator().setFrameOrigin(NSPoint(x: 55 * scale, y: targetY))
        }
        sleepLabel.isHidden = !sleeping
    }

    func interact(_ kind: String) {
        if kind == "sleep" { forcedSleep = true; sleeping = true }
        else { forcedSleep = false; sleeping = false }
        sleepLabel.isHidden = !sleeping
        currentMood = ["head", "body", "feed"].contains(kind) ? "shy" : "idle"
        updateImage()
        if settings.dynamicSkinEnabled, animationPlayer?.available == true { animationPlayer?.interaction(kind) }
        else if !settings.reduceMotion {
            let angle: CGFloat = kind == "tail" ? -6 : (kind == "head" ? 3 : (kind == "feed" ? -2 : 0))
            imageView.animator().frameCenterRotation = angle
            poseTimer?.invalidate()
            poseTimer = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in
                self?.imageView.animator().frameCenterRotation = 0
                self?.currentMood = "idle"
                self?.updateImage()
            }
        }
        if !previewMode { emit(["type": "interaction", "kind": kind, "timestamp": nowMilliseconds()]) }
    }

    private func showSpeech(_ text: String, mood: String, speak: Bool = true) {
        currentMood = ["idle", "shy", "concern", "tease", "happy", "success", "error"].contains(mood) ? mood : "idle"
        updateImage()
        bubble.text.stringValue = String(text.prefix(260))
        bubble.isHidden = false
        chatReply?.stringValue = String(text.prefix(1200))
        if speak, settings.voiceEnabled, !previewMode, !text.isEmpty {
            speechSynthesizer.stopSpeaking(at: .immediate)
            let utterance = AVSpeechUtterance(string: String(text.prefix(2000)))
            utterance.voice = AVSpeechSynthesisVoice(identifier: settings.voiceIdentifier) ?? AVSpeechSynthesisVoice(language: "zh-CN")
            utterance.rate = Float(min(0.65, max(0.3, settings.voiceRate)))
            speechSynthesizer.speak(utterance)
        }
        bubbleTimer?.invalidate()
        bubbleTimer = Timer.scheduledTimer(withTimeInterval: min(25, max(8, Double(text.count) / 4)), repeats: false) { [weak self] _ in
            self?.bubble.isHidden = true
            self?.currentMood = "idle"
            self?.updateImage()
        }
    }

    private func makeStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "drop.circle", accessibilityDescription: "安静陪伴")
        statusItem.button?.toolTip = "安静陪伴：点击菜单可找回宠物"
        statusItem.menu = petMenu()
    }

    func petMenu() -> NSMenu {
        let menu = NSMenu()
        let entries: [(String, Selector)] = [
            ("显示／隐藏伙伴", #selector(togglePet)), ("和她说句话…", #selector(openChat)),
            ("陪伴设置…", #selector(openSettings)), ("暂停观察", #selector(pauseObservation)),
            ("安静 30 分钟", #selector(snooze)), ("继续陪伴", #selector(resumeObservation)),
            ("喂点零食", #selector(feedPet)), ("让她休息", #selector(sleepPet)),
            ("叫醒她", #selector(wakePet)), ("静音／恢复语音", #selector(toggleVoice)),
            ("退出宠物", #selector(quitPet))]
        for (title, action) in entries {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        return menu
    }

    @objc private func togglePet() {
        if panel.isVisible { panel.orderOut(nil); animationPlayer?.stop() }
        else { panel.orderFrontRegardless(); animationPlayer?.resume() }
    }
    @objc private func openChat() { showChat() }
    @objc private func openSettings() { showSettings() }
    @objc private func quitPet() {
        emit(["type": "quit"])
        shutdown()
    }
    @objc private func pauseObservation() {
        settings.observationEnabled = false
        speechSynthesizer.stopSpeaking(at: .immediate)
        settingsChanged()
        showSpeech("观察已暂停", mood: "idle", speak: false)
    }
    @objc private func snooze() {
        settings.snoozeUntil = nowMilliseconds() + 30 * 60 * 1000
        speechSynthesizer.stopSpeaking(at: .immediate)
        settingsChanged()
        showSpeech("已安静 30 分钟，期间不读取应用、屏幕或系统声音", mood: "idle", speak: false)
    }
    @objc private func resumeObservation() {
        settings.observationEnabled = true
        settings.snoozeUntil = 0
        settingsChanged()
        showSpeech("已恢复陪伴", mood: "idle", speak: false)
    }
    @objc private func feedPet() { interact("feed") }
    @objc private func sleepPet() { interact("sleep") }
    @objc private func wakePet() { interact("wake") }
    @objc private func toggleVoice() {
        settings.voiceEnabled.toggle()
        if !settings.voiceEnabled { speechSynthesizer.stopSpeaking(at: .immediate) }
        settingsChanged()
    }

    func dragBegan() {
        isDragging = true
        panel.ignoresMouseEvents = false
        bubble.isHidden = true
        if settings.dynamicSkinEnabled, animationPlayer?.available == true { animationPlayer?.interaction("drag-hold") }
        else if !settings.reduceMotion { imageView.animator().frameCenterRotation = -7 }
        if !previewMode { emit(["type": "interaction", "kind": "drag-hold", "timestamp": nowMilliseconds()]) }
    }

    func dragEnded() {
        isDragging = false
        imageView.animator().frameCenterRotation = 0
        if let screen = NSScreen.screens.first(where: { $0.visibleFrame.intersects(panel.frame) }) {
            var origin = panel.frame.origin
            let frame = screen.visibleFrame
            if abs(panel.frame.minX - frame.minX) < 35 { origin.x = frame.minX }
            if abs(panel.frame.maxX - frame.maxX) < 35 { origin.x = frame.maxX - panel.frame.width }
            if abs(panel.frame.minY - frame.minY) < 35 { origin.y = frame.minY }
            if abs(panel.frame.maxY - frame.maxY) < 35 { origin.y = frame.maxY - panel.frame.height }
            panel.setFrameOrigin(origin)
        }
        savePosition()
        interact("landing")
    }

    private func updateMousePassthrough() {
        guard panel != nil, panel.isVisible, !isDragging else { return }
        let point = panel.convertPoint(fromScreen: NSEvent.mouseLocation)
        let bubbleHit = !bubble.isHidden && bubble.frame.contains(point)
        let imagePoint = imageView.convert(point, from: panel.contentView)
        var imageHit = imageView.bounds.contains(imagePoint)
        if imageHit, let bitmap = petBitmap, let image = imageView.image {
            let fit = min(imageView.bounds.width / image.size.width, imageView.bounds.height / image.size.height)
            let width = image.size.width * fit, height = image.size.height * fit
            let x = (imagePoint.x - (imageView.bounds.width - width) / 2) / width
            let y = (imagePoint.y - (imageView.bounds.height - height) / 2) / height
            if x < 0 || x >= 1 || y < 0 || y >= 1 { imageHit = false }
            else {
                let px = min(bitmap.pixelsWide - 1, max(0, Int(x * Double(bitmap.pixelsWide))))
                let py = min(bitmap.pixelsHigh - 1, max(0, Int((1 - y) * Double(bitmap.pixelsHigh))))
                imageHit = (bitmap.colorAt(x: px, y: py)?.alphaComponent ?? 1) > 0.08
            }
        }
        panel.ignoresMouseEvents = !(bubbleHit || imageHit)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        audioTranscriber.suppressAudio = true
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        audioTranscriber.suppressAudio = false
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        audioTranscriber.suppressAudio = false
    }

    private func label(_ text: String, font: NSFont = .systemFont(ofSize: 13)) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = font
        field.textColor = .labelColor
        return field
    }

    private func button(_ title: String, action: Selector, frame: NSRect) -> NSButton {
        let control = NSButton(title: title, target: self, action: action)
        control.bezelStyle = .rounded
        control.frame = frame
        return control
    }

    private func showSettings() {
        if settingsWindow == nil { makeSettingsWindow() }
        refreshSettingsUI()
        settingsWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        emit(["type": "request-models"])
    }

    private func makeSettingsWindow() {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 710),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "安静陪伴 · 设置"
        window.isReleasedWhenClosed = false
        window.center()
        let tabs = NSTabView(frame: NSRect(x: 16, y: 16, width: 648, height: 678))
        window.contentView!.addSubview(tabs)

        func tab(_ title: String) -> NSView {
            let item = NSTabViewItem(identifier: title)
            item.label = title
            let view = NSView(frame: NSRect(x: 0, y: 0, width: 624, height: 620))
            item.view = view
            tabs.addTabViewItem(item)
            return view
        }
        func put(_ view: NSView, _ text: String, _ y: CGFloat, _ height: CGFloat = 35, _ font: NSFont = .systemFont(ofSize: 13)) -> NSTextField {
            let field = label(text, font: font)
            field.frame = NSRect(x: 24, y: y, width: 574, height: height)
            view.addSubview(field)
            return field
        }
        func check(_ view: NSView, _ title: String, _ y: CGFloat, _ action: Selector) -> NSButton {
            let control = NSButton(checkboxWithTitle: title, target: self, action: action)
            control.frame = NSRect(x: 24, y: y, width: 574, height: 27)
            view.addSubview(control)
            return control
        }

        let general = tab("陪伴")
        _ = put(general, "她会留意你，也会懂得安静。", 560, 32, .systemFont(ofSize: 20, weight: .semibold))
        statusLabel = put(general, "", 480, 68)
        observeCheckbox = check(general, "观察当前应用与空闲状态", 440, #selector(observeToggled))
        _ = put(general, "默认关闭。暂停或安静期间不读取应用、屏幕或系统声音。应用变化和画面变化才会发送事件，是否开口由模型结合情境决定。", 369, 62)
        intervalLabel = put(general, "", 330, 25)
        intervalLabel.frame.size.width = 200
        intervalSlider = NSSlider(value: settings.captureIntervalSeconds, minValue: 1, maxValue: 30,
                                  target: self, action: #selector(intervalChanged))
        intervalSlider.frame = NSRect(x: 230, y: 328, width: 368, height: 27)
        intervalSlider.isContinuous = false
        general.addSubview(intervalSlider)
        general.addSubview(button("暂停观察", action: #selector(pauseObservation), frame: NSRect(x: 24, y: 271, width: 175, height: 34)))
        general.addSubview(button("安静 30 分钟", action: #selector(snooze), frame: NSRect(x: 221, y: 271, width: 178, height: 34)))
        general.addSubview(button("继续陪伴", action: #selector(resumeObservation), frame: NSRect(x: 421, y: 271, width: 177, height: 34)))
        agentCheckbox = check(general, "显示当前 Harness 智能体进度", 216, #selector(agentToggled))
        agentDetailLabel = put(general, agentSummary, 82, 122)
        _ = put(general, "单击头／身体／尾巴可互动；双击聊天；拖动后可吸附边缘。隐藏后可从菜单栏找回。", 24, 48)

        let modelView = tab("模型与画面")
        _ = put(modelView, "跟随 Harness 默认模型", 559, 32, .systemFont(ofSize: 18, weight: .semibold))
        modelPicker = NSPopUpButton(frame: NSRect(x: 24, y: 512, width: 574, height: 32), pullsDown: false)
        modelPicker.isEnabled = false
        modelView.addSubview(modelPicker)
        _ = put(modelView, "无需额外 API Key。默认模型发生变化后，屏幕和系统声音需要重新同意。", 458, 45)
        screenCheckbox = check(modelView, "允许分析当前应用的屏幕关键帧", 414, #selector(screenToggled))
        disclosureLabel = put(modelView, "", 291, 115)
        disclosureLabel.font = .systemFont(ofSize: 12)
        audioCheckbox = check(modelView, "理解正在播放的系统声音（不是麦克风）", 249, #selector(audioToggled))
        _ = put(modelView, "系统声音先在本机离线转成文字，再发送给默认模型。只在本机／语言支持离线识别且你授权后开启；不保存音频文件。", 178, 64)
        languagePicker = NSPopUpButton(frame: NSRect(x: 24, y: 132, width: 280, height: 30), pullsDown: false)
        languagePicker.addItems(withTitles: ["中文（zh-CN）", "English（en-US）"])
        languagePicker.target = self
        languagePicker.action = #selector(languageSelected)
        modelView.addSubview(languagePicker)
        modelView.addSubview(button("检查本机支持", action: #selector(checkSpeechSupport), frame: NSRect(x: 332, y: 129, width: 266, height: 34)))
        audioStatusLabel = put(modelView, audioStatus, 24, 97)
        audioStatusLabel.font = .systemFont(ofSize: 12)

        let voiceView = tab("语音与动作")
        voiceCheckbox = check(voiceView, "朗读模型生成的话语（本机系统声音）", 555, #selector(voiceToggled))
        voicePicker = NSPopUpButton(frame: NSRect(x: 24, y: 508, width: 574, height: 32), pullsDown: false)
        voices = AVSpeechSynthesisVoice.speechVoices().sorted { ($0.language, $0.name) < ($1.language, $1.name) }
        voicePicker.addItems(withTitles: ["系统默认中文声音"] + voices.map { "\($0.name) · \($0.language)" })
        voicePicker.target = self
        voicePicker.action = #selector(voiceSelected)
        voiceView.addSubview(voicePicker)
        _ = put(voiceView, "语速", 463, 25)
        voiceRateSlider = NSSlider(value: settings.voiceRate, minValue: 0.3, maxValue: 0.65, target: self, action: #selector(voiceRateChanged))
        voiceRateSlider.frame = NSRect(x: 124, y: 459, width: 474, height: 28)
        voiceView.addSubview(voiceRateSlider)
        voiceView.addSubview(button("试听当前声音", action: #selector(testVoice), frame: NSRect(x: 24, y: 406, width: 574, height: 34)))
        _ = put(voiceView, "宠物大小", 351, 25)
        scaleSlider = NSSlider(value: scale, minValue: 0.6, maxValue: 1.6, target: self, action: #selector(scaleChanged))
        scaleSlider.frame = NSRect(x: 124, y: 347, width: 474, height: 28)
        voiceView.addSubview(scaleSlider)
        _ = put(voiceView, "透明度", 301, 25)
        opacitySlider = NSSlider(value: opacity, minValue: 0.45, maxValue: 1, target: self, action: #selector(opacityChanged))
        opacitySlider.frame = NSRect(x: 124, y: 297, width: 474, height: 28)
        voiceView.addSubview(opacitySlider)
        reduceMotionCheckbox = check(voiceView, "减少动态效果", 239, #selector(reduceMotionToggled))
        dynamicSkinCheckbox = check(voiceView, "使用动态角色（取消后使用参考立绘）", 204, #selector(dynamicSkinToggled))
        voiceView.addSubview(button("喂点零食", action: #selector(feedPet), frame: NSRect(x: 24, y: 169, width: 175, height: 34)))
        voiceView.addSubview(button("休息", action: #selector(sleepPet), frame: NSRect(x: 221, y: 169, width: 178, height: 34)))
        voiceView.addSubview(button("叫醒她", action: #selector(wakePet), frame: NSRect(x: 421, y: 169, width: 177, height: 34)))
        _ = put(voiceView, "动态角色和参考立绘都可以摸头、戳身体、轻碰尾巴、喂食和拖动。互动话语由当前默认模型结合情境生成。", 64, 76)

        let memoryView = tab("记忆")
        memoryCheckbox = check(memoryView, "允许保留陪伴记忆", 555, #selector(memoryToggled))
        _ = put(memoryView, "记忆由本插件保存在本机。开启后，相关事实和摘要会交给当前默认模型；可查看、修改或清除。这里不保存截图或音频。", 478, 66)
        _ = put(memoryView, "手动置顶事实（可编辑，不替换模型整理的记忆）", 438, 27)
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 218, width: 574, height: 214))
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        memoryText = NSTextView(frame: scroll.bounds)
        memoryText.delegate = self
        memoryText.string = memoryFacts
        memoryText.isRichText = false
        memoryText.font = .systemFont(ofSize: 14)
        memoryText.autoresizingMask = [.width]
        memoryText.minSize = NSSize(width: 0, height: 214)
        memoryText.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        memoryText.isVerticallyResizable = true
        memoryText.textContainer?.widthTracksTextView = true
        scroll.documentView = memoryText
        memoryView.addSubview(scroll)
        memoryView.addSubview(button("保存置顶事实", action: #selector(saveMemory), frame: NSRect(x: 24, y: 165, width: 175, height: 34)))
        memoryView.addSubview(button("刷新记忆", action: #selector(refreshMemory), frame: NSRect(x: 221, y: 165, width: 178, height: 34)))
        memoryView.addSubview(button("清除陪伴记忆", action: #selector(clearMemory), frame: NSRect(x: 421, y: 165, width: 177, height: 34)))
        memoryView.addSubview(button("查看全部记忆（含模型整理的内容）", action: #selector(showAllMemory), frame: NSRect(x: 24, y: 115, width: 574, height: 34)))
        memoryStatusLabel = put(memoryView, memorySummary, 20, 83)

        let usageView = tab("用量与预算")
        usageView.addSubview(button("刷新账户与今日用量", action: #selector(refreshUsage), frame: NSRect(x: 24, y: 554, width: 574, height: 34)))
        usageLabel = put(usageView, usageSummary, 361, 175)
        let fields: [(String, String, CGFloat)] = [
            ("dailyTokenBudget", "每日 token 上限（0 为不限制）", 307),
            ("dailyBudget", "每日费用预算（0 为不限制）", 254),
            ("inputPricePerMillion", "每百万输入 token 单价（0 为未知）", 201),
            ("outputPricePerMillion", "每百万输出 token 单价（0 为未知）", 148)]
        for (key, title, y) in fields {
            let titleField = put(usageView, title, y, 32)
            titleField.frame.size.width = 375
            let entry = NSTextField(frame: NSRect(x: 414, y: y, width: 184, height: 30))
            entry.placeholderString = "0"
            usageView.addSubview(entry)
            budgetFields[key] = entry
        }
        _ = put(usageView, "达到预算后会暂停主动模型请求。费用按你填写的单价估算，实际扣费以服务方为准；余额仅在可查询时显示。", 70, 64)
        usageView.addSubview(button("保存预算", action: #selector(saveBudget), frame: NSRect(x: 24, y: 22, width: 574, height: 34)))
        settingsWindow = window
    }

    private func refreshSettingsUI() {
        guard settingsWindow != nil else { return }
        observeCheckbox.state = settings.observationEnabled ? .on : .off
        screenCheckbox.state = settings.screenEnabled ? .on : .off
        screenCheckbox.isEnabled = !settings.provider.isEmpty && !settings.model.isEmpty && selectedModelSupportsVision()
        audioCheckbox.state = settings.videoAudioEnabled ? .on : .off
        intervalSlider.doubleValue = settings.captureIntervalSeconds
        intervalLabel.stringValue = "画面间隔：\(Int(settings.captureIntervalSeconds)) 秒"
        statusLabel.stringValue = featureNotice + "\n" + (previewMode ? "界面预览：不会观察、截图、识别声音或调用模型。" : modelStatus)
        modelPicker.removeAllItems()
        let resolved = settings.provider.isEmpty || settings.model.isEmpty ? "等待确认 Harness 默认模型" : "\(settings.provider) / \(settings.model)"
        modelPicker.addItem(withTitle: resolved)
        modelPicker.isEnabled = false
        let vision = selectedModelSupportsVision() ? "" : "\n当前默认模型没有声明图片能力，屏幕理解暂不可用。"
        disclosureLabel.stringValue = "发送给当前默认模型服务：\(resolved)。优先当前应用窗口，无法定位时采样显示器并排除宠物。分析的关键帧会按 Harness 附件机制保存在本机，再发送给模型；一般帧只在内存中比较。更换默认模型后需要重新同意。\(vision)"
        audioStatusLabel.stringValue = audioStatus
        languagePicker.selectItem(at: settings.speechLanguage == "en-US" ? 1 : 0)
        voiceCheckbox.state = settings.voiceEnabled ? .on : .off
        voiceRateSlider.doubleValue = settings.voiceRate
        let voiceIndex = voices.firstIndex(where: { $0.identifier == settings.voiceIdentifier })
        voicePicker.selectItem(at: voiceIndex.map { $0 + 1 } ?? 0)
        memoryCheckbox.state = settings.memoryEnabled ? .on : .off
        agentCheckbox.state = settings.agentProgressEnabled ? .on : .off
        reduceMotionCheckbox.state = settings.reduceMotion ? .on : .off
        dynamicSkinCheckbox.state = settings.dynamicSkinEnabled ? .on : .off
        agentDetailLabel.stringValue = agentSummary
        usageLabel.stringValue = usageSummary
        memoryStatusLabel.stringValue = memorySummary
        let values: [String: Double] = ["dailyTokenBudget": settings.dailyTokenBudget, "dailyBudget": settings.dailyBudget,
                                       "inputPricePerMillion": settings.inputPricePerMillion, "outputPricePerMillion": settings.outputPricePerMillion]
        for (key, value) in values where budgetFields[key]?.currentEditor() == nil {
            budgetFields[key]?.stringValue = value.rounded() == value ? String(format: "%.0f", value) : String(value)
        }
        agentPill?.isHidden = !settings.agentProgressEnabled || agentSummary == "暂无进行中的任务"
    }

    private func selectedModelSupportsVision() -> Bool {
        models.contains { $0.provider == settings.provider && $0.model == settings.model && $0.vision }
    }

    @objc private func observeToggled() {
        settings.observationEnabled = observeCheckbox.state == .on
        settingsChanged()
    }
    @objc private func screenToggled() {
        if screenCheckbox.state == .off {
            settings.screenEnabled = false
            settings.consentPair = ""
            defaults.removeObject(forKey: "screenConsentPair")
            settingsChanged()
            return
        }
        settings.screenEnabled = false
        guard !previewMode else { modelStatus = "界面预览不截图或申请权限。"; refreshSettingsUI(); return }
        guard selectedModelSupportsVision(), !settings.provider.isEmpty, !settings.model.isEmpty else {
            modelStatus = "当前默认模型没有确认图片能力，未开启屏幕理解。"
            refreshSettingsUI()
            return
        }
        let alert = NSAlert()
        alert.messageText = "允许她理解当前应用的画面吗？"
        alert.informativeText = "当前默认模型服务：\(settings.provider) / \(settings.model)。\n\n优先当前应用窗口，无法定位窗口时采样显示器并排除宠物。画面可能包含私人聊天、文档和账号信息。普通帧只在内存中比较；需要模型理解的关键帧会按 Harness 附件机制保存在本机并发送给该模型服务。不会保存屏幕视频。暂停观察或关闭此开关会停止采集，更换默认模型后需要重新同意。"
        alert.addButton(withTitle: "同意并开启画面理解")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { refreshSettingsUI(); return }
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        guard CGPreflightScreenCaptureAccess() else {
            modelStatus = "尚未获得屏幕录制权限。请在系统设置中授权“安静陪伴”，然后重新开启。"
            refreshSettingsUI()
            return
        }
        settings.screenEnabled = true
        settings.consentPair = settings.pair
        defaults.set(settings.consentPair, forKey: "screenConsentPair")
        settingsChanged(screenConsent: true)
    }

    @objc private func audioToggled() {
        if audioCheckbox.state == .off {
            settings.videoAudioEnabled = false
            audioConsentPair = ""
            defaults.removeObject(forKey: "audioConsentPair")
            settingsChanged()
            return
        }
        settings.videoAudioEnabled = false
        guard !previewMode else { audioStatus = "界面预览不捕获声音或申请权限。"; refreshSettingsUI(); return }
        guard !settings.provider.isEmpty, !settings.model.isEmpty else {
            audioStatus = "请等待 Harness 默认模型就绪后再开启。"
            refreshSettingsUI()
            return
        }
        guard SystemAudioTranscriber.supportsOnDevice(language: settings.speechLanguage) else {
            audioStatus = "当前系统／语言没有可用的本机离线语音识别，因此未开启。可切换语言后重新检查。"
            refreshSettingsUI()
            return
        }
        let alert = NSAlert()
        alert.messageText = "允许理解正在播放的系统声音吗？"
        alert.informativeText = "只捕获系统播放的声音，不使用麦克风，也不保存录音。本机离线语音识别会把声音转成文字，识别结果将发送给当前默认模型：\(settings.provider) / \(settings.model)。\n\n系统声音可能包含会议、聊天或其他私人内容。开启需要 macOS 屏幕／系统声音录制权限及语音识别权限。只有本机支持离线识别时才工作，不回退到 Apple 的网络识别。"
        alert.addButton(withTitle: "同意并开启系统声音理解")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { refreshSettingsUI(); return }
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                guard status == .authorized else {
                    self.audioStatus = "未获语音识别权限，系统声音理解保持关闭。"
                    self.refreshSettingsUI()
                    return
                }
                if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
                guard CGPreflightScreenCaptureAccess() else {
                    self.audioStatus = "未获屏幕／系统声音录制权限。请在系统设置授权后重新开启。"
                    self.refreshSettingsUI()
                    return
                }
                self.settings.videoAudioEnabled = true
                self.audioConsentPair = self.settings.pair
                self.defaults.set(self.audioConsentPair, forKey: "audioConsentPair")
                self.settingsChanged(audioConsent: true)
            }
        }
    }

    @objc private func languageSelected() {
        settings.speechLanguage = languagePicker.indexOfSelectedItem == 1 ? "en-US" : "zh-CN"
        settings.videoAudioEnabled = false
        audioStatus = "识别语言已改变，请重新开启系统声音理解。"
        settingsChanged()
    }
    @objc private func checkSpeechSupport() {
        let available = SystemAudioTranscriber.available(language: settings.speechLanguage)
        audioStatus = available ? "当前语言支持本机离线语音识别。开启仍需你的同意及系统权限。" : "当前系统／语言没有可用的本机离线识别；此功能不会回退到网络服务。"
        refreshSettingsUI()
    }
    @objc private func voiceToggled() {
        settings.voiceEnabled = voiceCheckbox.state == .on
        if !settings.voiceEnabled { speechSynthesizer.stopSpeaking(at: .immediate) }
        settingsChanged()
    }
    @objc private func voiceSelected() {
        let index = voicePicker.indexOfSelectedItem - 1
        settings.voiceIdentifier = voices.indices.contains(index) ? voices[index].identifier : ""
        settingsChanged()
    }
    @objc private func voiceRateChanged() { settings.voiceRate = voiceRateSlider.doubleValue; settingsChanged() }
    @objc private func testVoice() {
        guard !previewMode else { return }
        let utterance = AVSpeechUtterance(string: "这是当前系统声音的试听。")
        utterance.voice = AVSpeechSynthesisVoice(identifier: settings.voiceIdentifier) ?? AVSpeechSynthesisVoice(language: "zh-CN")
        utterance.rate = Float(settings.voiceRate)
        speechSynthesizer.stopSpeaking(at: .immediate)
        speechSynthesizer.speak(utterance)
    }
    @objc private func memoryToggled() { settings.memoryEnabled = memoryCheckbox.state == .on; settingsChanged() }
    @objc private func agentToggled() { settings.agentProgressEnabled = agentCheckbox.state == .on; settingsChanged() }
    @objc private func reduceMotionToggled() {
        settings.reduceMotion = reduceMotionCheckbox.state == .on
        animationPlayer?.setReducedMotion(settings.reduceMotion)
        settingsChanged()
    }
    @objc private func dynamicSkinToggled() {
        settings.dynamicSkinEnabled = dynamicSkinCheckbox.state == .on
        defaults.set(settings.dynamicSkinEnabled, forKey: "dynamicSkinEnabled")
        configureAnimation()
        updateImage()
        layoutPet()
        settingsChanged()
    }
    @objc private func saveMemory() {
        guard !previewMode else { return }
        memoryDirty = false
        emit(["type": "memory-save", "text": String(memoryText.string.prefix(16000))])
    }
    @objc private func refreshMemory() { if !previewMode { emit(["type": "request-memory"]) } }
    @objc private func showAllMemory() {
        if allMemoryWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 570),
                                  styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
            window.title = "已保存的全部陪伴记忆 · 只读"
            window.isReleasedWhenClosed = false
            window.minSize = NSSize(width: 560, height: 430)
            window.center()
            let scroll = NSScrollView(frame: NSRect(x: 20, y: 92, width: 600, height: 458))
            scroll.autoresizingMask = [.width, .height]
            scroll.hasVerticalScroller = true
            scroll.borderType = .bezelBorder
            let text = NSTextView(frame: scroll.bounds)
            text.isEditable = false
            text.isSelectable = true
            text.isRichText = false
            text.font = .systemFont(ofSize: 13)
            text.isVerticallyResizable = true
            text.autoresizingMask = [.width]
            text.textContainer?.widthTracksTextView = true
            scroll.documentView = text
            window.contentView!.addSubview(scroll)
            let hint = label("可复制记忆编号。在聊天中输入 /forget 后接编号或标记，或输入 /忘记 后接完整内容，可以定向遗忘。")
            hint.frame = NSRect(x: 20, y: 20, width: 420, height: 60)
            hint.autoresizingMask = [.width]
            window.contentView!.addSubview(hint)
            let manage = button("去聊天中管理", action: #selector(openChat), frame: NSRect(x: 456, y: 25, width: 164, height: 38))
            manage.autoresizingMask = [.minXMargin]
            window.contentView!.addSubview(manage)
            allMemoryText = text
            allMemoryWindow = window
        }
        allMemoryText?.string = allMemoryFacts
        allMemoryWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if !previewMode { emit(["type": "request-memory"]) }
    }
    @objc private func clearMemory() {
        guard !previewMode else { return }
        let alert = NSAlert()
        alert.messageText = "清除陪伴记忆？"
        alert.informativeText = "此操作只针对本插件保存的陪伴记忆。清除前请确认不再需要其中的事实和摘要。"
        alert.addButton(withTitle: "清除")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn { emit(["type": "memory-clear"]) }
    }
    @objc private func refreshUsage() { if !previewMode { emit(["type": "request-usage"]) } }
    func textDidChange(_ notification: Notification) {
        if notification.object as? NSTextView === memoryText { memoryDirty = true }
    }
    @objc private func saveBudget() {
        for (key, field) in budgetFields {
            guard let value = Double(field.stringValue), value.isFinite, value >= 0 else {
                modelStatus = "预算和单价需要填写非负数字。"
                refreshSettingsUI()
                return
            }
            switch key {
            case "dailyTokenBudget": settings.dailyTokenBudget = value
            case "dailyBudget": settings.dailyBudget = value
            case "inputPricePerMillion": settings.inputPricePerMillion = value
            case "outputPricePerMillion": settings.outputPricePerMillion = value
            default: break
            }
        }
        settingsChanged()
    }

    private func syncAudioState() {
        let wanted = !previewMode && settings.active && settings.videoAudioEnabled
            && audioConsentPair == settings.pair && !settings.provider.isEmpty
        if wanted && !audioRunning && !audioStarting {
            guard SFSpeechRecognizer.authorizationStatus() == .authorized, CGPreflightScreenCaptureAccess() else {
                settings.videoAudioEnabled = false
                audioStatus = "系统声音或语音识别权限不可用，声音理解已关闭。"
                refreshSettingsUI()
                return
            }
            audioStarting = true
            let pair = settings.pair
            audioTranscriber.onTranscript = { [weak self] text in
                guard let self, self.settings.active, self.settings.videoAudioEnabled,
                      self.audioConsentPair == self.settings.pair, !previewMode else { return }
                emit(["type": "transcript", "text": text, "timestamp": nowMilliseconds(),
                      "source": "system-audio", "onDevice": true, "language": self.settings.speechLanguage])
            }
            audioTranscriber.onFailure = { [weak self] detail in
                guard let self else { return }
                self.settings.videoAudioEnabled = false
                self.audioStatus = detail
                self.audioRunning = false
                Task { await self.audioTranscriber.stop() }
                self.settingsChanged()
            }
            Task { @MainActor [weak self] in
                guard let self else { return }
                defer { self.audioStarting = false }
                do {
                    try await self.audioTranscriber.start(language: self.settings.speechLanguage)
                    guard self.settings.active, self.settings.videoAudioEnabled, self.settings.pair == pair else {
                        await self.audioTranscriber.stop()
                        return
                    }
                    self.audioRunning = true
                    self.audioStatus = "正在本机识别系统声音；仅文字结果会发送给当前默认模型。"
                } catch {
                    self.settings.videoAudioEnabled = false
                    self.audioStatus = "无法开启本机系统声音理解；未使用麦克风或网络识别。"
                }
                self.refreshSettingsUI()
            }
        } else if !wanted && (audioRunning || audioStarting) {
            audioRunning = false
            Task { [weak self] in await self?.audioTranscriber.stop() }
        }
    }

    @objc private func intervalChanged() {
        settings.captureIntervalSeconds = intervalSlider.doubleValue.rounded()
        settingsChanged()
    }
    @objc private func scaleChanged() {
        scale = scaleSlider.doubleValue
        defaults.set(scale, forKey: "petScale")
        layoutPet()
        savePosition()
    }
    @objc private func opacityChanged() {
        opacity = opacitySlider.doubleValue
        defaults.set(opacity, forKey: "petOpacity")
        panel.alphaValue = opacity
    }

    private func settingsChanged(screenConsent: Bool = false, audioConsent: Bool = false) {
        captureGeneration += 1
        var message = settings.json
        message["type"] = "settings"
        if screenConsent { message["screenConsent"] = true }
        if audioConsent { message["audioConsent"] = true }
        message["audioConsentPair"] = audioConsentPair
        emit(message)
        refreshSettingsUI()
        resetObservationTimer()
    }

    func showChat() {
        if chatWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 450, height: 245),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "和她说句话"
            window.isReleasedWhenClosed = false
            window.center()
            chatReply = label("我在听。你想说什么？", font: .systemFont(ofSize: 15))
            chatReply.frame = NSRect(x: 22, y: 95, width: 406, height: 125)
            window.contentView!.addSubview(chatReply)
            chatInput = NSTextField(frame: NSRect(x: 22, y: 35, width: 312, height: 32))
            chatInput.placeholderString = "说句话，或聊聊你正在看的内容…"
            chatInput.target = self
            chatInput.action = #selector(sendChat)
            window.contentView!.addSubview(chatInput)
            window.contentView!.addSubview(button("发送", action: #selector(sendChat), frame: NSRect(x: 346, y: 32, width: 82, height: 36)))
            chatWindow = window
        }
        chatWindow?.makeKeyAndOrderFront(nil)
        chatWindow?.makeFirstResponder(chatInput)
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func sendChat() {
        let text = chatInput.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        guard !previewMode else {
            chatReply.stringValue = "界面预览不发送消息或调用模型。"
            return
        }
        chatInput.stringValue = ""
        chatReply.stringValue = "我在听，稍等一下……"
        emit(["type": "chat", "text": String(text.prefix(4000))])
    }

    private func resetObservationTimer() {
        observationTimer?.invalidate()
        observationTimer = nil
        syncAudioState()
        guard !previewMode, settings.observationEnabled else { return }
        observationTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in self?.observe() }
    }

    private func fingerprint(_ image: CGImage) -> [UInt8]? {
        var bytes = [UInt8](repeating: 0, count: 32 * 32)
        let drawn = bytes.withUnsafeMutableBytes { pointer -> Bool in
            guard let context = CGContext(data: pointer.baseAddress, width: 32, height: 32, bitsPerComponent: 8,
                                          bytesPerRow: 32, space: CGColorSpaceCreateDeviceGray(),
                                          bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            context.interpolationQuality = .low
            context.draw(image, in: CGRect(x: 0, y: 0, width: 32, height: 32))
            return true
        }
        return drawn ? bytes : nil
    }

    private func observe() {
        syncAudioState()
        guard !previewMode, settings.active, !isShuttingDown else { return }
        let app = NSWorkspace.shared.frontmostApplication
        guard app?.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
        let nextSleeping = forcedSleep || (idle.isFinite && idle >= 300)
        if sleeping != nextSleeping {
            sleeping = nextSleeping
            if settings.dynamicSkinEnabled { animationPlayer?.interaction(sleeping ? "sleep" : "wake") }
            if !previewMode { emit(["type": "interaction", "kind": sleeping ? "sleep" : "wake", "automatic": true, "timestamp": nowMilliseconds()]) }
        }
        sleepLabel.isHidden = !sleeping
        let bundleID = app?.bundleIdentifier ?? ""
        let idleBucket = idle < 60 ? 0 : Int(min(10000, idle / 60))
        let metadataKey = "\(bundleID):\(idleBucket)"
        let metadataChanged = metadataKey != lastMetadataKey
        if metadataChanged { lastMetadataKey = metadataKey }
        var observation: [String: Any] = [
            "type": "observation", "app": app?.localizedName ?? "未知应用",
            "bundleId": bundleID, "idleSeconds": idle.isFinite ? max(0, idle) : 0,
            "timestamp": nowMilliseconds(), "contextChanged": metadataChanged]
        guard screenshotFeatureAvailable, settings.screenEnabled, settings.consentPair == settings.pair,
              selectedModelSupportsVision(), !settings.provider.isEmpty, !settings.model.isEmpty else {
            if metadataChanged { emit(observation) }
            return
        }
        guard Date().timeIntervalSince(lastFrameTime) >= settings.captureIntervalSeconds, !captureInFlight else {
            if metadataChanged { emit(observation) }
            return
        }
        guard CGPreflightScreenCaptureAccess() else {
            settings.screenEnabled = false
            settings.consentPair = ""
            modelStatus = "屏幕录制权限不可用，画面理解已关闭。"
            settingsChanged()
            if metadataChanged { emit(observation) }
            return
        }
        captureInFlight = true
        lastFrameTime = Date()
        let generation = captureGeneration
        let pid = app?.processIdentifier
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.captureInFlight = false }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                let window = content.windows.first {
                    $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 120 && $0.frame.height > 100
                }
                let filter: SCContentFilter
                let dimensions: CGSize
                let context: String
                if let window {
                    filter = SCContentFilter(desktopIndependentWindow: window)
                    dimensions = window.frame.size
                    context = "\(bundleID):\(window.windowID)"
                    if let title = window.title, !title.isEmpty { observation["windowTitle"] = String(title.prefix(240)) }
                } else {
                    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { return }
                    let ownApps = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
                    filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
                    dimensions = CGSize(width: display.width, height: display.height)
                    context = "\(bundleID):display:\(display.displayID)"
                }
                let configuration = SCStreamConfiguration()
                let ratio = min(1, 1280.0 / max(dimensions.width, dimensions.height))
                configuration.width = max(1, Int(dimensions.width * ratio))
                configuration.height = max(1, Int(dimensions.height * ratio))
                configuration.showsCursor = false
                configuration.capturesAudio = false
                if #available(macOS 15.0, *) { configuration.captureMicrophone = false }
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                guard self.captureGeneration == generation, self.settings.active, self.settings.screenEnabled,
                      self.settings.consentPair == self.settings.pair, !self.isShuttingDown,
                      NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return }
                let next = self.fingerprint(image)
                var difference = 1.0
                if let next, let previous = self.lastFingerprint, next.count == previous.count, context == self.lastFrameContext {
                    difference = zip(next, previous).reduce(0.0) { $0 + abs(Double($1.0) - Double($1.1)) } / (Double(next.count) * 255)
                }
                guard difference >= 0.022 || context != self.lastFrameContext else {
                    if metadataChanged { emit(observation) }
                    return
                }
                self.lastFingerprint = next
                self.lastFrameContext = context
                let bitmap = NSBitmapImageRep(cgImage: image)
                if let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.66]) {
                    observation["screen"] = ["data": data.base64EncodedString(), "mimeType": "image/jpeg",
                                             "width": image.width, "height": image.height]
                    observation["visualChange"] = difference
                    observation["frameChanged"] = true
                    emit(observation)
                }
            } catch {
                guard self.captureGeneration == generation, self.settings.active else { return }
                self.modelStatus = "暂时无法读取画面，仍可根据当前应用陪伴。"
                self.refreshSettingsUI()
                if metadataChanged { emit(observation) }
            }
        }
    }

    private func readCommands() {
        Thread.detachNewThread { [weak self] in
            var buffer = Data()
            while true {
                // availableData returns a short pipe read immediately; readData(ofLength:)
                // may wait for its full count and leave live control commands buffered.
                let chunk = FileHandle.standardInput.availableData
                if chunk.isEmpty {
                    DispatchQueue.main.async { self?.shutdown() }
                    return
                }
                buffer.append(chunk)
                if buffer.count > 2_000_000 { buffer.removeAll(); continue }
                while let newline = buffer.firstIndex(of: 10) {
                    let line = buffer[..<newline]
                    buffer.removeSubrange(...newline)
                    guard let command = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                    DispatchQueue.main.async { self?.handle(command) }
                }
            }
        }
    }

    @discardableResult private func resolveDefault(provider: String, model: String) -> Bool {
        let previous = settings.pair
        let hadModel = !settings.provider.isEmpty && !settings.model.isEmpty
        settings.provider = provider
        settings.model = model
        let consentMismatch = (!settings.consentPair.isEmpty && settings.consentPair != settings.pair)
            || (!audioConsentPair.isEmpty && audioConsentPair != settings.pair)
        if previous != settings.pair && (hadModel || consentMismatch) {
            settings.screenEnabled = false
            settings.videoAudioEnabled = false
            settings.consentPair = ""
            audioConsentPair = ""
            defaults.removeObject(forKey: "screenConsentPair")
            defaults.removeObject(forKey: "audioConsentPair")
            lastFingerprint = nil
            lastFrameContext = ""
            captureGeneration += 1
            syncAudioState()
            return true
        }
        return false
    }

    private func updateAgent(_ command: [String: Any]) {
        let envelope = command["snapshot"] as? [String: Any] ?? command
        let phaseNames = ["idle": "空闲", "thinking": "思考中", "working": "执行中", "running": "进行中", "replying": "回复中",
                          "tool": "执行工具", "waiting": "等待中", "blocked": "等待处理", "approval": "等待确认",
                          "waiting-approval": "等待审批", "waiting-user": "等待回答",
                          "success": "已完成", "completed": "已完成", "error": "出现问题", "failed": "出现问题"]
        var lines: [String] = []
        if let value = envelope["current"] as? [String: Any] {
            let phase = value["phase"] as? String ?? "idle"
            let tool = value["toolName"] as? String ?? ""
            let lowerTool = tool.lowercased()
            var activity = value["activity"] as? String ?? ""
            if activity.isEmpty && !tool.isEmpty {
                if lowerTool.contains("search") || lowerTool.contains("browse") { activity = "searching" }
                else if ["shell", "bash", "exec", "terminal"].contains(where: { lowerTool.contains($0) }) { activity = "commanding" }
                else if lowerTool.contains("test") { activity = "testing" }
                else if lowerTool.contains("edit") || lowerTool.contains("write") || lowerTool.contains("patch") { activity = "editing" }
                else { activity = "using-tool" }
            }
            activeAgentPhase = phase
            activeAgentActivity = activity
            let localized = phaseNames[phase.lowercased()] ?? phase
            if let title = value["title"] as? String, !title.isEmpty { lines.append(title) }
            lines.append("状态：\(localized)")
            if !tool.isEmpty { lines.append("工具：\(tool)") }
            if let turn = value["turn"] { lines.append("当前轮次：\(formatted(turn))") }
            if let step = value["step"] { lines.append("当前步骤：\(formatted(step))") }
            if let count = value["observedCompletedSteps"] ?? value["completedSteps"] {
                lines.append("已观察到完成：\(formatted(count)) 步")
            }
            agentPill.stringValue = String((localized + (tool.isEmpty ? "" : " · " + tool)).prefix(22))
        } else {
            activeAgentPhase = "idle"
            activeAgentActivity = ""
            lines.append("暂无进行中的任务")
            agentPill.stringValue = ""
        }
        if let active = envelope["activeCount"], let waiting = envelope["waitingCount"] {
            lines.append("进行中 \(formatted(active)) · 等待中 \(formatted(waiting))")
        }
        agentSummary = lines.joined(separator: "\n")
        if settings.dynamicSkinEnabled && !modelPending { animationPlayer?.setState(activeAgentPhase, activity: activeAgentActivity) }
        agentPill.toolTip = agentSummary
        agentPill.isHidden = !settings.agentProgressEnabled || agentPill.stringValue.isEmpty
        refreshSettingsUI()
    }

    private func formatted(_ value: Any?) -> String {
        if let number = value as? NSNumber { return number.stringValue }
        if let text = value as? String, !text.isEmpty { return text }
        return "未知"
    }

    private func updateUsage(_ command: [String: Any]) {
        let usage = command["usage"] as? [String: Any] ?? command
        let balance = command["balance"] as? [String: Any] ?? [:]
        let budget = command["budget"] as? [String: Any] ?? [:]
        let total = usage["totalTokens"] ?? usage["tokens"] ?? usage["dailyTokens"]
        let costs = usage["estimatedCosts"] as? [String: Any] ?? [:]
        let costText = costs.isEmpty ? formatted(usage["estimatedCost"] ?? usage["cost"] ?? usage["dailyCost"])
            : costs.keys.sorted().map { "\(formatted(costs[$0])) \($0)" }.joined(separator: "；")
        let tokenCoverage = usage["usageComplete"] as? Bool == true ? "" : "（仅已上报部分）"
        let costCoverage = !costs.isEmpty && usage["estimatedCostComplete"] as? Bool != true ? "（不完整估算）" : ""
        var lines = ["今日 token：\(formatted(total))\(tokenCoverage)",
                     "输入／输出 token：\(formatted(usage["inputTokens"])) ／ \(formatted(usage["outputTokens"]))",
                     "今日估算费用：\(costText)\(costCoverage)"]
        if balance["available"] as? Bool == true, let wallets = balance["wallets"] as? [[String: Any]], !wallets.isEmpty {
            lines.append("账户余额：" + wallets.map { wallet in
                let currency = wallet["currency"] as? String ?? ""
                let amount = formatted(wallet["totalBalance"] ?? wallet["total_balance"] ?? wallet["balance"] ?? wallet["amount"])
                return "\(amount) \(currency)"
            }.joined(separator: "；"))
        } else { lines.append("账户余额：无法查询／未提供") }
        if budget["reached"] as? Bool == true { lines.append("预算已达上限，后续主动模型请求会暂停。") }
        else { lines.append("预算：按已设置上限执行；费用为估算值。") }
        usageSummary = lines.joined(separator: "\n")
        refreshSettingsUI()
    }

    private func updateMemory(_ command: [String: Any]) {
        let value = command["snapshot"] as? [String: Any] ?? command
        let text = value["factsText"] as? String ?? value["text"] as? String ?? ""
        memoryFacts = text
        if !memoryDirty { memoryText?.string = text }
        if let facts = value["facts"] as? [[String: Any]] {
            allMemoryFacts = facts.map { fact in
                let origin = fact["pinned"] as? Bool == true ? "手动置顶" : "模型整理"
                let content = fact["text"] as? String ?? ""
                var lines = ["【\(origin)】", content]
                if let id = fact["id"] as? String, !id.isEmpty { lines.append("编号：\(id)") }
                if let slot = fact["slot"] as? String, !slot.isEmpty { lines.append("标记：\(slot)") }
                return lines.joined(separator: "\n")
            }.joined(separator: "\n\n──────────\n\n")
            if facts.isEmpty { allMemoryFacts = "还没有保存的陪伴记忆。" }
        } else { allMemoryFacts = value["text"] as? String ?? "还没有保存的陪伴记忆。" }
        allMemoryText?.string = allMemoryFacts
        let counts = value["counts"] as? [String: Any] ?? [:]
        let countText = counts.isEmpty ? "条目：\(formatted(value["count"] ?? value["memoryCount"] ?? value["factsCount"]))"
            : "事实 \(formatted(counts["facts"])) · 用户事实 \(formatted(counts["pinned"])) · 片段 \(formatted(counts["episodes"]))"
        let summary = value["summary"] as? String ?? "已读取本机陪伴记忆。"
        memorySummary = summary + "\n" + countText
        refreshSettingsUI()
    }

    private func handle(_ command: [String: Any]) {
        switch command["type"] as? String {
        case "ping":
            if let id = command["id"] as? String { emit(["type": "pong", "id": String(id.prefix(128))]) }
        case "speech":
            showSpeech(command["text"] as? String ?? "", mood: command["mood"] as? String ?? "idle",
                       speak: command["speak"] as? Bool ?? false)
        case "mood":
            let mood = command["mood"] as? String ?? "idle"
            currentMood = mood
            modelPending = mood == "thinking"
            if settings.dynamicSkinEnabled {
                animationPlayer?.setState(modelPending ? "thinking" : activeAgentPhase, activity: activeAgentActivity)
            }
            else { updateImage() }
        case "status":
            modelStatus = command["text"] as? String ?? ""
            refreshSettingsUI()
        case "models":
            models = (command["models"] as? [[String: Any]] ?? []).compactMap(CompanionModel.init)
            let provider = command["defaultProvider"] as? String
            let model = command["defaultModel"] as? String
            if let provider, let model { resolveDefault(provider: provider, model: model) }
            else if settings.provider.isEmpty, models.count == 1 {
                resolveDefault(provider: models[0].provider, model: models[0].model)
            }
            refreshSettingsUI()
            resetObservationTimer()
        case "settings":
            guard let incoming = command["settings"] as? [String: Any] else { return }
            resolveDefault(provider: incoming["provider"] as? String ?? settings.provider,
                           model: incoming["model"] as? String ?? settings.model)
            if let value = incoming["observationEnabled"] as? Bool { settings.observationEnabled = value }
            if let value = incoming["captureIntervalSeconds"] as? Double, value.isFinite { settings.captureIntervalSeconds = min(30, max(1, value)) }
            if let value = incoming["snoozeUntil"] as? Double, value.isFinite { settings.snoozeUntil = max(0, value) }
            if let value = incoming["screenEnabled"] as? Bool {
                let pair = incoming["consentPair"] as? String ?? settings.consentPair
                settings.consentPair = pair == settings.pair && !settings.provider.isEmpty ? pair : ""
                settings.screenEnabled = value && settings.consentPair == settings.pair && !settings.provider.isEmpty
                    && CGPreflightScreenCaptureAccess()
            }
            if let value = incoming["videoAudioEnabled"] as? Bool {
                let pair = incoming["audioConsentPair"] as? String ?? audioConsentPair
                audioConsentPair = pair == settings.pair && !settings.provider.isEmpty ? pair : ""
                settings.videoAudioEnabled = value && audioConsentPair == settings.pair && !settings.provider.isEmpty
                    && CGPreflightScreenCaptureAccess() && SFSpeechRecognizer.authorizationStatus() == .authorized
            }
            if let value = incoming["voiceEnabled"] as? Bool {
                settings.voiceEnabled = value
                if !value { speechSynthesizer.stopSpeaking(at: .immediate) }
            }
            if let value = incoming["voiceIdentifier"] as? String { settings.voiceIdentifier = value }
            if let value = incoming["voiceRate"] as? Double, value.isFinite { settings.voiceRate = min(0.65, max(0.3, value)) }
            if let value = incoming["speechLanguage"] as? String { settings.speechLanguage = ["zh-CN", "en-US"].contains(value) ? value : "zh-CN" }
            if let value = incoming["memoryEnabled"] as? Bool { settings.memoryEnabled = value }
            if let value = incoming["agentProgressEnabled"] as? Bool { settings.agentProgressEnabled = value }
            if let value = incoming["reduceMotion"] as? Bool { settings.reduceMotion = value }
            animationPlayer?.setReducedMotion(settings.reduceMotion)
            if let value = incoming["dynamicSkinEnabled"] as? Bool, value != settings.dynamicSkinEnabled {
                settings.dynamicSkinEnabled = value
                defaults.set(value, forKey: "dynamicSkinEnabled")
                configureAnimation()
                updateImage()
                layoutPet()
            }
            if let value = incoming["dailyTokenBudget"] as? Double, value.isFinite { settings.dailyTokenBudget = max(0, value) }
            if let value = incoming["dailyBudget"] as? Double, value.isFinite { settings.dailyBudget = max(0, value) }
            if let value = incoming["inputPricePerMillion"] as? Double, value.isFinite { settings.inputPricePerMillion = max(0, value) }
            if let value = incoming["outputPricePerMillion"] as? Double, value.isFinite { settings.outputPricePerMillion = max(0, value) }
            captureGeneration += 1
            refreshSettingsUI()
            resetObservationTimer()
        case "agent": updateAgent(command)
        case "usage": updateUsage(command)
        case "memory": updateMemory(command)
        case "shutdown": shutdown()
        case "open-settings": showSettings()
        default: break
        }
    }

    private func shutdown() {
        guard !isShuttingDown else { return }
        isShuttingDown = true
        captureGeneration += 1
        observationTimer?.invalidate()
        animationTimer?.invalidate()
        passthroughTimer?.invalidate()
        poseTimer?.invalidate()
        bubbleTimer?.invalidate()
        speechSynthesizer.stopSpeaking(at: .immediate)
        animationPlayer?.stop()
        Task { await audioTranscriber.stop() }
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }
}

if CommandLine.arguments.contains("--self-test") {
    let settings = CompanionSettings()
    let animationRoot = Bundle.main.resourceURL!.appendingPathComponent("pet/animations", isDirectory: true)
    let animation = PetAnimationPlayer(root: animationRoot) { _ in }
    let decodedFrame = animation.firstFrameDecodes()
    let passed = !settings.observationEnabled && !settings.screenEnabled && !settings.videoAudioEnabled
        && !settings.voiceEnabled && !settings.memoryEnabled && animation.available && decodedFrame
    emit(["type": "ready", "protocolVersion": 1, "selfTest": true])
    emit(["type": "self-test", "passed": passed,
          "captureDefault": false, "metadataDefault": false, "minimumIntervalSeconds": 1,
          "maximumImageDimension": 1280, "audioCapture": false,
          "screenshotFeatureAvailable": screenshotFeatureAvailable,
          "systemAudioDefault": settings.videoAudioEnabled, "voiceDefault": settings.voiceEnabled,
          "memoryDefault": settings.memoryEnabled, "defaultModel": "harness",
          "animationManifest": animation.available, "webpDecoded": decodedFrame,
          "maximumDecodedFrameCache": 12])
    if !passed { exit(1) }
} else {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = CompanionApp()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
