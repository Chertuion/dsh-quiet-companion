import Foundation
import AVFoundation

// Renderer-independent PCM speech. No input node, microphone, capture, network
// transport, files, or phoneme estimates are used. Clients wire these main-thread
// callbacks to their own renderer and stop() to pause/mute/shutdown controls.
// Integrated by the native companion; renderers receive only PCM-derived levels.

struct SpeechRMSWindow {
    let start: Int64
    let end: Int64
    let level: Double
}

struct SpeechRMSAccumulator {
    let sampleRate: Double
    private var start: Int64 = 0
    private var expected: Int64 = 0
    private var sum = 0.0
    private var count = 0
    private var windowFrames: Int { max(1, Int((sampleRate * 0.020).rounded())) }
    init(sampleRate: Double) { self.sampleRate = sampleRate }

    private mutating func flush() -> SpeechRMSWindow? {
        guard count > 0 else { return nil }
        let rms = sqrt(sum / Double(count))
        let db = 20 * log10(max(0.0000001, rms))
        let level = db < -48 ? 0 : min(1, max(0, (db + 45) / 35))
        let result = SpeechRMSWindow(start: start, end: start + Int64(count), level: level)
        count = 0; sum = 0
        return result
    }

    mutating func consume(_ samples: UnsafeBufferPointer<Float>, at frame: Int64) -> [SpeechRMSWindow] {
        var result: [SpeechRMSWindow] = []
        if frame != expected, let tail = flush() { result.append(tail) }
        for (index, raw) in samples.enumerated() {
            let position = frame + Int64(index)
            if count == 0 { start = position }
            let value = raw.isFinite ? Double(min(1, max(-1, raw))) : 0
            sum += value * value; count += 1
            if count == windowFrames, let window = flush() { result.append(window) }
        }
        expected = frame + Int64(samples.count)
        return result
    }

    mutating func finish() -> [SpeechRMSWindow] { flush().map { [$0] } ?? [] }
}

struct SpeechMouthTimeline {
    private(set) var windows: [SpeechRMSWindow] = []
    private var index = 0
    private var lastFrame: Int64?
    private var silenceSince: Int64?
    private(set) var level = 0.0

    mutating func append(_ additions: [SpeechRMSWindow]) { windows.append(contentsOf: additions) }
    mutating func reset() { windows.removeAll(); index = 0; lastFrame = nil; silenceSince = nil; level = 0 }

    mutating func level(at frame: Int64, sampleRate: Double) -> Double {
        guard frame >= 0, sampleRate.isFinite, sampleRate > 0 else { level = 0; return 0 }
        if let last = lastFrame, frame < last { index = 0; level = 0; lastFrame = nil; silenceSince = nil }
        while index < windows.count, frame >= windows[index].end { index += 1 }
        let target = index < windows.count && frame >= windows[index].start ? windows[index].level : 0
        let seconds = lastFrame.map { Double(frame - $0) / sampleRate } ?? 0.020
        if target == 0 { if silenceSince == nil { silenceSince = frame } }
        else { silenceSince = nil }
        let smoothing = target > level ? 0.035 : 0.045
        level += (target - level) * (1 - exp(-max(0, seconds) / smoothing))
        if target == 0, level < 0.012 || Double(frame - (silenceSince ?? frame)) / sampleRate >= 0.060 { level = 0 }
        lastFrame = frame
        // Only retain a small recent tail; generated future windows remain bounded
        // by the ingress gate rather than by the total duration of the utterance.
        if index > 128 { windows.removeFirst(index - 1); index = 1 }
        return min(1, max(0, level))
    }
}

enum SpeechPCMClock {
    /// Source PCM frames on the player's timeline, not synthesis callback time.
    static func frame(sampleTime: Int64, playerRate: Double, sourceRate: Double,
                      presentationLatency: Double) -> Int64? {
        guard sampleTime >= 0, playerRate.isFinite, playerRate > 0,
              sourceRate.isFinite, sourceRate > 0,
              presentationLatency.isFinite, (0...10).contains(presentationLatency) else { return nil }
        let position = Double(sampleTime) * sourceRate / playerRate - presentationLatency * sourceRate
        guard position >= 0, position < Double(Int64.max) else { return nil }
        return Int64(position.rounded(.down))
    }
}

