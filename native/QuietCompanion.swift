import AppKit
import CoreGraphics
import ScreenCaptureKit

private let previewMode = CommandLine.arguments.contains("--preview")
private let screenshotFeatureAvailable = false
private let featureNotice = "当前预览版：应用感知与文字陪伴可用，屏幕/视频理解尚未接通"
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
    var captureIntervalSeconds = 8.0
    var snoozeUntil = 0.0
    var provider = ""
    var model = ""
    var consentPair = ""
    var pair: String { provider + "\u{001F}" + model }
    var active: Bool { observationEnabled && snoozeUntil <= nowMilliseconds() }
    var json: [String: Any] {
        ["observationEnabled": observationEnabled, "screenEnabled": screenEnabled,
         "captureIntervalSeconds": captureIntervalSeconds, "snoozeUntil": snoozeUntil,
         "provider": provider, "model": model, "consentPair": consentPair]
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
        if hypot(mouse.x - initialMouse.x, mouse.y - initialMouse.y) > 4 { dragged = true }
        guard dragged else { return }
        window?.setFrameOrigin(NSPoint(x: initialOrigin.x + mouse.x - initialMouse.x,
                                      y: initialOrigin.y + mouse.y - initialMouse.y))
    }
    override func mouseUp(with event: NSEvent) {
        if dragged { companion?.savePosition(); return }
        if event.clickCount >= 2 { companion?.showChat() }
        else { companion?.petHead() }
    }
    override func rightMouseDown(with event: NSEvent) {
        guard let companion else { return }
        NSMenu.popUpContextMenu(companion.petMenu(), with: event, for: self)
    }
}

