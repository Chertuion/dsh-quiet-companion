import Foundation
import AVFoundation

// Standalone executable, excluded from the released helper's concatenated build.
// swiftc -swift-version 5 -framework AVFoundation SpeechPCMPlayer.swift \
//   SpeechPCMPlayerSilentTests.swift -o /private/tmp/qc-speech-pcm-selftest
// This test never constructs AVAudioEngine/AVAudioPlayerNode/AVSpeechSynthesizer,
// invokes write/speak, starts output, records, requests permission, or uses files
// other than its own executable. Its test signal exists only in memory.
@main
struct SpeechPCMPlayerSilentTests {
    struct Failure: Error, CustomStringConvertible {
        let description: String
    }
    static var assertions = 0
    static func expect(_ value: @autoclosure () -> Bool, _ message: String) throws {
        assertions += 1
        if !value() { throw Failure(description: message) }
    }
    static func approximately(_ a: Double, _ b: Double, tolerance: Double = 0.0001) -> Bool { abs(a - b) <= tolerance }
    static func input(_ format: AVAudioCommonFormat, channels: AVAudioChannelCount, interleaved: Bool,
                      frames: AVAudioFrameCount = 4) throws -> AVAudioPCMBuffer {
        guard let shape = AVAudioFormat(commonFormat: format, sampleRate: 24000, channels: channels, interleaved: interleaved),
              let value = AVAudioPCMBuffer(pcmFormat: shape, frameCapacity: frames) else { throw Failure(description: "Cannot allocate test PCM") }
        value.frameLength = frames
        return value
    }
    static func conversionTests() throws {
        let int16 = try input(.pcmFormatInt16, channels: 1, interleaved: false)
        for (i, sample) in [Int16(0), 16384, -32768, 32767].enumerated() { int16.int16ChannelData![0][i] = sample }
        let converted16 = try SpeechPCMPlayer.normalizedMonoBuffer(from: int16)
        let values16 = converted16.floatChannelData![0]
        try expect(values16[0] == 0 && values16[1] == 0.5 && values16[2] == -1, "Int16 signed normalization")
        try expect(approximately(Double(values16[3]), 32767 / 32768.0), "Int16 positive maximum")
        int16.int16ChannelData![0][1] = 0
        try expect(values16[1] == 0.5, "Converted output must own its sample memory")

        let int32 = try input(.pcmFormatInt32, channels: 2, interleaved: false)
        for channel in 0..<2 {
            int32.int32ChannelData![channel][0] = Int32.max
            int32.int32ChannelData![channel][1] = Int32.min
            int32.int32ChannelData![channel][2] = 0
            int32.int32ChannelData![channel][3] = channel == 0 ? 1073741824 : -1073741824
        }
        let converted32 = try SpeechPCMPlayer.normalizedMonoBuffer(from: int32)
        let values32 = converted32.floatChannelData![0]
        try expect(approximately(Double(values32[0]), 1) && values32[1] == -1 && values32[3] == 0, "Int32 stereo downmix")
        try expect(converted32.format.channelCount == 1 && converted32.format.sampleRate == 24000, "Preserve rate and output mono")

        let floats = try input(.pcmFormatFloat32, channels: 2, interleaved: true)
        let samples: [Float] = [.nan, 1, 0.5, 0.5, -1, 1, .infinity, -0.5]
        for (i, sample) in samples.enumerated() { floats.floatChannelData![0][i] = sample }
        let convertedFloat = try SpeechPCMPlayer.normalizedMonoBuffer(from: floats)
        let values = convertedFloat.floatChannelData![0]
        try expect(values[0] == 0.5 && values[1] == 0.5 && values[2] == 0 && values[3] == -0.25,
                   "Interleaved Float32 stereo, NaN and infinity handling")
        let unsupported = try input(.pcmFormatFloat64, channels: 1, interleaved: false)
        var rejected = false
        do { _ = try SpeechPCMPlayer.normalizedMonoBuffer(from: unsupported) } catch { rejected = true }
        try expect(rejected, "Unsupported PCM must be rejected")

        for format in [AVAudioCommonFormat.pcmFormatFloat32, .pcmFormatInt16, .pcmFormatInt32] {
            for interleaved in [false, true] {
                let stereo = try input(format, channels: 2, interleaved: interleaved)
                let left: [Double] = [0.5, 0.5, -0.5, -0.5]
                let right: [Double] = [0.5, -0.5, -0.5, 0.5]
                for frame in 0..<4 {
                    for channel in 0..<2 {
                        let value = channel == 0 ? left[frame] : right[frame]
                        let plane = interleaved ? 0 : channel, index = interleaved ? frame * 2 + channel : frame
                        switch format {
                        case .pcmFormatFloat32: stereo.floatChannelData![plane][index] = Float(value)
                        case .pcmFormatInt16: stereo.int16ChannelData![plane][index] = Int16(value * 32768)
                        case .pcmFormatInt32: stereo.int32ChannelData![plane][index] = Int32(value * 2147483648)
                        default: break
                        }
                    }
                }
                let normalized = try SpeechPCMPlayer.normalizedMonoBuffer(from: stereo)
                let output = normalized.floatChannelData![0]
                try expect(output[0] == 0.5 && output[1] == 0 && output[2] == -0.5 && output[3] == 0,
                           "All three formats must support planar and interleaved stereo")
            }
        }
    }
    static func envelopeTests() throws {
        let rate = 24000.0
        var samples = [Float](repeating: 0, count: 2400)
        samples += (0..<4800).map { Float(0.20 * sin(2 * .pi * 440 * Double($0) / rate)) }
        samples += [Float](repeating: 0, count: 4800)
        var continuous = SpeechRMSAccumulator(sampleRate: rate)
        var windows = samples.withUnsafeBufferPointer { continuous.consume($0, at: 0) }
        windows += continuous.finish()
        try expect(windows.count == 25, "Exact 20ms PCM windows")
        try expect(windows[0].level == 0 && windows[8].level > 0.6 && windows[20].level == 0,
                   "Silence, real sine energy and silence")

        var fragmented = SpeechRMSAccumulator(sampleRate: rate)
        var pieces: [SpeechRMSWindow] = []
        for offset in stride(from: 0, to: samples.count, by: 113) {
            let end = min(samples.count, offset + 113)
            samples.withUnsafeBufferPointer { buffer in
                pieces += fragmented.consume(UnsafeBufferPointer(rebasing: buffer[offset..<end]), at: Int64(offset))
            }
        }
        pieces += fragmented.finish()
        try expect(pieces.count == windows.count && zip(pieces, windows).allSatisfy {
            $0.start == $1.start && $0.end == $1.end && approximately($0.level, $1.level, tolerance: 0.0000001)
        }, "Envelope must not depend on TTS callback fragmentation")

        var timeline = SpeechMouthTimeline()
        timeline.append(windows)
        try expect(timeline.level(at: 1000, sampleRate: rate) == 0, "No mouth during initial silence")
        let first = timeline.level(at: 4000, sampleRate: rate)
        try expect(first > 0.5, "Mouth responds to PCM at actual player sample position")
        try expect(timeline.level(at: 4000, sampleRate: rate) == first, "No fake progress while sample clock is stationary")
        _ = timeline.level(at: 7400, sampleRate: rate)
        try expect(timeline.level(at: 9200, sampleRate: rate) == 0, "Silent PCM closes the mouth within 60ms")
        timeline.reset()
        try expect(timeline.level(at: 4000, sampleRate: rate) == 0 && timeline.windows.isEmpty, "Cancel clears all old mouth energy")

        var gap = SpeechRMSAccumulator(sampleRate: rate)
        let tone = [Float](repeating: 0.25, count: 480)
        var gapWindows = tone.withUnsafeBufferPointer { gap.consume($0, at: 0) }
        gapWindows += tone.withUnsafeBufferPointer { gap.consume($0, at: 4800) }
        gapWindows += gap.finish()
        try expect(gapWindows.count == 2 && gapWindows[1].start == 4800, "Underrun must preserve the real silent sample gap")
    }
    static func clockAndDrainTests() throws {
        try expect(SpeechPCMClock.frame(sampleTime: 48000, playerRate: 48000, sourceRate: 24000,
                                        presentationLatency: 0.05) == 22800, "Playback rate and presentation latency mapping")
        try expect(SpeechPCMClock.frame(sampleTime: 100, playerRate: 24000, sourceRate: 24000,
                                        presentationLatency: 0.05) == nil, "Mouth stays closed before audible output")
        try expect(SpeechPCMClock.frame(sampleTime: -1, playerRate: 24000, sourceRate: 24000,
                                        presentationLatency: 0) == nil, "Invalid clock rejected")
        try expect(SpeechPCMClock.frame(sampleTime: 100, playerRate: .nan, sourceRate: 24000,
                                        presentationLatency: 0) == nil, "NaN clock rejected")
        var drain = SpeechPCMDrain()
        drain.scheduled(100); drain.synthesisEnded = true
        try expect(!drain.isFinished(bufferedBytes: 0), "Synthesis EOF is not playback completion")
        try expect(drain.played(100), "Actual dataPlayedBack completion drains its buffer")
        try expect(!drain.isFinished(bufferedBytes: 4), "Pending callback PCM must also drain")
        try expect(drain.isFinished(bufferedBytes: 0) && !drain.played(100), "Finish only after all buffers; ignore duplicate completion")
    }
    static func gateAndCancellationTests() throws {
        let gate = SpeechPCMIngressGate(maximumBytes: 16, maximumSeconds: 0.10, maximumBuffers: 2)
        let first = gate.newCommand()
        try expect(gate.activate(first, segment: 1), "Activate current generation")
        let firstLease = gate.reserve(bytes: 8, seconds: 0.04, command: first, segment: 1).lease
        let secondLease = gate.reserve(bytes: 8, seconds: 0.04, command: first, segment: 1).lease
        try expect(firstLease != nil && secondLease != nil, "Reserve callback PCM within capacity")
        try expect(gate.reserve(bytes: 4, seconds: 0.01, command: first, segment: 1).isOverLimit, "Byte/buffer capacity bounded")
        let next = gate.newCommand()
        try expect(!gate.owns(first, segment: 1), "Cancellation immediately invalidates old callbacks")
        try expect(gate.activate(next, segment: 2), "New generation activates")
        try expect(gate.reserve(bytes: 4, seconds: 0.01, command: first, segment: 1).isStale, "Discard late PCM")
        try expect(gate.reserve(bytes: 4, seconds: 0.01, command: next, segment: 2).isOverLimit,
                   "Canceled queued PCM must still count toward the global memory cap")
        firstLease?.release(); secondLease?.release()
        _ = gate.activate(next, segment: 2)
        let newLease = gate.reserve(bytes: 4, seconds: 0.01, command: next, segment: 2).lease
        try expect(newLease != nil, "New PCM accepted after canceled memory is released")
        firstLease?.release()
        try expect(gate.bufferedBytes(command: next, segment: 2) == 4, "Old duplicate completion cannot release new audio")
        gate.deactivate(next)
        newLease?.release()
        try expect(gate.bufferedBytes(command: next, segment: 2) == 0 && !gate.owns(next, segment: 2), "Stop releases bounded ingress")

        let durationGate = SpeechPCMIngressGate(maximumBytes: 64, maximumSeconds: 0.05, maximumBuffers: 10)
        let durationTicket = durationGate.newCommand()
        _ = durationGate.activate(durationTicket, segment: 1)
        let durationLease = durationGate.reserve(bytes: 4, seconds: 0.03, command: durationTicket, segment: 1).lease
        try expect(durationGate.reserve(bytes: 4, seconds: 0.03, command: durationTicket, segment: 1).isOverLimit,
                   "Duration limit independent of byte and buffer capacity")
        durationLease?.release()
        let countGate = SpeechPCMIngressGate(maximumBytes: 64, maximumSeconds: 1, maximumBuffers: 1)
        let countTicket = countGate.newCommand()
        _ = countGate.activate(countTicket, segment: 1)
        let countLease = countGate.reserve(bytes: 4, seconds: 0.01, command: countTicket, segment: 1).lease
        try expect(countGate.reserve(bytes: 4, seconds: 0.01, command: countTicket, segment: 1).isOverLimit,
                   "Buffer-count limit independent of byte and duration capacity")
        countLease?.release()

        let player = SpeechPCMPlayer()
        var mouths: [Double] = [], states: [Bool] = [], errors = 0
        player.onMouthLevel = { mouths.append($0) }
        player.onPlaybackState = { states.append($0) }
        player.onError = { _ in errors += 1 }
        player.stop(); player.setMuted(true)
        player.start(text: "静音时不得合成或播放。", voiceIdentifier: "", rate: 0.5)
        try expect(player.isMuted && !player.isPlaying && player.mouthLevel == 0, "Mute/start/stop stay closed")
        try expect(!player.audioBackendInitialized, "Muted start must not initialize audio or TTS")
        player.setMuted(false)
        player.start(text: String(repeating: "长", count: 2001), voiceIdentifier: "", rate: 0.5)
        try expect(errors == 1 && !player.audioBackendInitialized, "Reject overlong text before TTS initialization")
        try expect(mouths.allSatisfy { $0 == 0 } && states.allSatisfy { !$0 }, "No silent test playback or false lip movement")
        let text = String(repeating: "字", count: 150) + "。下一句！"
        let chunks = SpeechPCMPlayer.textChunks(text)
        try expect(chunks.allSatisfy { !$0.isEmpty && $0.count <= 64 } && chunks.joined() == text, "Bound sentence generation without dropping text")
    }
    static func main() throws {
        try conversionTests(); try envelopeTests(); try clockAndDrainTests(); try gateAndCancellationTests()
        let result: [String: Any] = ["passed": true, "assertions": assertions,
                                   "pcmFormats": ["Float32", "Int16", "Int32"], "sineAndSilence": true,
                                   "fragmentationInvariant": true, "actualSampleClockMapping": true,
                                   "presentationLatencyAccounted": true, "synthesisEOFIsNotPlaybackEnd": true,
                                   "generationCancellation": true, "boundedIngress": true,
                                   "phonemeMode": "disabled-rms-only", "audioOutputStarted": false,
                                   "ttsSynthesisStarted": false, "captureOrMicrophone": false]
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