struct SpeechPCMDrain {
    var synthesisEnded = false
    private(set) var pending = Set<Int64>()
    mutating func scheduled(_ end: Int64) { pending.insert(end) }
    mutating func played(_ end: Int64) -> Bool { pending.remove(end) != nil }
    func isFinished(bufferedBytes: Int) -> Bool { synthesisEnded && pending.isEmpty && bufferedBytes == 0 }
}

/// Bounds callbacks that are waiting for the main queue as well as scheduled
/// buffers retained by AVAudioPlayerNode. Invalidating a command is synchronous.
final class SpeechPCMLease {
    private let gate: SpeechPCMIngressGate
    private let id: UInt64
    private let lock = NSLock()
    private var released = false
    fileprivate init(gate: SpeechPCMIngressGate, id: UInt64) { self.gate = gate; self.id = id }
    func release() {
        lock.lock()
        let shouldRelease = !released
        released = true
        lock.unlock()
        if shouldRelease { gate.release(id) }
    }
    deinit { release() }
}

final class SpeechPCMIngressGate {
    enum Decision {
        case accepted(SpeechPCMLease), stale, overLimit
        var lease: SpeechPCMLease? { if case let .accepted(value) = self { return value }; return nil }
        var isStale: Bool { if case .stale = self { return true }; return false }
        var isOverLimit: Bool { if case .overLimit = self { return true }; return false }
    }
    private struct Record {
        let command: UInt64, segment: UInt64
        let bytes: Int
        let seconds: Double
    }
    private let lock = NSLock()
    private var command: UInt64 = 0
    private var segment: UInt64 = 0
    private var active = false
    private var nextLease: UInt64 = 0
    private var records: [UInt64: Record] = [:]
    private var bytes = 0
    private var seconds = 0.0
    let maximumBytes: Int
    let maximumSeconds: Double
    let maximumBuffers: Int

    init(maximumBytes: Int = 8 * 1024 * 1024, maximumSeconds: Double = 30, maximumBuffers: Int = 512) {
        self.maximumBytes = maximumBytes; self.maximumSeconds = maximumSeconds
        self.maximumBuffers = maximumBuffers
    }
    @discardableResult func newCommand() -> UInt64 {
        lock.lock(); defer { lock.unlock() }
        command &+= 1; active = false
        // Canceled callbacks may still own PCM in a queued main-thread closure.
        // Their leases keep counting until that memory is actually released.
        return command
    }
    func isCurrent(_ value: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }; return command == value
    }
    func activate(_ value: UInt64, segment next: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard command == value else { return false }
        segment = next; active = true
        return true
    }
    func owns(_ value: UInt64, segment requested: UInt64) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return active && command == value && segment == requested
    }
    func deactivate(_ value: UInt64) {
        lock.lock(); defer { lock.unlock() }
        if command == value { active = false }
    }
    func reserve(bytes addition: Int, seconds duration: Double, command value: UInt64, segment requested: UInt64) -> Decision {
        lock.lock(); defer { lock.unlock() }
        guard active && command == value && segment == requested else { return .stale }
        guard addition > 0, addition <= maximumBytes - bytes, duration.isFinite, duration > 0,
              duration <= maximumSeconds - seconds, records.count < maximumBuffers else {
            active = false
            return .overLimit
        }
        nextLease &+= 1
        records[nextLease] = Record(command: value, segment: requested, bytes: addition, seconds: duration)
        bytes += addition; seconds += duration
        return .accepted(SpeechPCMLease(gate: self, id: nextLease))
    }
    fileprivate func release(_ id: UInt64) {
        lock.lock(); defer { lock.unlock() }
        guard let record = records.removeValue(forKey: id) else { return }
        bytes = max(0, bytes - record.bytes); seconds = max(0, seconds - record.seconds)
    }
    func bufferedBytes(command value: UInt64, segment requested: UInt64) -> Int {
        lock.lock(); defer { lock.unlock() }
        return records.values.filter { $0.command == value && $0.segment == requested }.reduce(0) { $0 + $1.bytes }
    }
}