private final class CompanionApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var settings = CompanionSettings()
    private var models: [CompanionModel] = []
    private var panel: PetPanel!
    private var imageView: PetImageView!
    private var bubble: BubbleView!
    private var sleepLabel: NSTextField!
    private var statusItem: NSStatusItem!
    private var settingsWindow: NSWindow?
    private var chatWindow: NSWindow?
    private var observeCheckbox: NSButton!
    private var screenCheckbox: NSButton!
    private var modelPicker: NSPopUpButton!
    private var disclosureLabel: NSTextField!
    private var statusLabel: NSTextField!
    private var intervalLabel: NSTextField!
    private var intervalSlider: NSSlider!
    private var scaleSlider: NSSlider!
    private var opacitySlider: NSSlider!
    private var chatInput: NSTextField!
    private var chatReply: NSTextField!
    private var observationTimer: Timer?
    private var animationTimer: Timer?
    private var bubbleTimer: Timer?
    private var captureInFlight = false
    private var captureGeneration = 0
    private var modelStatus = "正在连接桌面版……"
    private var currentMood = "idle"
    private var sleeping = false
    private var scale = 1.0
    private var opacity = 1.0
    private var floatingPhase = false
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
        makePanel()
        makeStatusItem()
        showSpeech("我在这儿。先安静陪你，想说话就点点我。", mood: "idle")
        animationTimer = Timer.scheduledTimer(withTimeInterval: 3.5, repeats: true) { [weak self] _ in self?.animatePet() }
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
        imageView.frame = NSRect(x: 55 * scale, y: 4 * scale, width: 210 * scale, height: 270 * scale)
        bubble.frame = NSRect(x: 6 * scale, y: 282 * scale, width: 308 * scale, height: 112 * scale)
        bubble.text.font = .systemFont(ofSize: 14 * min(scale, 1.2), weight: .medium)
        sleepLabel.frame = NSRect(x: 250 * scale, y: 240 * scale, width: 65 * scale, height: 35 * scale)
    }

    func savePosition() {
        defaults.set(panel.frame.origin.x, forKey: "petX")
        defaults.set(panel.frame.origin.y, forKey: "petY")
    }

    private func updateImage() {
        let name = currentMood == "shy" ? "shy.png" : "idle.png"
        imageView.image = NSImage(contentsOf: assetsDirectory.appendingPathComponent(name))
            ?? NSImage(systemSymbolName: "drop.fill", accessibilityDescription: "陪伴小鲸")
        if !FileManager.default.fileExists(atPath: assetsDirectory.appendingPathComponent(name).path) {
            imageView.contentTintColor = .systemBlue
        } else { imageView.contentTintColor = nil }
    }

    private func animatePet() {
        floatingPhase.toggle()
        let targetY = (floatingPhase && !sleeping ? 9.0 : 4.0) * scale
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 1.5
            imageView.animator().setFrameOrigin(NSPoint(x: 55 * scale, y: targetY))
        }
        sleepLabel.isHidden = !sleeping
    }

    func petHead() {
        sleeping = false
        let replies = ["嗯……摸到了。再待一会儿也可以。", "这样就够了。我会乖乖待在旁边。", "被你发现我在等摸头了……", "好啦，今天的贴贴收到。"]
        showSpeech(replies.randomElement()!, mood: "shy")
    }

    private func showSpeech(_ text: String, mood: String) {
        currentMood = ["idle", "shy", "concern", "tease"].contains(mood) ? mood : "idle"
        updateImage()
        bubble.text.stringValue = String(text.prefix(260))
        bubble.isHidden = false
        chatReply?.stringValue = String(text.prefix(1200))
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
            ("退出宠物", #selector(quitPet))]
        for (title, action) in entries {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = self
            menu.addItem(item)
        }
        return menu
    }

    @objc private func togglePet() {
        if panel.isVisible { panel.orderOut(nil) }
        else { panel.orderFrontRegardless() }
    }
    @objc private func openChat() { showChat() }
    @objc private func openSettings() { showSettings() }
    @objc private func quitPet() {
        emit(["type": "quit"])
        shutdown()
    }
    @objc private func pauseObservation() {
        settings.observationEnabled = false
        settingsChanged()
        showSpeech("好，我先不观察了。你叫我时，我还在。", mood: "idle")
    }
    @objc private func snooze() {
        settings.snoozeUntil = nowMilliseconds() + 30 * 60 * 1000
        settingsChanged()
        showSpeech("接下来半小时我会安静待着，不看屏幕。", mood: "idle")
    }
    @objc private func resumeObservation() {
        settings.observationEnabled = true
        settings.snoozeUntil = 0
        settingsChanged()
        showSpeech("好，我回来了。会轻一点，不打扰你。", mood: "idle")
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
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 620),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "安静陪伴 · 设置"
        window.isReleasedWhenClosed = false
        window.center()
        let view = window.contentView!
        let title = label("她会留意你，也会懂得安静。", font: .systemFont(ofSize: 19, weight: .semibold))
        title.frame = NSRect(x: 24, y: 568, width: 492, height: 30)
        view.addSubview(title)
        statusLabel = label(modelStatus)
        statusLabel.frame = NSRect(x: 24, y: 510, width: 492, height: 52)
        view.addSubview(statusLabel)
        observeCheckbox = NSButton(checkboxWithTitle: "观察当前应用与空闲状态", target: self, action: #selector(observeToggled))
        observeCheckbox.frame = NSRect(x: 24, y: 490, width: 492, height: 26)
        view.addSubview(observeCheckbox)
        let metadata = label("关闭或安静期间不采集应用信息和屏幕。此版本不录音，不控制键盘鼠标。")
        metadata.frame = NSRect(x: 44, y: 448, width: 470, height: 38)
        metadata.textColor = .secondaryLabelColor
        view.addSubview(metadata)
        let modelLabel = label("陪伴使用的模型")
        modelLabel.frame = NSRect(x: 24, y: 410, width: 150, height: 24)
        view.addSubview(modelLabel)
        modelPicker = NSPopUpButton(frame: NSRect(x: 174, y: 407, width: 342, height: 30), pullsDown: false)
        modelPicker.target = self
        modelPicker.action = #selector(modelSelected)
        view.addSubview(modelPicker)
        screenCheckbox = NSButton(checkboxWithTitle: "屏幕／视频理解（预览版尚未接通）", target: self, action: #selector(screenToggled))
        screenCheckbox.isEnabled = false
        screenCheckbox.frame = NSRect(x: 24, y: 364, width: 492, height: 26)
        view.addSubview(screenCheckbox)
        disclosureLabel = label("")
        disclosureLabel.frame = NSRect(x: 44, y: 298, width: 470, height: 62)
        disclosureLabel.font = .systemFont(ofSize: 12)
        disclosureLabel.textColor = .secondaryLabelColor
        view.addSubview(disclosureLabel)
        intervalLabel = label("")
        intervalLabel.frame = NSRect(x: 24, y: 262, width: 170, height: 24)
        view.addSubview(intervalLabel)
        intervalSlider = NSSlider(value: settings.captureIntervalSeconds, minValue: 3, maxValue: 60,
                                  target: self, action: #selector(intervalChanged))
        intervalSlider.frame = NSRect(x: 194, y: 260, width: 322, height: 24)
        intervalSlider.isContinuous = false
        view.addSubview(intervalSlider)
        let frequency = label("默认每 8 秒感知当前应用；主动发言频率由插件控制，至少间隔 90 秒。本预览版不采集屏幕，也不录音。")
        frequency.frame = NSRect(x: 24, y: 210, width: 492, height: 42)
        frequency.font = .systemFont(ofSize: 12)
        frequency.textColor = .secondaryLabelColor
        view.addSubview(frequency)
        let scaleLabel = label("宠物大小")
        scaleLabel.frame = NSRect(x: 24, y: 171, width: 120, height: 24)
        view.addSubview(scaleLabel)
        scaleSlider = NSSlider(value: scale, minValue: 0.6, maxValue: 1.6, target: self, action: #selector(scaleChanged))
        scaleSlider.frame = NSRect(x: 150, y: 169, width: 366, height: 24)
        view.addSubview(scaleSlider)
        let opacityLabel = label("透明度")
        opacityLabel.frame = NSRect(x: 24, y: 134, width: 120, height: 24)
        view.addSubview(opacityLabel)
        opacitySlider = NSSlider(value: opacity, minValue: 0.45, maxValue: 1, target: self, action: #selector(opacityChanged))
        opacitySlider.frame = NSRect(x: 150, y: 132, width: 366, height: 24)
        view.addSubview(opacitySlider)
        view.addSubview(button("暂停观察", action: #selector(pauseObservation), frame: NSRect(x: 24, y: 76, width: 145, height: 32)))
        view.addSubview(button("安静 30 分钟", action: #selector(snooze), frame: NSRect(x: 195, y: 76, width: 150, height: 32)))
        view.addSubview(button("继续陪伴", action: #selector(resumeObservation), frame: NSRect(x: 371, y: 76, width: 145, height: 32)))
        let footnote = label("单击摸摸头 · 双击聊天 · 拖动移动 · 右键菜单 · 隐藏后可从菜单栏找回")
        footnote.frame = NSRect(x: 24, y: 20, width: 492, height: 42)
        footnote.font = .systemFont(ofSize: 12)
        footnote.textColor = .secondaryLabelColor
        view.addSubview(footnote)
        settingsWindow = window
    }

    private func refreshSettingsUI() {
        guard settingsWindow != nil else { return }
        observeCheckbox.state = settings.observationEnabled ? .on : .off
        screenCheckbox.state = .off
        screenCheckbox.isEnabled = false
        intervalSlider.doubleValue = settings.captureIntervalSeconds
        intervalLabel.stringValue = "感知间隔：\(Int(settings.captureIntervalSeconds)) 秒"
        statusLabel.stringValue = featureNotice + "\n" + (previewMode ? "界面预览模式：不会采集或申请权限。" : modelStatus)
        modelPicker.removeAllItems()
        if models.isEmpty {
            modelPicker.addItem(withTitle: "未读取到模型，请先在桌面版配置")
            modelPicker.isEnabled = false
        } else {
            modelPicker.isEnabled = true
            for model in models {
                modelPicker.addItem(withTitle: model.label)
            }
            if let index = models.firstIndex(where: { $0.provider == settings.provider && $0.model == settings.model }) {
                modelPicker.selectItem(at: index)
            } else { modelPicker.selectItem(at: -1) }
        }
        let destination = settings.provider.isEmpty || settings.model.isEmpty ? "尚未选择模型" : "\(settings.provider) / \(settings.model)"
        disclosureLabel.stringValue = "文字陪伴使用的模型服务：\(destination)。\n开启观察后，模型会收到当前应用和空闲状态；聊天会发送你输入的文字。本预览版不会采集或发送屏幕、视频或声音。"
    }

    @objc private func observeToggled() {
        settings.observationEnabled = observeCheckbox.state == .on
        settingsChanged()
    }
    @objc private func modelSelected() {
        let index = modelPicker.indexOfSelectedItem
        guard models.indices.contains(index) else { return }
        let selected = models[index]
        if selected.provider != settings.provider || selected.model != settings.model {
            settings.provider = selected.provider
            settings.model = selected.model
            settings.screenEnabled = false
            settings.consentPair = ""
        }
        settingsChanged()
    }
    @objc private func screenToggled() {
        settings.screenEnabled = false
        settings.consentPair = ""
        modelStatus = featureNotice
        settingsChanged()
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

    private func settingsChanged(screenConsent: Bool = false) {
        captureGeneration += 1
        var message = settings.json
        message["type"] = "settings"
        if screenConsent { message["screenConsent"] = true }
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
        chatInput.stringValue = ""
        chatReply.stringValue = "我在听，稍等一下……"
        emit(["type": "chat", "text": String(text.prefix(4000))])
    }

    private func resetObservationTimer() {
        observationTimer?.invalidate()
        observationTimer = nil
        guard !previewMode, settings.observationEnabled else { return }
        observationTimer = Timer.scheduledTimer(withTimeInterval: max(3, settings.captureIntervalSeconds), repeats: true) { [weak self] _ in
            self?.observe()
        }
    }

    private func observe() {
        guard !previewMode, settings.active, !isShuttingDown, !captureInFlight else { return }
        let app = NSWorkspace.shared.frontmostApplication
        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: UInt32.max)!)
        sleeping = idle.isFinite && idle >= 300
        sleepLabel.isHidden = !sleeping
        var observation: [String: Any] = [
            "type": "observation", "app": app?.localizedName ?? "未知应用",
            "bundleId": app?.bundleIdentifier ?? "", "idleSeconds": idle.isFinite ? max(0, idle) : 0,
            "timestamp": nowMilliseconds()]
        guard screenshotFeatureAvailable, settings.screenEnabled, settings.consentPair == settings.pair,
              !settings.provider.isEmpty, !settings.model.isEmpty else { emit(observation); return }
        guard CGPreflightScreenCaptureAccess() else {
            settings.screenEnabled = false
            settings.consentPair = ""
            modelStatus = "屏幕录制权限不可用，截图理解已关闭。"
            settingsChanged()
            emit(observation)
            return
        }
        captureInFlight = true
        let generation = captureGeneration
        Task { @MainActor [weak self] in
            guard let self else { return }
            defer { self.captureInFlight = false }
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
                    throw NSError(domain: "QuietCompanion", code: 1, userInfo: [NSLocalizedDescriptionKey: "没有可用显示器"])
                }
                let ownApps = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
                let filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
                let configuration = SCStreamConfiguration()
                let ratio = min(1, 1280.0 / Double(max(display.width, display.height)))
                configuration.width = max(1, Int(Double(display.width) * ratio))
                configuration.height = max(1, Int(Double(display.height) * ratio))
                configuration.showsCursor = false
                configuration.capturesAudio = false
                let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
                guard self.captureGeneration == generation, self.settings.active, self.settings.screenEnabled,
                      self.settings.consentPair == self.settings.pair, !self.isShuttingDown else { return }
                let bitmap = NSBitmapImageRep(cgImage: image)
                if let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.66]) {
                    observation["screen"] = ["data": data.base64EncodedString(), "mimeType": "image/jpeg"]
                }
                emit(observation)
            } catch {
                guard self.captureGeneration == generation, self.settings.active else { return }
                self.modelStatus = "暂时无法读取屏幕，仍可根据当前应用陪伴。"
                self.refreshSettingsUI()
                emit(observation)
            }
        }
    }

    private func readCommands() {
        Thread.detachNewThread { [weak self] in
            var buffer = Data()
            while true {
                let chunk = FileHandle.standardInput.readData(ofLength: 65_536)
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

    private func handle(_ command: [String: Any]) {
        switch command["type"] as? String {
        case "speech": showSpeech(command["text"] as? String ?? "", mood: command["mood"] as? String ?? "idle")
        case "status":
            modelStatus = command["text"] as? String ?? ""
            refreshSettingsUI()
        case "models":
            models = (command["models"] as? [[String: Any]] ?? []).compactMap(CompanionModel.init)
            refreshSettingsUI()
        case "settings":
            guard let incoming = command["settings"] as? [String: Any] else { return }
            let previousPair = settings.pair
            if let value = incoming["provider"] as? String { settings.provider = value }
            if let value = incoming["model"] as? String { settings.model = value }
            if let value = incoming["observationEnabled"] as? Bool { settings.observationEnabled = value }
            if let value = incoming["captureIntervalSeconds"] as? Double { settings.captureIntervalSeconds = min(60, max(3, value)) }
            if let value = incoming["snoozeUntil"] as? Double { settings.snoozeUntil = max(0, value) }
            if previousPair != settings.pair {
                settings.screenEnabled = false
                settings.consentPair = ""
            }
            settings.screenEnabled = false
            settings.consentPair = ""
            captureGeneration += 1
            refreshSettingsUI()
            resetObservationTimer()
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
        bubbleTimer?.invalidate()
        NSApp.terminate(nil)
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }
}

if CommandLine.arguments.contains("--self-test") {
    let settings = CompanionSettings()
    emit(["type": "ready", "protocolVersion": 1, "selfTest": true])
    emit(["type": "self-test", "passed": !settings.observationEnabled && !settings.screenEnabled,
          "captureDefault": false, "metadataDefault": false, "minimumIntervalSeconds": 3,
          "maximumImageDimension": 1280, "audioCapture": false,
          "screenshotFeatureAvailable": screenshotFeatureAvailable])
} else {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let delegate = CompanionApp()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
