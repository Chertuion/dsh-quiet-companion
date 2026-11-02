import AppKit
import CoreGraphics
import ScreenCaptureKit
import AVFoundation
import Speech
import CoreMedia
import Darwin
import ApplicationServices
import Carbon

private let previewMode = CommandLine.arguments.contains("--preview")
private let screenshotFeatureAvailable = true
private let featureNotice = "跟随 Harness 默认模型。屏幕和系统声音需要单独同意；可随时暂停。"
private let encoderLock = NSLock()
private var transportInput = FileHandle.standardInput
private var transportOutput = FileHandle.standardOutput
private var ipcToken: String?
private var usingSocketTransport = false

private func argument(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else { return nil }
    return CommandLine.arguments[index + 1]
}

/// LaunchServices owns the GUI application identity; the private local socket
/// preserves the Host's existing line protocol without inheriting its TCC identity.
private func connectHostTransport() -> Bool {
    guard let path = argument("--ipc-socket") else { return true }
    guard let token = argument("--ipc-token"), (16...256).contains(token.utf8.count) else { return false }
    var socketInfo = stat()
    var directoryInfo = stat()
    let directory = URL(fileURLWithPath: path).deletingLastPathComponent().path
    guard lstat(path, &socketInfo) == 0, socketInfo.st_uid == getuid(),
          (socketInfo.st_mode & S_IFMT) == S_IFSOCK, (socketInfo.st_mode & 0o077) == 0,
          lstat(directory, &directoryInfo) == 0, directoryInfo.st_uid == getuid(),
          (directoryInfo.st_mode & S_IFMT) == S_IFDIR, (directoryInfo.st_mode & 0o077) == 0 else { return false }
    var address = sockaddr_un()
    let bytes = Array(path.utf8) + [UInt8(0)]
    guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { return false }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    address.sun_family = sa_family_t(AF_UNIX)
    withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { return false }
    var noSignal: Int32 = 1
    _ = setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else { Darwin.close(descriptor); return false }
    let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    transportInput = handle
    transportOutput = handle
    ipcToken = token
    usingSocketTransport = true
    return true
}

private func emit(_ message: [String: Any]) {
    guard JSONSerialization.isValidJSONObject(message),
          let data = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]) else { return }
    encoderLock.lock()
    defer { encoderLock.unlock() }
    do {
        var packet = data
        packet.append(10)
        try transportOutput.write(contentsOf: packet)
    } catch {
        DispatchQueue.main.async { NSApp?.terminate(nil) }
    }
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
    var lipSyncEnabled = true
    var voiceIdentifier = ""
    var voiceRate = Double(AVSpeechUtteranceDefaultSpeechRate)
    var speechLanguage = "zh-CN"
    var memoryEnabled = false
    var agentProgressEnabled = true
    var reduceMotion = false
    var dynamicSkinEnabled = true
    var growthPanelVisible = false
    var dailyTokenBudget = 0.0
    var dailyBudget = 0.0
    var inputPricePerMillion = 0.0
    var outputPricePerMillion = 0.0
    var mousePlayEnabled = false
    var mousePlayAfterMinutes = 20.0
    var pair: String { provider + "\u{001F}" + model }
    var active: Bool { observationEnabled && snoozeUntil <= nowMilliseconds() }
    var json: [String: Any] {
        ["observationEnabled": observationEnabled, "screenEnabled": screenEnabled,
         "captureIntervalSeconds": captureIntervalSeconds, "snoozeUntil": snoozeUntil,
         "provider": provider, "model": model, "consentPair": consentPair, "useDefaultModel": true,
         "videoAudioEnabled": videoAudioEnabled, "voiceEnabled": voiceEnabled, "lipSyncEnabled": lipSyncEnabled,
         "voiceIdentifier": voiceIdentifier, "voiceRate": voiceRate, "speechLanguage": speechLanguage,
         "memoryEnabled": memoryEnabled, "agentProgressEnabled": agentProgressEnabled,
         "reduceMotion": reduceMotion, "dailyTokenBudget": dailyTokenBudget, "dailyBudget": dailyBudget,
         "dynamicSkinEnabled": dynamicSkinEnabled, "growthPanelVisible": growthPanelVisible,
         "mousePlayEnabled": mousePlayEnabled, "mousePlayAfterMinutes": mousePlayAfterMinutes,
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
    var rendererView: NSView?
    override func draw(_ dirtyRect: NSRect) {
        // Keep image metadata/alpha for hit testing, but render only the mesh.
        if rendererView == nil { super.draw(dirtyRect) }
    }
    override func hitTest(_ point: NSPoint) -> NSView? {
        guard let candidate = super.hitTest(point) else { return nil }
        if let rendererView, candidate === rendererView || candidate.isDescendant(of: rendererView) { return self }
        return candidate
    }
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
            companion?.interact(at: local)
        }
    }
    override func rightMouseDown(with event: NSEvent) {
        guard let companion else { return }
        NSMenu.popUpContextMenu(companion.petMenu(), with: event, for: self)
    }
}