enum SpeechPCMError: Error, LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case let .invalid(message) = self { return message }; return nil }
}

final class SpeechPCMPlayer: NSObject {
    var onMouthLevel: ((Double) -> Void)?
    var onPlaybackState: ((Bool) -> Void)?
    var onError: ((String) -> Void)?
    private(set) var isPlaying = false
    private(set) var mouthLevel = 0.0
    private(set) var isMuted = false

    private let gate = SpeechPCMIngressGate()
    private var command: UInt64 = 0
    private var segment: UInt64 = 0
    private var active = false
    private var chunks: [String] = []
    private var voice: AVSpeechSynthesisVoice?
    private var rate: Float = AVSpeechUtteranceDefaultSpeechRate
    private var synthesizer: AVSpeechSynthesizer?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var timer: Timer?
    private var sourceRate = 0.0
    private var accumulator: SpeechRMSAccumulator?
    private var timeline = SpeechMouthTimeline()
    private var drain = SpeechPCMDrain()
    private var ranges: [Int64: (start: Int64, lease: SpeechPCMLease)] = [:]
    private var scheduledEnd: Int64 = 0
    private var segmentGeneratedSeconds = 0.0
    private var totalGeneratedSeconds = 0.0
    private var synthesisBegan = 0.0
    private var lastPCMAt = 0.0
    private var lastClockFrame: Int64?
    private var lastClockProgressAt = 0.0
    private var hasPCM = false
    private var playerStarted = false
    private var uptime: Double { ProcessInfo.processInfo.systemUptime }

    // Exposed internally for the standalone silent test, never creating hardware.
    var audioBackendInitialized: Bool { engine != nil || player != nil || synthesizer != nil }

    /// Calls may originate off-main; generation invalidation happens immediately,
    /// while AVFoundation control and all outward callbacks run on the main queue.
    func start(text: String, voiceIdentifier: String, rate: Float) {
        let ticket = gate.newCommand()
        onMain { [weak self] in
            guard let self, self.gate.isCurrent(ticket) else { return }
            self.clear()
            guard self.gate.isCurrent(ticket), !self.isMuted else { return }
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed.count <= 2000, rate.isFinite, voiceIdentifier.utf8.count <= 512 else {
                self.onError?("朗读内容为空、过长或语音参数无效。")
                return
            }
            let available = AVSpeechSynthesisVoice.speechVoices()
            let selected = voiceIdentifier.isEmpty
                ? AVSpeechSynthesisVoice(language: "zh-CN") ?? available.first.flatMap { AVSpeechSynthesisVoice(identifier: $0.identifier) }
                : AVSpeechSynthesisVoice(identifier: voiceIdentifier)
            guard let selected else { self.onError?("当前系统声音不可用，请选择已安装的系统声音。"); return }
            self.command = ticket; self.active = true; self.voice = selected
            self.rate = min(0.65, max(0.3, rate))
            self.chunks = Self.textChunks(trimmed)
            self.totalGeneratedSeconds = 0
            self.beginSegment()
        }
    }

    func stop() {
        let ticket = gate.newCommand()
        onMain { [weak self] in
            guard let self, self.gate.isCurrent(ticket) else { return }
            self.clear()
        }
    }

    /// Unmuting does not resume an old generation or queued utterance.
    func setMuted(_ muted: Bool) {
        if muted {
            let ticket = gate.newCommand()
            onMain { [weak self] in
                guard let self, self.gate.isCurrent(ticket) else { return }
                self.isMuted = true; self.clear()
            }
        } else { onMain { [weak self] in self?.isMuted = false } }
    }

    private func onMain(_ action: @escaping () -> Void) {
        if Thread.isMainThread { action() } else { DispatchQueue.main.async(execute: action) }
    }
    private func owns(_ ticket: UInt64, _ part: UInt64) -> Bool {
        active && command == ticket && segment == part && gate.owns(ticket, segment: part)
    }
    private func mouth(_ value: Double, force: Bool = false) {
        let clean = value.isFinite ? min(1, max(0, value)) : 0
        if force || abs(clean - mouthLevel) >= 0.005 || (clean == 0 && mouthLevel != 0) {
            mouthLevel = clean; onMouthLevel?(clean)
        }
    }
    private func playback(_ value: Bool, force: Bool = false) {
        if force || isPlaying != value { isPlaying = value; onPlaybackState?(value) }
    }
    private func clearPlayback() {
        player?.stop(); engine?.stop(); engine?.reset()
        // stop() has unscheduled these buffers. Queued, not-yet-accepted PCM
        // retains its separate lease until its stale delivery is discarded.
        for range in ranges.values { range.lease.release() }
        ranges.removeAll(); drain = SpeechPCMDrain(); timeline.reset(); accumulator = nil
        scheduledEnd = 0; sourceRate = 0; hasPCM = false; playerStarted = false
        lastClockFrame = nil
        mouth(0, force: true); playback(false, force: true)
    }
    private func clear() {
        active = false; gate.deactivate(command)
        timer?.invalidate(); timer = nil
        chunks.removeAll(); voice = nil
        let previous = synthesizer; synthesizer = nil
        previous?.stopSpeaking(at: .immediate)
        clearPlayback()
    }
    private func fail(_ message: String, ticket: UInt64, part: UInt64) {
        guard active, command == ticket, segment == part, gate.isCurrent(ticket) else { return }
        clear(); onError?(message)
    }

    static func textChunks(_ text: String) -> [String] {
        var result: [String] = [], current = ""
        let stops: Set<Character> = ["。", "！", "？", ".", "!", "?", "\n", ";", "；"]
        for character in text {
            current.append(character)
            if current.count >= 64 || stops.contains(character) {
                let value = current.trimmingCharacters(in: .whitespacesAndNewlines)
                if !value.isEmpty { result.append(value) }; current = ""
            }
        }
        let tail = current.trimmingCharacters(in: .whitespacesAndNewlines)
        if !tail.isEmpty { result.append(tail) }
        return result
    }

    private func beginSegment() {
        guard active, gate.isCurrent(command) else { return }
        guard !chunks.isEmpty else { clear(); return }
        let expectedCommand = command
        clearPlayback()
        guard active, command == expectedCommand, gate.isCurrent(expectedCommand) else { return }
        segment &+= 1
        let ticket = command, part = segment
        guard gate.activate(ticket, segment: part) else { clear(); return }
        let utterance = AVSpeechUtterance(string: chunks.removeFirst())
        utterance.voice = voice; utterance.rate = rate
        segmentGeneratedSeconds = 0
        synthesisBegan = uptime; lastPCMAt = uptime; lastClockProgressAt = uptime
        let speech = AVSpeechSynthesizer()
        synthesizer = speech
        timer?.invalidate()
        timer = Timer(timeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer!, forMode: .common)
        // Marker offsets cannot be reliably associated across all voice buffer
        // callbacks here. No phoneme/letter timing is guessed; RMS is authoritative.
        speech.write(utterance) { [weak self] buffer in
            guard let self, self.gate.owns(ticket, segment: part) else { return }
            guard let pcm = buffer as? AVAudioPCMBuffer else {
                self.onMain { self.fail("系统声音返回了不支持的音频格式。", ticket: ticket, part: part) }
                return
            }
            if pcm.frameLength == 0 {
                self.onMain { self.generatedEnd(ticket: ticket, part: part) }
                return
            }
            let bytes = Int(pcm.frameLength) * MemoryLayout<Float>.stride
            let seconds = Double(pcm.frameLength) / pcm.format.sampleRate
            switch self.gate.reserve(bytes: bytes, seconds: seconds, command: ticket, segment: part) {
            case .stale: return
            case .overLimit:
                self.onMain { self.fail("语音生成超过待播缓冲上限，请缩短朗读内容。", ticket: ticket, part: part) }
            case .accepted(let lease):
                do {
                    // Copy inside the callback; AVSpeech may reuse its source buffer.
                    let mono = try Self.normalizedMonoBuffer(from: pcm)
                    self.onMain { self.accept(mono, seconds: seconds, lease: lease, ticket: ticket, part: part) }
                } catch {
                    self.onMain { self.fail(error.localizedDescription, ticket: ticket, part: part) }
                }
            }
        }
    }