private final class CompanionApp: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTextViewDelegate {
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
    private var growthWindow: NSWindow?
    private var growthDetailLabel: NSTextField?
    private var growthBadge: CompanionGrowthBadge?
    private var snackOverflowLabel: NSTextField?
    private var growthState: [String: Any]?
    private var snackRecords: [String: [String: Any]] = [:]
    private var snackViews: [String: CompanionSnackView] = [:]
    private var eatingSnackViews: [String: CompanionSnackView] = [:]
    private var eatQueue: [(event: [String: Any], view: CompanionSnackView?, kind: String, startFrame: NSRect?)] = []
    private var foodAnimationRunning = false
    private var eatingAnimationTimer: Timer?
    private var eatingStarted = Date.distantPast
    private var eatingStartFrame = NSRect.zero
    private var currentEatingID: String?
    private var snackSlots: [String: Int] = [:]
    private var knownSnackIDs = Set<String>()
    private var knownSnackOrder: [String] = []
    private var snackArrivalCount = 0
    private var seenGrowthEvents = Set<String>()
    private var growthEventOrder: [String] = []
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
    private var lipSyncCheckbox: NSButton!
    private var voicePicker: NSPopUpButton!
    private var voiceRateSlider: NSSlider!
    private var memoryCheckbox: NSButton!
    private var agentCheckbox: NSButton!
    private var reduceMotionCheckbox: NSButton!
    private var dynamicSkinCheckbox: NSButton!
    private var growthPanelCheckbox: NSButton!
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
    private var lastNativeStatus: Data?
    private var permissionRequestInFlight = false
    private var permissionEpoch = 0
    private let permissionEpochLock = NSLock()
    private var mousePlayTimer: Timer?
    private var mouseGlobalMonitor: Any?
    private var mouseLocalMonitor: Any?
    private var mousePlayActive = false
    private var mousePlayConsent = false
    private var mouseStatus = "轻拉指针默认关闭；需要你明确同意及辅助功能授权。"
    private var lastMousePlayAt = Date.distantPast
    private var mousePlayStart = Date.distantPast
    private var mousePlayOrigin = CGPoint.zero
    private var mousePlayDestination = CGPoint.zero
    private var mouseLastTarget = CGPoint.zero
    private var memoryDirty = false
    private let audioTranscriber = SystemAudioTranscriber()
    private let speechPlayer = SpeechPCMPlayer()
    private var avatarRenderer: AvatarMeshRenderer?
    private var rendererHidden: Bool?
    private var rendererReduced: Bool?
    private var rendererMotion: Bool?
    private var previewTimeline: SpeechMouthTimeline?
    private var previewPCMActive = false
    private var lastExplicitWake = Date.distantPast
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
        settings.consentPair = previewMode ? "" : (defaults.string(forKey: "screenConsentPair") ?? "")
        audioConsentPair = previewMode ? "" : (defaults.string(forKey: "audioConsentPair") ?? "")
        mousePlayConsent = !previewMode && defaults.bool(forKey: "mousePlayConsent")
        configureSpeechPlayer()
        settings.dynamicSkinEnabled = defaults.object(forKey: "dynamicSkinEnabled") as? Bool ?? true
        voices = AVSpeechSynthesisVoice.speechVoices().sorted { ($0.language, $0.name) < ($1.language, $1.name) }
        makePanel()
        configureAnimation()
        makeStatusItem()
        showSpeech("右键打开陪伴设置，双击可以聊天。", mood: "idle", speak: false)
        animationTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in self?.animatePet() }
        passthroughTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.updateMousePassthrough() }
        readCommands()
        var ready: [String: Any] = ["type": "ready", "protocolVersion": 1, "preview": previewMode,
                                  "pid": ProcessInfo.processInfo.processIdentifier, "parentPid": getppid()]
        if let ipcToken { ready["ipcToken"] = ipcToken }
        emit(ready)
        emit(["type": "request-models"])
        publishNativeStatus()
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
        let renderer = AvatarMeshRenderer()
        avatarRenderer = renderer
        imageView.rendererView = renderer.view
        renderer.view.frame = imageView.bounds
        renderer.view.autoresizingMask = [.width, .height]
        imageView.addSubview(renderer.view)
        bubble = BubbleView(frame: .zero)
        sleepLabel = label("z Z", font: .systemFont(ofSize: 23, weight: .light))
        sleepLabel.textColor = .systemOrange
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
        clampPetToVisibleScreen()
        panel.orderFrontRegardless()
        refreshAvatarState()
    }

    private func layoutPet() {
        let placementScreen = screenForPet()
        panel.setContentSize(NSSize(width: (settings.growthPanelVisible ? 420 : 320) * scale, height: 400 * scale))
        let dynamic = settings.dynamicSkinEnabled && animationPlayer?.available == true
        imageView.frame = NSRect(x: (dynamic ? 20 : 55) * scale, y: 4 * scale,
                                width: (dynamic ? 280 : 210) * scale, height: 270 * scale)
        bubble.frame = NSRect(x: 6 * scale, y: 300 * scale, width: 308 * scale, height: 94 * scale)
        agentPill.frame = NSRect(x: 35 * scale, y: 275 * scale, width: 250 * scale, height: 22 * scale)
        bubble.text.font = .systemFont(ofSize: 14 * min(scale, 1.2), weight: .medium)
        sleepLabel.frame = NSRect(x: 250 * scale, y: 240 * scale, width: 65 * scale, height: 35 * scale)
        avatarRenderer?.view.frame = imageView.bounds
        layoutGrowthTray()
        stepSnackEating()
        refreshAvatarState()
        if panel.isVisible { clampPetToVisibleScreen(placementScreen) }
    }

    private func screenForPet() -> NSScreen? {
        guard panel != nil else { return NSScreen.main }
        let anchor = panel.convertPoint(toScreen: NSPoint(x: imageView.frame.midX, y: imageView.frame.midY))
        return NSScreen.screens.first { $0.frame.contains(anchor) }
            ?? NSScreen.screens.max { left, right in
                let a = left.visibleFrame.intersection(panel.frame), b = right.visibleFrame.intersection(panel.frame)
                return a.width * a.height < b.width * b.height
            } ?? NSScreen.main
    }

    /// Move only the minimum distance needed to keep the complete panel visible.
    /// In particular, collapsing the sidebar preserves the character's origin.
    private func clampPetToVisibleScreen(_ preferred: NSScreen? = nil) {
        guard panel != nil, let screen = preferred ?? screenForPet() else { return }
        let visible = screen.visibleFrame
        let old = panel.frame.origin
        let origin = NSPoint(x: min(max(old.x, visible.minX), max(visible.minX, visible.maxX - panel.frame.width)),
                             y: min(max(old.y, visible.minY), max(visible.minY, visible.maxY - panel.frame.height)))
        if abs(origin.x - old.x) > 0.1 || abs(origin.y - old.y) > 0.1 {
            panel.setFrameOrigin(origin)
            savePosition()
        }
    }

    private var panelWithinVisibleScreen: Bool {
        guard panel != nil else { return false }
        return NSScreen.screens.contains { $0.visibleFrame.insetBy(dx: -0.5, dy: -0.5).contains(panel.frame) }
    }

    func savePosition() {
        guard !previewMode else { return }
        defaults.set(panel.frame.origin.x, forKey: "petX")
        defaults.set(panel.frame.origin.y, forKey: "petY")
    }

    private func configureSpeechPlayer() {
        speechPlayer.onMouthLevel = { [weak self] level in self?.applyMouthLevel(level) }
        speechPlayer.onPlaybackState = { [weak self] playing in
            guard let self else { return }
            self.audioTranscriber.suppressAudio = playing
            self.animationPlayer?.setSpeaking(playing)
            self.refreshAvatarState()
            self.publishNativeStatus()
        }
        speechPlayer.onError = { [weak self] message in
            guard let self else { return }
            self.modelStatus = message
            self.refreshSettingsUI()
        }
    }

    private func applyMouthLevel(_ value: Double) {
        let allowed = settings.lipSyncEnabled && !settings.reduceMotion && panel?.isVisible == true
        avatarRenderer?.setMouthLevel(allowed ? value : 0)
    }

    private func stopSpokenText() {
        previewTimeline = nil
        previewPCMActive = false
        speechPlayer.stop()
        audioTranscriber.suppressAudio = false
        animationPlayer?.setSpeaking(false)
        avatarRenderer?.setMouthLevel(0)
    }

    private func refreshAvatarState() {
        guard let renderer = avatarRenderer else { return }
        let hidden = panel?.isVisible != true
        let reduced = settings.reduceMotion
        let motion = settings.dynamicSkinEnabled && animationPlayer?.available == true
        if rendererHidden != hidden { renderer.setHidden(hidden); rendererHidden = hidden }
        if rendererReduced != reduced { renderer.setReducedMotion(reduced); rendererReduced = reduced }
        if rendererMotion != motion { renderer.setMotionEnabled(motion); rendererMotion = motion }
        renderer.setAction(animationPlayer?.currentClip ?? "idle")
        if hidden || reduced || !settings.lipSyncEnabled { renderer.setMouthLevel(0) }
    }

    private func displayPetImage(_ image: NSImage, mouthRect: [Double]?) {
        imageView.image = image
        imageView.contentTintColor = nil
        if let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) {
            petBitmap = NSBitmapImageRep(cgImage: cg)
        } else { petBitmap = nil }
        avatarRenderer?.setImage(image, geometry: AvatarMeshGeometry(mouthRect: mouthRect))
        refreshAvatarState()
    }

    private func updateImage() {
        guard let animationPlayer, animationPlayer.available else {
            if let fallback = NSImage(systemSymbolName: "sun.max.fill", accessibilityDescription: "陪伴角色") {
                displayPetImage(fallback, mouthRect: nil)
            }
            return
        }
        animationPlayer.mood(currentMood)
        if settings.dynamicSkinEnabled { return }
        let name = currentMood == "shy" ? "shy" : "idle"
        if let image = NSImage(contentsOf: assetsDirectory.appendingPathComponent(name + ".png")) {
            displayPetImage(image, mouthRect: animationPlayer.staticMouthRect(name))
        } else if let fallback = NSImage(systemSymbolName: "sun.max.fill", accessibilityDescription: "陪伴角色") {
            displayPetImage(fallback, mouthRect: nil)
        }
    }

    private func configureAnimation() {
        animationPlayer?.stop()
        let player = PetAnimationPlayer(root: assetsDirectory) { [weak self] frame in
            guard let self, self.settings.dynamicSkinEnabled else { return }
            self.displayPetImage(frame, mouthRect: self.animationPlayer?.currentMouthRect)
        }
        animationPlayer = player
        player.setReducedMotion(settings.reduceMotion || !settings.dynamicSkinEnabled)
        player.setState(activeAgentPhase, activity: activeAgentActivity)
        player.setThinking(modelPending)
        player.setSleeping(sleeping)
        player.setSpeaking(speechPlayer.isPlaying || previewPCMActive)
        player.mood(currentMood)
        if panel?.isVisible == true { player.resume() } else { player.stop() }
        if !settings.dynamicSkinEnabled || !player.available { updateImage() }
        layoutPet()
    }

    /// Actual aspect-fit image bounds; coordinates here use AppKit's bottom-left origin.
    private var drawnImageRect: NSRect {
        guard let image = imageView.image, image.size.width > 0, image.size.height > 0 else { return .zero }
        let fit = min(imageView.bounds.width / image.size.width, imageView.bounds.height / image.size.height)
        let size = NSSize(width: image.size.width * fit, height: image.size.height * fit)
        return NSRect(x: (imageView.bounds.width - size.width) / 2,
                      y: (imageView.bounds.height - size.height) / 2, width: size.width, height: size.height)
    }

    private func normalizedImagePoint(_ point: NSPoint) -> CGPoint? {
        if let renderer = avatarRenderer {
            return renderer.inverseNormalizedPoint(viewPoint: renderer.view.convert(point, from: imageView))
        }
        let rect = drawnImageRect
        guard rect.width > 0, rect.height > 0, rect.contains(point) else { return nil }
        return CGPoint(x: (point.x - rect.minX) / rect.width, y: 1 - (point.y - rect.minY) / rect.height)
    }

    func interact(at point: NSPoint) {
        guard let normalized = normalizedImagePoint(point) else { return }
        interact(animationPlayer?.interactionRegion(at: normalized) ?? (normalized.y < 0.32 ? "head" : (normalized.y >= 0.63 ? "skirt" : "body")))
    }

    private func animatePet() { sleepLabel.isHidden = !sleeping }

    func interact(_ input: String) {
        let kind = input == "tail" ? "skirt" : input
        if kind == "sleep" { forcedSleep = true; sleeping = true; stopSpokenText() }
        else if kind == "wake" { forcedSleep = false; sleeping = false; lastExplicitWake = Date() }
        // Touching or finishing a drag never implicitly cancels persistent sleep.
        sleepLabel.isHidden = !sleeping
        if ["head", "body", "feed"].contains(kind) { currentMood = "shy" }
        animationPlayer?.setSleeping(sleeping)
        animationPlayer?.interaction(kind)
        updateImage()
        refreshAvatarState()
        publishNativeStatus()
        if !previewMode { emit(["type": "interaction", "kind": kind, "timestamp": nowMilliseconds()]) }
    }

    private func showSpeech(_ text: String, mood: String, speak: Bool = true) {
        stopSpokenText()
        currentMood = ["idle", "shy", "concern", "tease", "happy", "success", "error", "thinking", "sleep", "sleepy"].contains(mood) ? mood : "idle"
        updateImage()
        bubble.text.stringValue = String(text.prefix(260))
        bubble.isHidden = false
        chatReply?.stringValue = String(text.prefix(1200))
        if speak, settings.voiceEnabled, !previewMode, panel.isVisible, !text.isEmpty {
            speechPlayer.start(text: String(text.prefix(2000)), voiceIdentifier: settings.voiceIdentifier, rate: Float(settings.voiceRate))
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
        statusItem.button?.image = NSImage(systemSymbolName: "sun.max", accessibilityDescription: "安静陪伴")
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
            ("成长与零食…", #selector(showGrowth)),
            (settings.growthPanelVisible ? "隐藏成长状态栏" : "显示成长状态栏", #selector(toggleGrowthPanel)),
            ("退出宠物", #selector(quitPet))]
        for (title, action) in entries {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        return menu
    }

    @objc private func togglePet() { setPetVisible(!panel.isVisible) }
    private func setPetVisible(_ visible: Bool) {
        if visible { panel.orderFrontRegardless(); animationPlayer?.resume() }
        else { stopSpokenText(); panel.orderOut(nil); animationPlayer?.stop() }
        refreshAvatarState()
        publishNativeStatus()
    }
    @objc private func openChat() { showChat() }
    @objc private func openSettings() { showSettings() }
    @objc private func quitPet() {
        emit(["type": "quit"])
        shutdown()
    }
    @objc private func pauseObservation() {
        settings.observationEnabled = false
        stopSpokenText()
        settingsChanged()
        showSpeech("观察已暂停", mood: "idle", speak: false)
    }
    @objc private func snooze() {
        settings.snoozeUntil = nowMilliseconds() + 30 * 60 * 1000
        stopSpokenText()
        settingsChanged()
        showSpeech("已安静 30 分钟，期间不读取应用、屏幕或系统声音", mood: "idle", speak: false)
    }
    @objc private func resumeObservation() {
        settings.observationEnabled = true
        settings.snoozeUntil = 0
        settingsChanged()
        showSpeech("已恢复陪伴", mood: "idle", speak: false)
    }
    @objc private func feedPet() { offerSnack(nil) }
    @objc private func toggleGrowthPanel() {
        setGrowthPanelVisible(!settings.growthPanelVisible, notifyHost: true)
    }
    @objc private func growthPanelToggled() {
        setGrowthPanelVisible(growthPanelCheckbox.state == .on, notifyHost: true)
    }
    private func setGrowthPanelVisible(_ visible: Bool, notifyHost: Bool) {
        settings.growthPanelVisible = visible
        layoutPet()
        statusItem?.menu = petMenu()
        refreshSettingsUI()
        // This local appearance change must preserve every Host growth setting.
        if notifyHost { emit(["type": "settings", "growthPanelVisible": visible]) }
    }
    @objc private func sleepPet() { interact("sleep") }
    @objc private func wakePet() { interact("wake") }
    @objc private func toggleVoice() {
        settings.voiceEnabled.toggle()
        if !settings.voiceEnabled { stopSpokenText() }
        settingsChanged()
    }

    func dragBegan() {
        stopSpokenText()
        isDragging = true
        panel.ignoresMouseEvents = false
        bubble.isHidden = true
        animationPlayer?.interaction("drag-hold")
        refreshAvatarState()
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
        var imageHit = false
        if let normalized = normalizedImagePoint(imagePoint), let bitmap = petBitmap {
            let px = min(bitmap.pixelsWide - 1, max(0, Int(normalized.x * Double(bitmap.pixelsWide))))
            let py = min(bitmap.pixelsHigh - 1, max(0, Int(normalized.y * Double(bitmap.pixelsHigh))))
            imageHit = (bitmap.colorAt(x: px, y: py)?.alphaComponent ?? 1) > 0.08
        }
        let foodHit = snackViews.values.contains { view in
            view.canOffer && view.containsVisibleFood(view.convert(point, from: panel.contentView))
        }
        let growthHit = growthBadge.map { !$0.isHidden && $0.frame.contains(point) } ?? false
        panel.ignoresMouseEvents = !(bubbleHit || imageHit || foodHit || growthHit)
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
        _ = put(general, "单击头／身体／裙摆可互动；双击聊天；拖动后可吸附边缘。隐藏后可从菜单栏找回。", 24, 48)

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
        lipSyncCheckbox = check(voiceView, "本机朗读时按真实PCM声音开合嘴部（RMS）", 522, #selector(lipSyncToggled))
        voicePicker = NSPopUpButton(frame: NSRect(x: 24, y: 479, width: 574, height: 32), pullsDown: false)
        voices = AVSpeechSynthesisVoice.speechVoices().sorted { ($0.language, $0.name) < ($1.language, $1.name) }
        voicePicker.addItems(withTitles: ["系统默认中文声音"] + voices.map { "\($0.name) · \($0.language)" })
        voicePicker.target = self
        voicePicker.action = #selector(voiceSelected)
        voiceView.addSubview(voicePicker)
        _ = put(voiceView, "语速", 438, 25)
        voiceRateSlider = NSSlider(value: settings.voiceRate, minValue: 0.3, maxValue: 0.65, target: self, action: #selector(voiceRateChanged))
        voiceRateSlider.frame = NSRect(x: 124, y: 434, width: 474, height: 28)
        voiceView.addSubview(voiceRateSlider)
        voiceView.addSubview(button("试听当前声音", action: #selector(testVoice), frame: NSRect(x: 24, y: 384, width: 574, height: 34)))
        _ = put(voiceView, "宠物大小", 329, 25)
        scaleSlider = NSSlider(value: scale, minValue: 0.6, maxValue: 1.6, target: self, action: #selector(scaleChanged))
        scaleSlider.frame = NSRect(x: 124, y: 325, width: 474, height: 28)
        voiceView.addSubview(scaleSlider)
        _ = put(voiceView, "透明度", 279, 25)
        opacitySlider = NSSlider(value: opacity, minValue: 0.45, maxValue: 1, target: self, action: #selector(opacityChanged))
        opacitySlider.frame = NSRect(x: 124, y: 275, width: 474, height: 28)
        voiceView.addSubview(opacitySlider)
        reduceMotionCheckbox = check(voiceView, "减少动态效果", 239, #selector(reduceMotionToggled))
        dynamicSkinCheckbox = check(voiceView, "使用动态角色（取消后使用参考立绘）", 204, #selector(dynamicSkinToggled))
        voiceView.addSubview(button("喂点零食", action: #selector(feedPet), frame: NSRect(x: 24, y: 169, width: 175, height: 34)))
        voiceView.addSubview(button("休息", action: #selector(sleepPet), frame: NSRect(x: 221, y: 169, width: 178, height: 34)))
        voiceView.addSubview(button("叫醒她", action: #selector(wakePet), frame: NSRect(x: 421, y: 169, width: 177, height: 34)))
        growthPanelCheckbox = check(voiceView, "显示角色右侧成长状态栏（隐藏不影响成长）", 128, #selector(growthPanelToggled))
        _ = put(voiceView, "动态角色和参考立绘都可以摸头、戳身体、轻碰裙摆、喂食和拖动。互动话语由当前默认模型结合情境生成。", 35, 76)

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
        publishNativeStatus()
        guard settingsWindow != nil else { return }
        observeCheckbox.state = settings.observationEnabled ? .on : .off
        growthPanelCheckbox.state = settings.growthPanelVisible ? .on : .off
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
        lipSyncCheckbox.state = settings.lipSyncEnabled ? .on : .off
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

    private func speechPermissionRequestIsSafe() -> Bool {
        guard usingSocketTransport,
              let purpose = Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") as? String else { return false }
        return !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func previewPCM(_ payload: [String: Any]) {
        guard previewMode else { return }
        let rate = 24000.0
        if previewTimeline == nil {
            var samples = [Float](repeating: 0, count: 1920)
            samples += (0..<5760).map { Float(0.2 * sin(2 * .pi * 440 * Double($0) / rate)) }
            samples += [Float](repeating: 0, count: 4800)
            var accumulator = SpeechRMSAccumulator(sampleRate: rate)
            var windows = samples.withUnsafeBufferPointer { accumulator.consume($0, at: 0) }
            windows += accumulator.finish()
            var timeline = SpeechMouthTimeline(); timeline.append(windows); previewTimeline = timeline
        }
        let requested = (payload["sampleFrame"] as? NSNumber)?.int64Value ?? 0
        let frame = min(120000, max(0, requested))
        previewPCMActive = frame < 12480
        animationPlayer?.setSpeaking(previewPCMActive)
        let position = SpeechPCMClock.frame(sampleTime: frame, playerRate: rate, sourceRate: rate, presentationLatency: 0) ?? 0
        applyMouthLevel(previewTimeline?.level(at: position, sampleRate: rate) ?? 0)
        refreshAvatarState()
        publishNativeStatus(force: true)
    }

    private func publishNativeStatus(force: Bool = false) {
        let screenAuthorized = !previewMode && CGPreflightScreenCaptureAccess()
        let audioAuthorized = !previewMode && speechPermissionRequestIsSafe() && screenAuthorized
            && SFSpeechRecognizer.authorizationStatus() == .authorized
        let mesh = avatarRenderer?.diagnostics ?? [:]
        let metricKeys = ["targetFPS", "sceneFrameCount", "warpFrameCount", "mouthFrameCount", "mouthVisible", "mouthGeometryValid", "skinSampleValid", "maximumNormalizedDisplacement", "textureCacheEntries"]
        let metrics = mesh.filter { metricKeys.contains($0.key) }
        let mode = panel?.isVisible != true ? "hidden" : (settings.reduceMotion ? "reduced-motion" : (settings.dynamicSkinEnabled ? "native-mesh" : "still-image"))
        let message: [String: Any] = [
            "type": "native-status", "audioStatus": audioStatus, "modelStatus": modelStatus,
            "screenAuthorized": screenAuthorized, "audioAuthorized": audioAuthorized,
            "helperVersion": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
            "observationEnabled": settings.observationEnabled, "screenEnabled": settings.screenEnabled,
            "audioEnabled": settings.videoAudioEnabled, "usingSocketTransport": usingSocketTransport,
            "preview": previewMode, "scale": scale, "opacity": opacity,
            "permissionRequestInFlight": permissionRequestInFlight,
            "mouseAuthorized": !previewMode && AXIsProcessTrusted(), "mousePlayActive": mousePlayActive,
            "mouseStatus": mouseStatus,
            "petSleeping": sleeping,
            "motionMode": mode, "currentClip": animationPlayer?.currentClip ?? "idle",
            "actualMouthLevel": mesh["mouthLevel"] ?? 0, "speechPlaying": speechPlayer.isPlaying,
            "source": "pcm-rms", "previewPCMActive": previewPCMActive,
            "lipSyncEnabled": settings.lipSyncEnabled, "frameMetrics": metrics,
            "growthPanelVisible": settings.growthPanelVisible,
            "growthBadgeVisible": growthBadge.map { !$0.isHidden } ?? false,
            "inventoryLabelVisible": snackOverflowLabel.map { !$0.isHidden } ?? false,
            "petPanelWidth": panel == nil ? 320 : panel.frame.width / scale,
            "panelWithinVisibleScreen": panelWithinVisibleScreen,
            "snackLayout": "around-character", "snackArrivalCount": snackArrivalCount,
            "snackEatingActive": foodAnimationRunning,
            "snackPositions": snackViews.keys.sorted().compactMap { id -> [String: Any]? in
                guard let view = snackViews[id], let slot = snackSlots[id] else { return nil }
                let rect = view.restingFrame
                return ["id": id, "slot": slot, "x": rect.minX / scale, "y": rect.minY / scale,
                        "width": rect.width / scale, "height": rect.height / scale]
            },
            "voices": voices.map { ["id": $0.identifier, "name": $0.name, "language": $0.language] }]
        guard let fingerprint = try? JSONSerialization.data(withJSONObject: message, options: [.sortedKeys]), (force || fingerprint != lastNativeStatus) else { return }
        lastNativeStatus = fingerprint
        emit(message)
    }

    private func prepareSettingsControls() {
        if settingsWindow == nil { makeSettingsWindow() }
        refreshSettingsUI()
    }

    private func invalidatePendingPermissions() {
        permissionEpochLock.withLock { permissionEpoch &+= 1 }
    }

    private func currentPermissionEpoch() -> Int { permissionEpochLock.withLock { permissionEpoch } }

    private func permissionContextIsCurrent(_ pair: String, epoch: Int) -> Bool {
        !isShuttingDown && settings.pair == pair && currentPermissionEpoch() == epoch
    }

    private func handleControl(_ action: String, payload: [String: Any] = [:]) {
        if action != "mouse-play" && action != "refresh-status" { stopMousePlay("用户正在操作，指针互动已停止。") }
        switch action {
        case "enable-screen":
            prepareSettingsControls()
            screenCheckbox.state = .on
            screenToggled()
        case "disable-screen":
            settings.screenEnabled = false
            settings.consentPair = ""
            if !previewMode { defaults.removeObject(forKey: "screenConsentPair") }
            settingsChanged()
        case "enable-system-audio":
            prepareSettingsControls()
            audioCheckbox.state = .on
            audioToggled()
        case "disable-system-audio":
            settings.videoAudioEnabled = false
            audioConsentPair = ""
            if !previewMode { defaults.removeObject(forKey: "audioConsentPair") }
            audioStatus = "系统声音理解已关闭。"
            settingsChanged()
        case "pause": pauseObservation()
        case "resume": resumeObservation()
        case "snooze": snooze()
        case "show": setPetVisible(true)
        case "hide": setPetVisible(false)
        case "chat": showChat()
        case "feed": feedPet()
        case "sleep": sleepPet()
        case "wake": wakePet()
        case "open-settings": showSettings()
        case "toggle-growth-panel": toggleGrowthPanel()
        case "preview-place-at-right-edge":
            // Deterministic regression placement of this owned test panel only.
            if previewMode, let screen = screenForPet() {
                panel.setFrameOrigin(NSPoint(x: screen.visibleFrame.maxX - panel.frame.width - 24,
                                             y: screen.visibleFrame.minY + 20))
                publishNativeStatus()
            }
        case "set-appearance":
            if let value = payload["scale"] as? Double, value.isFinite { scale = min(1.6, max(0.6, value)) }
            if let value = payload["opacity"] as? Double, value.isFinite { opacity = min(1, max(0.45, value)) }
            if !previewMode {
                defaults.set(scale, forKey: "petScale")
                defaults.set(opacity, forKey: "petOpacity")
            }
            panel.alphaValue = opacity
            layoutPet()
            scaleSlider?.doubleValue = scale
            opacitySlider?.doubleValue = opacity
            refreshSettingsUI()
        case "refresh-status": publishNativeStatus(force: true)
        case "preview-pcm": previewPCM(payload)
        case "preview-pcm-stop": if previewMode { stopSpokenText(); publishNativeStatus(force: true) }
        case "preview-action":
            if previewMode, let name = payload["name"] as? String, MotionAction(rawValue: name) != nil {
                animationPlayer?.interaction(name); refreshAvatarState(); publishNativeStatus(force: true)
            }
        case "preview-reset-motion": if previewMode { stopSpokenText(); configureAnimation(); publishNativeStatus(force: true) }
        case "enable-mouse-play": enableMousePlay()
        case "mouse-play": startMousePlay()
        default: break
        }
    }

    private func enableMousePlay() {
        guard !previewMode else {
            mouseStatus = "预览：不会申请辅助功能权限或开启真实指针互动。"
            publishNativeStatus()
            return
        }
        guard usingSocketTransport, !permissionRequestInFlight else {
            mouseStatus = "请等待已有授权完成，并从更新后的 Harness 插件开启。"
            publishNativeStatus()
            return
        }
        permissionRequestInFlight = true
        let epoch = currentPermissionEpoch()
        let pair = settings.pair
        defer { permissionRequestInFlight = false; publishNativeStatus() }
        let alert = NSAlert()
        alert.messageText = "允许她偶尔轻拉一下指针吗？"
        alert.informativeText = "只有你长时间没和宠物互动时才可能触发，默认至少间隔 30 分钟。每次最多 1.5 秒、轻拉不超过 160 像素；你真实移动鼠标、按键或按 Esc 时立即停止。\n\n不会点击、发送按键或持续拖拽；按住鼠标、菜单操作、系统授权、密码输入或会议应用期间不执行。此功能需要 macOS 辅助功能权限；该权限本身较广，但本插件仅按以上范围调整指针。授权后如未自动开启，请重新点击开启。"
        alert.addButton(withTitle: "同意并检查辅助功能授权")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn, permissionContextIsCurrent(pair, epoch: epoch) else { return }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        guard AXIsProcessTrustedWithOptions(options), permissionContextIsCurrent(pair, epoch: epoch) else {
            mouseStatus = "尚未获得辅助功能授权。请在系统设置中允许“安静陪伴”，然后重新点击开启。"
            return
        }
        mousePlayConsent = true
        defaults.set(true, forKey: "mousePlayConsent")
        settings.mousePlayEnabled = true
        mouseStatus = "轻拉指针已开启；真实鼠标移动、按键或 Esc 都会立即停止。"
        settingsChanged()
    }

    private func pointerContextIsSafe(checkAccessibility: Bool) -> Bool {
        guard settings.active, settings.mousePlayEnabled, mousePlayConsent, panel.isVisible,
              !isDragging, !permissionRequestInFlight, NSApp.modalWindow == nil,
              NSEvent.pressedMouseButtons == 0, !IsSecureEventInputEnabled(), AXIsProcessTrusted() else { return false }
        guard NSEvent.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty else { return false }
        let identifier = NSWorkspace.shared.frontmostApplication?.bundleIdentifier?.lowercased() ?? ""
        let excluded = ["securityagent", "loginwindow", "systempreferences", "systemsettings", "keychain", "authorizationhost",
                        "1password", "bitwarden", "keepass", "zoom", "teams", "meeting", "facetime", "wemeet", "wecom"]
        guard !excluded.contains(where: { identifier.contains($0) }) else { return false }
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
        guard idle.isFinite, idle <= 90 else { return false }
        if checkAccessibility {
            let system = AXUIElementCreateSystemWide()
            AXUIElementSetMessagingTimeout(system, 0.04)
            var focused: CFTypeRef?
            if AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
               let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() {
                let element = unsafeBitCast(focused, to: AXUIElement.self)
                AXUIElementSetMessagingTimeout(element, 0.04)
                var role: CFTypeRef?
                if AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role) == .success,
                   let role = role as? String, ["AXMenu", "AXMenuItem", "AXMenuBarItem", "AXSecureTextField"].contains(role) { return false }
            }
            var application: CFTypeRef?
            if AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &application) == .success,
               let application, CFGetTypeID(application) == AXUIElementGetTypeID() {
                let element = unsafeBitCast(application, to: AXUIElement.self)
                AXUIElementSetMessagingTimeout(element, 0.04)
                var window: CFTypeRef?
                if AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &window) == .success,
                   let window, CFGetTypeID(window) == AXUIElementGetTypeID() {
                    let windowElement = unsafeBitCast(window, to: AXUIElement.self)
                    AXUIElementSetMessagingTimeout(windowElement, 0.04)
                    var subrole: CFTypeRef?
                    if AXUIElementCopyAttributeValue(windowElement, kAXSubroleAttribute as CFString, &subrole) == .success,
                       let subrole = subrole as? String, ["AXDialog", "AXSystemDialog"].contains(subrole) { return false }
                }
            }
        }
        return true
    }

    private func stopMousePlay(_ reason: String) {
        mousePlayTimer?.invalidate()
        mousePlayTimer = nil
        if let mouseGlobalMonitor { NSEvent.removeMonitor(mouseGlobalMonitor) }
        if let mouseLocalMonitor { NSEvent.removeMonitor(mouseLocalMonitor) }
        mouseGlobalMonitor = nil
        mouseLocalMonitor = nil
        let wasActive = mousePlayActive
        mousePlayActive = false
        if wasActive { mouseStatus = reason; publishNativeStatus() }
    }

    private func startMousePlay() {
        guard !previewMode else {
            animationPlayer?.interaction("poke")
            mouseStatus = "预览：仅模拟宠物动作，没有移动真实指针。"
            publishNativeStatus()
            return
        }
        guard !mousePlayActive, Date().timeIntervalSince(lastMousePlayAt) >= 30 * 60,
              pointerContextIsSafe(checkAccessibility: true), let position = CGEvent(source: nil)?.location else { return }
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown,
                                           .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .keyDown, .scrollWheel]
        // CGWarpMouseCursorPosition does not generate events (CGRemoteOperation.h).
        // Any monitored user event therefore cancels, and no event is swallowed.
        mouseGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: mask) { [weak self] _ in
            self?.stopMousePlay("用户已接管，指针互动已立即停止。")
        }
        mouseLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: mask) { [weak self] event in
            self?.stopMousePlay("用户已接管，指针互动已立即停止。")
            return event
        }
        guard mouseGlobalMonitor != nil, mouseLocalMonitor != nil else {
            stopMousePlay("无法可靠监听退出信号，未执行指针互动。")
            mouseStatus = "无法可靠监听退出信号，未执行指针互动。"
            publishNativeStatus()
            return
        }
        let near = panel.convertPoint(toScreen: NSPoint(x: imageView.frame.minX + 15, y: imageView.frame.midY))
        let mainHeight = NSScreen.screens.first?.frame.maxY ?? CGDisplayBounds(CGMainDisplayID()).height
        let desired = CGPoint(x: near.x, y: mainHeight - near.y)
        let distance = hypot(desired.x - position.x, desired.y - position.y)
        let fraction = distance > 160 ? 160 / distance : 1
        mousePlayOrigin = position
        mouseLastTarget = position
        mousePlayDestination = CGPoint(x: position.x + (desired.x - position.x) * fraction,
                                       y: position.y + (desired.y - position.y) * fraction)
        mousePlayStart = Date()
        lastMousePlayAt = Date()
        mousePlayActive = true
        mouseStatus = "正在轻拉指针；移动鼠标、按键或 Esc 可立即停止。"
        animationPlayer?.interaction("poke")
        publishNativeStatus()
        mousePlayTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            let elapsed = Date().timeIntervalSince(self.mousePlayStart)
            guard elapsed < 1.2, self.pointerContextIsSafe(checkAccessibility: false),
                  let current = CGEvent(source: nil)?.location else {
                self.stopMousePlay("指针互动已结束。")
                return
            }
            guard hypot(current.x - self.mouseLastTarget.x, current.y - self.mouseLastTarget.y) <= 1.5 else {
                self.stopMousePlay("用户已接管，指针互动已立即停止。")
                return
            }
            let progress = min(1, elapsed / 1.2)
            let eased = progress * progress * (3 - 2 * progress)
            let next = CGPoint(x: self.mousePlayOrigin.x + (self.mousePlayDestination.x - self.mousePlayOrigin.x) * eased,
                               y: self.mousePlayOrigin.y + (self.mousePlayDestination.y - self.mousePlayOrigin.y) * eased)
            guard Date().timeIntervalSince(self.mousePlayStart) < 1.5 else { self.stopMousePlay("指针互动已结束。"); return }
            guard CGWarpMouseCursorPosition(next) == .success else { self.stopMousePlay("系统未允许调整指针，互动已停止。"); return }
            self.mouseLastTarget = next
        }
    }

    @objc private func observeToggled() {
        settings.observationEnabled = observeCheckbox.state == .on
        settingsChanged()
    }
    @objc private func screenToggled() {
        if screenCheckbox.state == .off {
            settings.screenEnabled = false
            settings.consentPair = ""
            if !previewMode { defaults.removeObject(forKey: "screenConsentPair") }
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
        guard !permissionRequestInFlight else {
            modelStatus = "已有权限请求正在等待处理，请先完成或取消。"
            refreshSettingsUI()
            return
        }
        permissionRequestInFlight = true
        let requestPair = settings.pair
        let requestEpoch = currentPermissionEpoch()
        modelStatus = "正在等待屏幕理解确认及系统授权。"
        refreshSettingsUI()
        defer { permissionRequestInFlight = false; refreshSettingsUI() }
        let alert = NSAlert()
        alert.messageText = "允许她理解当前应用的画面吗？"
        alert.informativeText = "当前默认模型服务：\(settings.provider) / \(settings.model)。\n\n优先当前应用窗口，无法定位窗口时采样显示器并排除宠物。画面可能包含私人聊天、文档和账号信息。普通帧只在内存中比较；需要模型理解的关键帧会按 Harness 附件机制保存在本机并发送给该模型服务。不会保存屏幕视频。暂停观察或关闭此开关会停止采集，更换默认模型后需要重新同意。"
        alert.addButton(withTitle: "同意并开启画面理解")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { refreshSettingsUI(); return }
        guard permissionContextIsCurrent(requestPair, epoch: requestEpoch) else {
            modelStatus = "设置已改变，本次屏幕授权已取消，请重新开启。"
            return
        }
        if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
        guard permissionContextIsCurrent(requestPair, epoch: requestEpoch) else {
            modelStatus = "设置已改变，本次屏幕授权未启用，请重新开启。"
            return
        }
        guard CGPreflightScreenCaptureAccess() else {
            modelStatus = "尚未获得屏幕录制权限。请在系统设置中授权“安静陪伴”，然后重新开启。"
            refreshSettingsUI()
            return
        }
        settings.screenEnabled = true
        settings.consentPair = requestPair
        defaults.set(settings.consentPair, forKey: "screenConsentPair")
        settingsChanged(screenConsent: true)
    }

    @objc private func audioToggled() {
        if audioCheckbox.state == .off {
            settings.videoAudioEnabled = false
            audioConsentPair = ""
            if !previewMode { defaults.removeObject(forKey: "audioConsentPair") }
            settingsChanged()
            return
        }
        settings.videoAudioEnabled = false
        guard !previewMode else { audioStatus = "界面预览不捕获声音或申请权限。"; refreshSettingsUI(); return }
        guard speechPermissionRequestIsSafe() else {
            audioStatus = "当前启动方式不支持独立语音授权，已阻止请求以避免 macOS 强制退出。请更新插件并从 Harness 重新启动宠物。"
            refreshSettingsUI()
            return
        }
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
        guard !permissionRequestInFlight else {
            audioStatus = "已有权限请求正在等待处理，请先完成或取消。"
            refreshSettingsUI()
            return
        }
        permissionRequestInFlight = true
        let requestPair = settings.pair
        let requestEpoch = currentPermissionEpoch()
        audioStatus = "正在等待系统声音确认及语音识别授权。"
        refreshSettingsUI()
        let alert = NSAlert()
        alert.messageText = "允许理解正在播放的系统声音吗？"
        alert.informativeText = "只捕获系统播放的声音，不使用麦克风，也不保存录音。本机离线语音识别会把声音转成文字，识别结果将发送给当前默认模型：\(settings.provider) / \(settings.model)。\n\n系统声音可能包含会议、聊天或其他私人内容。开启需要 macOS 屏幕／系统声音录制权限及语音识别权限。只有本机支持离线识别时才工作，不回退到 Apple 的网络识别。"
        alert.addButton(withTitle: "同意并开启系统声音理解")
        alert.addButton(withTitle: "取消")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else {
            permissionRequestInFlight = false
            refreshSettingsUI()
            return
        }
        guard permissionContextIsCurrent(requestPair, epoch: requestEpoch) else {
            permissionRequestInFlight = false
            audioStatus = "设置已改变，本次声音授权已取消，请重新开启。"
            refreshSettingsUI()
            return
        }
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                defer { self.permissionRequestInFlight = false; self.refreshSettingsUI() }
                guard self.permissionContextIsCurrent(requestPair, epoch: requestEpoch) else {
                    self.audioStatus = "设置已改变，本次声音授权未启用，请重新开启。"
                    return
                }
                guard status == .authorized else {
                    self.audioStatus = "未获语音识别权限，系统声音理解保持关闭。"
                    self.refreshSettingsUI()
                    return
                }
                if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
                guard self.permissionContextIsCurrent(requestPair, epoch: requestEpoch) else {
                    self.audioStatus = "设置已改变，本次声音授权未启用，请重新开启。"
                    return
                }
                guard CGPreflightScreenCaptureAccess() else {
                    self.audioStatus = "未获屏幕／系统声音录制权限。请在系统设置授权后重新开启。"
                    self.refreshSettingsUI()
                    return
                }
                self.settings.videoAudioEnabled = true
                self.audioConsentPair = requestPair
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
        if !settings.voiceEnabled { stopSpokenText() }
        settingsChanged()
    }
    @objc private func lipSyncToggled() {
        settings.lipSyncEnabled = lipSyncCheckbox.state == .on
        if !settings.lipSyncEnabled { avatarRenderer?.setMouthLevel(0) }
        settingsChanged()
    }
    @objc private func voiceSelected() {
        stopSpokenText()
        let index = voicePicker.indexOfSelectedItem - 1
        settings.voiceIdentifier = voices.indices.contains(index) ? voices[index].identifier : ""
        settingsChanged()
    }
    @objc private func voiceRateChanged() { stopSpokenText(); settings.voiceRate = voiceRateSlider.doubleValue; settingsChanged() }
    @objc private func testVoice() {
        guard !previewMode else { return }
        stopSpokenText()
        speechPlayer.start(text: "这是当前系统声音的试听。", voiceIdentifier: settings.voiceIdentifier, rate: Float(settings.voiceRate))
    }
    @objc private func memoryToggled() { settings.memoryEnabled = memoryCheckbox.state == .on; settingsChanged() }
    @objc private func agentToggled() { settings.agentProgressEnabled = agentCheckbox.state == .on; settingsChanged() }
    @objc private func reduceMotionToggled() {
        settings.reduceMotion = reduceMotionCheckbox.state == .on
        animationPlayer?.setReducedMotion(settings.reduceMotion || !settings.dynamicSkinEnabled)
        settingsChanged()
    }
    @objc private func dynamicSkinToggled() {
        settings.dynamicSkinEnabled = dynamicSkinCheckbox.state == .on
        if !previewMode { defaults.set(settings.dynamicSkinEnabled, forKey: "dynamicSkinEnabled") }
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
        let wanted = !previewMode && speechPermissionRequestIsSafe() && settings.active && settings.videoAudioEnabled
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
        if !previewMode { defaults.set(scale, forKey: "petScale") }
        layoutPet()
        savePosition()
    }
    @objc private func opacityChanged() {
        opacity = opacitySlider.doubleValue
        if !previewMode { defaults.set(opacity, forKey: "petOpacity") }
        panel.alphaValue = opacity
    }

    private func settingsChanged(screenConsent: Bool = false, audioConsent: Bool = false) {
        stopMousePlay("设置已改变，指针互动已停止。")
        invalidatePendingPermissions()
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
        stopMousePlay("正在聊天，指针互动已停止。")
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
        let nextSleeping = forcedSleep || (idle.isFinite && idle >= 300 && Date().timeIntervalSince(lastExplicitWake) >= 300)
        if sleeping != nextSleeping {
            sleeping = nextSleeping
            animationPlayer?.setSleeping(sleeping)
            if !sleeping { animationPlayer?.interaction("wake") }
            publishNativeStatus()
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
                let chunk = transportInput.availableData
                if chunk.isEmpty {
                    self?.invalidatePendingPermissions()
                    DispatchQueue.main.async { self?.shutdown() }
                    return
                }
                buffer.append(chunk)
                if buffer.count > 2_000_000 { buffer.removeAll(); continue }
                while let newline = buffer.firstIndex(of: 10) {
                    let line = buffer[..<newline]
                    buffer.removeSubrange(...newline)
                    guard let command = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                    let kind = command["type"] as? String ?? ""
                    let action = command["action"] as? String ?? ""
                    if ["settings", "models", "shutdown"].contains(kind)
                        || (kind == "control" && ["disable-screen", "disable-system-audio", "pause", "resume", "snooze"].contains(action)) {
                        self?.invalidatePendingPermissions()
                    }
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
            if !previewMode {
                defaults.removeObject(forKey: "screenConsentPair")
                defaults.removeObject(forKey: "audioConsentPair")
            }
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
        animationPlayer?.setState(activeAgentPhase, activity: activeAgentActivity)
        refreshAvatarState()
        agentPill.toolTip = agentSummary
        agentPill.isHidden = !settings.agentProgressEnabled || agentPill.stringValue.isEmpty
        refreshSettingsUI()
    }

    private func formatted(_ value: Any?) -> String {
        if let number = value as? NSNumber { return number.stringValue }
        if let text = value as? String, !text.isEmpty { return text }
        return "未知"
    }

    private func offerSnack(_ id: String?) {
        stopMousePlay("正在递零食，指针互动已停止。")
        guard !previewMode else { return }
        var message: [String: Any] = ["type": "snack-offer"]
        if let id { message["id"] = id }
        emit(message)
    }

    /// Eight destinations alternate left/right, clear of the face, speech and card.
    private func snackFrame(slot: Int) -> NSRect {
        let centers: [NSPoint] = [NSPoint(x: 48, y: 174), NSPoint(x: 272, y: 174),
                                  NSPoint(x: 28, y: 126), NSPoint(x: 292, y: 126),
                                  NSPoint(x: 36, y: 78), NSPoint(x: 284, y: 78),
                                  NSPoint(x: 62, y: 30), NSPoint(x: 258, y: 30)]
        let point = centers[min(7, max(0, slot))]
        return NSRect(x: (point.x - 16) * scale, y: (point.y - 16) * scale,
                      width: 32 * scale, height: 32 * scale)
    }

    private func layoutGrowthTray() {
        guard growthState != nil, let content = panel.contentView else { return }
        if growthBadge == nil {
            let badge = CompanionGrowthBadge(frame: .zero)
            badge.onOpen = { [weak self] in self?.showGrowth() }
            content.addSubview(badge)
            growthBadge = badge
            let count = label("", font: .systemFont(ofSize: 11, weight: .medium))
            count.alignment = .center
            count.textColor = .secondaryLabelColor
            content.addSubview(count)
            snackOverflowLabel = count
        }
        growthBadge?.frame = NSRect(x: 322 * scale, y: 209 * scale, width: 92 * scale, height: 99 * scale)
        snackOverflowLabel?.frame = NSRect(x: 322 * scale, y: 176 * scale, width: 92 * scale, height: 25 * scale)
        growthBadge?.isHidden = !settings.growthPanelVisible
        snackOverflowLabel?.isHidden = !settings.growthPanelVisible
        var uniqueIDs = Set<String>()
        let records = (growthState?["snacks"] as? [[String: Any]] ?? []).filter {
            guard let id = $0["id"] as? String else { return false }
            return !id.isEmpty && id.utf8.count <= 256 && uniqueIDs.insert(id).inserted
        }
        let visible = Array(records.prefix(8))
        let wanted = Set(visible.compactMap { $0["id"] as? String })
        for id in Array(snackViews.keys) where !wanted.contains(id) {
            snackViews[id]?.cancelArrival(snapToRest: false)
            snackViews.removeValue(forKey: id)?.removeFromSuperview()
            snackSlots.removeValue(forKey: id)
        }
        // An eaten view was removed earlier, so release its old slot as well.
        for id in Array(snackSlots.keys) where !wanted.contains(id) { snackSlots.removeValue(forKey: id) }
        for record in visible {
            let id = record["id"] as! String
            let view: CompanionSnackView
            if let existing = snackViews[id] { view = existing }
            else {
                view = CompanionSnackView(id: id, kind: record["kind"] as? String ?? "cookie")
                view.onOffer = { [weak self] offered in self?.offerSnack(offered) }
                content.addSubview(view)
                snackViews[id] = view
            }
            if snackSlots[id] == nil {
                let occupied = Set(snackSlots.values)
                snackSlots[id] = (0..<8).first { !occupied.contains($0) } ?? 0
            }
            view.setRestingFrame(snackFrame(slot: snackSlots[id]!), reducedMotion: settings.reduceMotion)
        }
        let total = (growthState?["snackCount"] as? NSNumber)?.intValue ?? records.count
        let overflow = max(0, total - visible.count)
        snackOverflowLabel?.stringValue = overflow > 0 ? "+\(overflow) 份" : (total == 0 ? "暂无零食" : "零食 \(total) 份")
    }

    private func growthDescription() -> String {
        guard let state = growthState else { return "等待 Host 同步成长状态。" }
        let stats = state["stats"] as? [String: Any] ?? [:]
        return ["等级：Lv.\(formatted(state["level"])) · \(state["stage"] as? String ?? "")",
                "称号：\(state["levelTitle"] as? String ?? "—")",
                "本级经验：\(formatted(state["experience"])) / \(formatted(state["nextLevelExperience"]))",
                "饱腹：\(formatted(state["satiety"])) / 100",
                "精力：\(formatted(state["energy"])) / 100",
                "心情：\(formatted(state["mood"])) / 100",
                "零食库存：\(formatted(state["snackCount"]))",
                "累计获得：\(formatted(stats["earnedSnacks"])) · 已吃掉：\(formatted(stats["eatenSnacks"]))",
                "当前状态：\(state["status"] as? String ?? "—")"].joined(separator: "\n\n")
    }

    @objc private func showGrowth() {
        stopMousePlay("正在查看成长，指针互动已停止。")
        if growthWindow == nil {
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 420, height: 445),
                                  styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "成长与零食"
            window.isReleasedWhenClosed = false
            window.center()
            let detail = label(growthDescription(), font: .systemFont(ofSize: 14))
            detail.frame = NSRect(x: 24, y: 75, width: 372, height: 345)
            window.contentView!.addSubview(detail)
            let hint = label("成长和库存以 Host 为准。点击零食只是递给她；太饱、睡觉或专注时，她可能稍后再吃。")
            hint.frame = NSRect(x: 24, y: 20, width: 372, height: 49)
            hint.font = .systemFont(ofSize: 12)
            hint.textColor = .secondaryLabelColor
            window.contentView!.addSubview(hint)
            growthDetailLabel = detail
            growthWindow = window
        }
        growthDetailLabel?.stringValue = growthDescription()
        growthWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func updateGrowth(_ command: [String: Any]) {
        guard let state = command["state"] as? [String: Any] else { return }
        let priorRecords = snackRecords
        var event = command["event"] as? [String: Any]
        if let id = event?["id"] as? String {
            if seenGrowthEvents.contains(id) { event = nil }
            else {
                seenGrowthEvents.insert(id)
                growthEventOrder.append(id)
                while growthEventOrder.count > 128 { seenGrowthEvents.remove(growthEventOrder.removeFirst()) }
            }
        } else { event = nil }
        let firstState = growthState == nil
        let previouslyKnownSnacks = knownSnackIDs.union(priorRecords.keys)
        var eatenView: CompanionSnackView?
        var eatenStart: NSRect?
        if event?["type"] as? String == "snack-eaten", let id = event?["snackId"] as? String {
            eatenView = snackViews.removeValue(forKey: id)
            eatenView?.cancelArrival(snapToRest: false)
            if let frame = eatenView?.frame {
                eatenStart = NSRect(x: frame.minX / scale, y: frame.minY / scale,
                                    width: frame.width / scale, height: frame.height / scale)
            }
            eatenView?.removeFromSuperview()
        }
        growthState = state
        snackRecords = [:]
        for record in state["snacks"] as? [[String: Any]] ?? [] {
            if let id = record["id"] as? String, !id.isEmpty, id.utf8.count <= 256 {
                snackRecords[id] = record
                if knownSnackIDs.insert(id).inserted { knownSnackOrder.append(id) }
            }
        }
        while knownSnackOrder.count > 1024 { knownSnackIDs.remove(knownSnackOrder.removeFirst()) }
        layoutPet()
        if firstState, let screen = NSScreen.screens.first(where: { $0.visibleFrame.intersects(panel.frame) }) {
            let frame = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: min(max(panel.frame.minX, frame.minX), max(frame.minX, frame.maxX - panel.frame.width)),
                                         y: min(max(panel.frame.minY, frame.minY), max(frame.minY, frame.maxY - panel.frame.height))))
        }
        let level = formatted(state["level"])
        growthBadge?.summary = "Lv.\(level) · \(state["stage"] as? String ?? "")\nXP \(formatted(state["experience"]))/\(formatted(state["nextLevelExperience"]))\n饱腹 \(formatted(state["satiety"]))\n精力 \(formatted(state["energy"])) · 心情 \(formatted(state["mood"]))"
        let experience = (state["experience"] as? NSNumber)?.doubleValue ?? 0
        let next = (state["nextLevelExperience"] as? NSNumber)?.doubleValue ?? 0
        growthBadge?.progress = next > 0 && experience.isFinite && next.isFinite ? experience / next : 0
        growthBadge?.toolTip = growthDescription()
        growthDetailLabel?.stringValue = growthDescription()
        defer { publishNativeStatus() }
        guard let event else { return }
        switch event["type"] as? String {
        case "snack-spawned":
            // One reward can add a batch while its event names only the last id.
            // Animate every newly visible id from this snapshot, never old stock.
            if !firstState {
                for id in snackViews.keys.sorted() where !previouslyKnownSnacks.contains(id) {
                    if !settings.reduceMotion { snackArrivalCount += 1 }
                    snackViews[id]?.animateArrival(reducedMotion: settings.reduceMotion)
                }
            }
        case "snack-eaten":
            let id = event["snackId"] as? String ?? ""
            let kind = event["kind"] as? String ?? priorRecords[id]?["kind"] as? String ?? "cookie"
            eatQueue.append((event: event, view: eatenView, kind: kind, startFrame: eatenStart))
            playNextSnackEat()
        case "level-up":
            showSpeech("等级提升：Lv.\(level)", mood: "idle", speak: false)
            if !settings.reduceMotion, let badge = growthBadge {
                badge.alphaValue = 0.45
                NSAnimationContext.runAnimationGroup { context in context.duration = 0.6; badge.animator().alphaValue = 1 }
            }
        default: break
        }
    }

    private func playNextSnackEat() {
        guard !foodAnimationRunning, !eatQueue.isEmpty, let content = panel.contentView else { return }
        let pending = eatQueue.removeFirst()
        let id = pending.event["snackId"] as? String ?? "event-food"
        let view = pending.view ?? CompanionSnackView(id: id, kind: pending.kind)
        view.cancelArrival(snapToRest: false)
        let fallback = snackFrame(slot: 0)
        eatingStartFrame = pending.startFrame ?? NSRect(x: fallback.minX / scale, y: fallback.minY / scale,
                                                       width: fallback.width / scale, height: fallback.height / scale)
        view.canOffer = false
        view.alphaValue = 1
        content.addSubview(view)
        eatingSnackViews[id] = view
        currentEatingID = id
        eatingStarted = Date()
        foodAnimationRunning = true
        if settings.dynamicSkinEnabled { animationPlayer?.interaction("feed") }
        stepSnackEating()
        if foodAnimationRunning {
            eatingAnimationTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.stepSnackEating() }
        }
    }

    private func stepSnackEating() {
        guard foodAnimationRunning, let id = currentEatingID, let view = eatingSnackViews[id],
              let content = panel.contentView else { return }
        let t = settings.reduceMotion ? 1 : min(1, max(0, Date().timeIntervalSince(eatingStarted) / 0.75))
        let eased = 1 - pow(1 - t, 2)
        let mouth: CGPoint
        if let renderer = avatarRenderer,
           let rendered = renderer.mouthPoint() ?? renderer.normalizedPoint(for: animationPlayer?.mouthAnchor ?? CGPoint(x: 0.50, y: 0.44)) {
            mouth = renderer.view.convert(rendered, to: content)
        } else {
            let anchor = animationPlayer?.mouthAnchor ?? CGPoint(x: 0.50, y: 0.44)
            let imageRect = drawnImageRect
            mouth = imageView.convert(NSPoint(x: imageRect.minX + imageRect.width * anchor.x,
                                              y: imageRect.minY + imageRect.height * (1 - anchor.y)), to: content)
        }
        let start = NSRect(x: eatingStartFrame.minX * scale, y: eatingStartFrame.minY * scale,
                           width: eatingStartFrame.width * scale, height: eatingStartFrame.height * scale)
        view.frame = NSRect(x: start.minX + (mouth.x - 8 * scale - start.minX) * eased,
                            y: start.minY + (mouth.y - 8 * scale - start.minY) * eased,
                            width: start.width + (16 * scale - start.width) * eased,
                            height: start.height + (16 * scale - start.height) * eased)
        view.alphaValue = 1 - eased
        if t >= 1 {
            eatingAnimationTimer?.invalidate(); eatingAnimationTimer = nil
            view.removeFromSuperview()
            eatingSnackViews.removeValue(forKey: id)
            currentEatingID = nil
            foodAnimationRunning = false
            playNextSnackEat()
            publishNativeStatus()
        }
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
        case "control":
            if let action = command["action"] as? String { handleControl(String(action.prefix(64)), payload: command) }
        case "request-status": publishNativeStatus(force: true)
        case "speech":
            showSpeech(command["text"] as? String ?? "", mood: command["mood"] as? String ?? "idle",
                       speak: command["speak"] as? Bool ?? false)
        case "mood":
            let mood = command["mood"] as? String ?? "idle"
            modelPending = mood == "thinking"
            animationPlayer?.setThinking(modelPending)
            // Completion clears only pending; preserve the response's personality.
            if mood != "idle" && mood != "thinking" { currentMood = mood; updateImage() }
            refreshAvatarState()
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
            stopMousePlay("设置已改变，指针互动已停止。")
            resolveDefault(provider: incoming["provider"] as? String ?? settings.provider,
                           model: incoming["model"] as? String ?? settings.model)
            if let value = incoming["observationEnabled"] as? Bool {
                if !value && settings.observationEnabled { stopSpokenText() }
                settings.observationEnabled = value
            }
            if let value = incoming["captureIntervalSeconds"] as? Double, value.isFinite { settings.captureIntervalSeconds = min(30, max(1, value)) }
            if let value = incoming["snoozeUntil"] as? Double, value.isFinite {
                if value > nowMilliseconds() && value != settings.snoozeUntil { stopSpokenText() }
                settings.snoozeUntil = max(0, value)
            }
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
                    && speechPermissionRequestIsSafe() && CGPreflightScreenCaptureAccess() && SFSpeechRecognizer.authorizationStatus() == .authorized
            }
            if let value = incoming["voiceEnabled"] as? Bool {
                settings.voiceEnabled = value
                if !value { stopSpokenText() }
            }
            if let value = incoming["lipSyncEnabled"] as? Bool {
                settings.lipSyncEnabled = value
                if !value { avatarRenderer?.setMouthLevel(0) }
            }
            if let value = incoming["voiceIdentifier"] as? String, value != settings.voiceIdentifier { stopSpokenText(); settings.voiceIdentifier = value }
            if let value = incoming["voiceRate"] as? Double, value.isFinite, value != settings.voiceRate { stopSpokenText(); settings.voiceRate = min(0.65, max(0.3, value)) }
            if let value = incoming["speechLanguage"] as? String { settings.speechLanguage = ["zh-CN", "en-US"].contains(value) ? value : "zh-CN" }
            if let value = incoming["memoryEnabled"] as? Bool { settings.memoryEnabled = value }
            if let value = incoming["agentProgressEnabled"] as? Bool { settings.agentProgressEnabled = value }
            if let value = incoming["growthPanelVisible"] as? Bool, value != settings.growthPanelVisible {
                setGrowthPanelVisible(value, notifyHost: false)
            }
            if let value = incoming["reduceMotion"] as? Bool { settings.reduceMotion = value }
            animationPlayer?.setReducedMotion(settings.reduceMotion || !settings.dynamicSkinEnabled)
            if let value = incoming["dynamicSkinEnabled"] as? Bool, value != settings.dynamicSkinEnabled {
                settings.dynamicSkinEnabled = value
                if !previewMode { defaults.set(value, forKey: "dynamicSkinEnabled") }
                configureAnimation()
                updateImage()
                layoutPet()
            }
            if let value = incoming["dailyTokenBudget"] as? Double, value.isFinite { settings.dailyTokenBudget = max(0, value) }
            if let value = incoming["dailyBudget"] as? Double, value.isFinite { settings.dailyBudget = max(0, value) }
            if let value = incoming["inputPricePerMillion"] as? Double, value.isFinite { settings.inputPricePerMillion = max(0, value) }
            if let value = incoming["outputPricePerMillion"] as? Double, value.isFinite { settings.outputPricePerMillion = max(0, value) }
            if let value = incoming["mousePlayEnabled"] as? Bool {
                settings.mousePlayEnabled = value && !previewMode && mousePlayConsent && usingSocketTransport && AXIsProcessTrusted()
            }
            if let value = incoming["mousePlayAfterMinutes"] as? Double, value.isFinite {
                settings.mousePlayAfterMinutes = min(120, max(5, value))
            }
            captureGeneration += 1
            layoutPet()
            refreshSettingsUI()
            resetObservationTimer()
        case "agent": updateAgent(command)
        case "usage": updateUsage(command)
        case "memory": updateMemory(command)
        case "growth": updateGrowth(command)
        case "shutdown": shutdown()
        case "open-settings": showSettings()
        default: break
        }
    }

    private func shutdown() {
        guard !isShuttingDown else { return }
        isShuttingDown = true
        stopMousePlay("宠物已退出，指针互动已停止。")
        captureGeneration += 1
        observationTimer?.invalidate()
        animationTimer?.invalidate()
        passthroughTimer?.invalidate()
        poseTimer?.invalidate()
        bubbleTimer?.invalidate()
        stopSpokenText()
        animationPlayer?.stop()
        avatarRenderer?.stop()
        eatingAnimationTimer?.invalidate()
        for view in snackViews.values { view.cancelArrival(snapToRest: false) }
        Task { await audioTranscriber.stop() }
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }
}

if CommandLine.arguments.contains("--self-test") {
    let settings = CompanionSettings()
    let animationRoot = Bundle.main.resourceURL!.appendingPathComponent("pet", isDirectory: true)
    let animation = PetAnimationPlayer(root: animationRoot) { _ in }
    let decodedFrames = animation.allFramesDecode()
    let passed = !settings.observationEnabled && !settings.screenEnabled && !settings.videoAudioEnabled
        && !settings.voiceEnabled && !settings.memoryEnabled && !settings.mousePlayEnabled && !settings.growthPanelVisible
        && settings.lipSyncEnabled && animation.available && decodedFrames
        && animation.clipCount >= 24 && animation.frameCount >= 24
    emit(["type": "ready", "protocolVersion": 1, "selfTest": true])
    emit(["type": "self-test", "passed": passed,
          "captureDefault": false, "metadataDefault": false, "minimumIntervalSeconds": 1,
          "maximumImageDimension": 1280, "audioCapture": false,
          "screenshotFeatureAvailable": screenshotFeatureAvailable,
          "systemAudioDefault": settings.videoAudioEnabled, "voiceDefault": settings.voiceEnabled, "lipSyncDefault": settings.lipSyncEnabled,
          "memoryDefault": settings.memoryEnabled, "growthPanelDefault": settings.growthPanelVisible, "defaultModel": "harness",
          "animationManifest": animation.available, "pngDecoded": decodedFrames,
          "characterId": animation.characterID ?? "unavailable",
          "clipCount": animation.clipCount, "frameCount": animation.frameCount,
          "allFramesDecoded": decodedFrames,
          "maximumDecodedFrameCache": 12, "mousePlayDefault": settings.mousePlayEnabled,
          "pointerWarpInSelfTest": false, "maximumMousePlaySeconds": 1.5])
    if !passed { exit(1) }
} else {
    if !connectHostTransport() {
        FileHandle.standardError.write(Data("Quiet Companion: private IPC connection failed.\n".utf8))
        exit(2)
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = CompanionApp()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