    /// Owns all returned samples; supports both interleaved and planar PCM.
    static func normalizedMonoBuffer(from input: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        let frames = Int(input.frameLength), channels = Int(input.format.channelCount)
        let rate = input.format.sampleRate
        guard frames > 0, frames <= 262144, (1...8).contains(channels), rate.isFinite,
              (8000...96000).contains(rate),
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
              let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: input.frameLength),
              let destination = output.floatChannelData?[0] else { throw SpeechPCMError.invalid("系统声音PCM参数无效。") }
        output.frameLength = input.frameLength
        let interleaved = input.format.isInterleaved
        for frame in 0..<frames {
            var sum = 0.0
            for channel in 0..<channels {
                let plane = interleaved ? 0 : channel
                let index = interleaved ? frame * channels + channel : frame
                let sample: Double
                switch input.format.commonFormat {
                case .pcmFormatFloat32:
                    guard let data = input.floatChannelData else { throw SpeechPCMError.invalid("Float32 PCM通道无效。") }
                    sample = Double(data[plane][index])
                case .pcmFormatInt16:
                    guard let data = input.int16ChannelData else { throw SpeechPCMError.invalid("Int16 PCM通道无效。") }
                    sample = Double(data[plane][index]) / 32768
                case .pcmFormatInt32:
                    guard let data = input.int32ChannelData else { throw SpeechPCMError.invalid("Int32 PCM通道无效。") }
                    sample = Double(data[plane][index]) / 2147483648
                default: throw SpeechPCMError.invalid("仅支持Float32、Int16或Int32系统声音PCM。")
                }
                sum += sample.isFinite ? min(1, max(-1, sample)) : 0
            }
            destination[frame] = Float(min(1, max(-1, sum / Double(channels))))
        }
        return output
    }

    private func prepareEngine(format: AVAudioFormat) throws {
        if engine == nil {
            let audio = AVAudioEngine(), node = AVAudioPlayerNode()
            audio.attach(node); engine = audio; player = node
        }
        guard let audio = engine, let node = player else { throw SpeechPCMError.invalid("无法创建音频播放器。") }
        audio.disconnectNodeOutput(node)
        audio.connect(node, to: audio.mainMixerNode, format: format)
        audio.prepare(); try audio.start()
    }
    private func rawClockFrame() -> Int64? {
        guard let node = player, node.isPlaying, let time = node.lastRenderTime,
              let current = node.playerTime(forNodeTime: time), current.isSampleTimeValid else { return nil }
        return SpeechPCMClock.frame(sampleTime: current.sampleTime, playerRate: current.sampleRate,
                                    sourceRate: sourceRate, presentationLatency: 0)
    }
    private func accept(_ buffer: AVAudioPCMBuffer, seconds: Double, lease: SpeechPCMLease, ticket: UInt64, part: UInt64) {
        guard owns(ticket, part) else { lease.release(); return }
        lastPCMAt = uptime
        segmentGeneratedSeconds += seconds; totalGeneratedSeconds += seconds
        guard segmentGeneratedSeconds <= 60, totalGeneratedSeconds <= 600 else {
            fail("语音生成时长超过安全上限。", ticket: ticket, part: part); return
        }
        do {
            if sourceRate == 0 {
                sourceRate = buffer.format.sampleRate; accumulator = SpeechRMSAccumulator(sampleRate: sourceRate)
                try prepareEngine(format: buffer.format)
            } else if abs(sourceRate - buffer.format.sampleRate) > 0.01 {
                throw SpeechPCMError.invalid("系统声音在一句话中改变了采样率，朗读已停止。")
            }
        } catch { fail(error.localizedDescription, ticket: ticket, part: part); return }
        guard let node = player, let samples = buffer.floatChannelData?[0] else { return }
        // If generation stalled and playback ran out, schedule at a real future
        // player time and leave a silent timeline gap instead of shifting lips.
        let current = rawClockFrame()
        let start = current.map { $0 >= scheduledEnd ? $0 + Int64(sourceRate * 0.050) : scheduledEnd } ?? scheduledEnd
        let end = start + Int64(buffer.frameLength)
        scheduledEnd = end; hasPCM = true
        let windows = accumulator?.consume(UnsafeBufferPointer(start: samples, count: Int(buffer.frameLength)), at: start) ?? []
        timeline.append(windows)
        if drain.synthesisEnded { timeline.append(accumulator?.finish() ?? []) }
        drain.scheduled(end); ranges[end] = (start: start, lease: lease)
        node.scheduleBuffer(buffer, at: AVAudioTime(sampleTime: start, atRate: sourceRate), options: [],
                            completionCallbackType: .dataPlayedBack) { [weak self, lease] _ in
            // Never stop a node inside its completion callback (AVAudioPlayerNode
            // explicitly warns that doing so can deadlock its scheduling thread).
            DispatchQueue.main.async { [weak self, lease] in
                lease.release()
                guard let self, self.owns(ticket, part), self.drain.played(end) else { return }
                self.ranges.removeValue(forKey: end)
                self.finishIfDrained()
            }
        }
        startPlayerWhenReady()
    }
    private func startPlayerWhenReady() {
        guard hasPCM, !playerStarted, let node = player,
              Double(scheduledEnd) / sourceRate >= 0.150 || drain.synthesisEnded else { return }
        node.play(); playerStarted = true; lastClockProgressAt = uptime
    }
    private func generatedEnd(ticket: UInt64, part: UInt64) {
        guard owns(ticket, part) else { return }
        drain.synthesisEnded = true
        timeline.append(accumulator?.finish() ?? [])
        guard hasPCM || gate.bufferedBytes(command: ticket, segment: part) > 0 else {
            fail("当前系统声音没有生成可播放的音频。", ticket: ticket, part: part); return
        }
        startPlayerWhenReady(); finishIfDrained()
    }
    private func finishIfDrained() {
        guard active, drain.isFinished(bufferedBytes: gate.bufferedBytes(command: command, segment: segment)) else { return }
        gate.deactivate(command)
        synthesizer = nil
        beginSegment()
    }
    private func tick() {
        guard owns(command, segment) else { mouth(0); playback(false); return }
        let now = uptime
        if !drain.synthesisEnded, now - (hasPCM ? lastPCMAt : synthesisBegan) > 15 {
            fail("系统声音生成超时，朗读已停止。", ticket: command, part: segment); return
        }
        guard playerStarted else { mouth(0); playback(false); return }
        guard let node = player, let audio = engine, audio.isRunning,
              let time = node.lastRenderTime, let current = node.playerTime(forNodeTime: time), current.isSampleTimeValid else {
            mouth(0); playback(false)
            if now - lastClockProgressAt > 3 { fail("音频播放时钟不可用，朗读已停止。", ticket: command, part: segment) }
            return
        }
        guard let raw = rawClockFrame() else { mouth(0); playback(false); return }
        if let previous = lastClockFrame, raw < previous {
            fail("音频播放时钟已重置，朗读已停止。", ticket: command, part: segment); return
        }
        if raw != lastClockFrame { lastClockFrame = raw; lastClockProgressAt = now }
        else if !drain.pending.isEmpty, now - lastClockProgressAt > 3 {
            fail("音频播放时钟停止推进，朗读已停止。", ticket: command, part: segment); return
        }
        guard let audible = SpeechPCMClock.frame(sampleTime: current.sampleTime, playerRate: current.sampleRate,
                                                sourceRate: sourceRate, presentationLatency: node.outputPresentationLatency) else {
            mouth(0); playback(false); return
        }
        let insidePCM = ranges.contains { audible >= $0.value.start && audible < $0.key }
        playback(insidePCM)
        mouth(timeline.level(at: audible, sampleRate: sourceRate))
    }

    deinit {
        gate.newCommand(); timer?.invalidate()
        let speech = synthesizer, node = player, audio = engine
        let shutdown = { speech?.stopSpeaking(at: .immediate); node?.stop(); audio?.stop() }
        if Thread.isMainThread { shutdown() } else { DispatchQueue.main.async(execute: shutdown) }
    }
}
