import Foundation
import Darwin

// Explicit MANUAL sound test. Default execution does not play anything.
// Concatenate after SpeechPCMPlayer.swift into a temporary main.swift, then
// compile with swiftc -parse-as-library -swift-version 5 -framework AVFoundation.
// Keeping this test in the same temporary source file permits read-only access
// to its actual private clock without adding a production/debug API.
// Run the resulting test binary with --play-once only after announcing sound.
// No microphone, capture, model, permission request or persistent setting is used.
private extension SpeechPCMPlayer {
    var playbackTestClock: Int64? { lastClockFrame }
    var playbackTestBusy: Bool { active }
}

@main
struct SpeechPCMPlayerPlaybackTest {
    static func main() {
        guard CommandLine.arguments.contains("--play-once") else {
            print("Manual test only: --play-once speaks one fixed short sentence. No sound was started.")
            return
        }
        let player = SpeechPCMPlayer()
        let started = ProcessInfo.processInfo.systemUptime
        var heardPlaying = false
        var finished = false
        var peakLevel = 0.0
        var largestClock: Int64 = 0
        var nonzeroMouthEvents = 0
        var errors: [String] = []
        var states: [Bool] = []
        player.onMouthLevel = { [weak player] level in
            peakLevel = max(peakLevel, level)
            if level > 0.01 { nonzeroMouthEvents += 1 }
            largestClock = max(largestClock, player?.playbackTestClock ?? 0)
        }
        player.onPlaybackState = { [weak player] playing in
            if states.count < 128 { states.append(playing) }
            if playing { heardPlaying = true }
            if !playing, heardPlaying, player?.playbackTestBusy == false { finished = true }
        }
        player.onError = { message in errors.append(message) }
        let observer = Timer(timeInterval: 0.01, repeats: true) { [weak player] _ in
            largestClock = max(largestClock, player?.playbackTestClock ?? 0)
        }
        RunLoop.main.add(observer, forMode: .common)
        player.start(text: "你好，我在这里。", voiceIdentifier: "", rate: 0.5)
        while !finished && errors.isEmpty && ProcessInfo.processInfo.systemUptime - started < 25 {
            _ = RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
        observer.invalidate()
        let endedAtZero = player.mouthLevel == 0 && !player.isPlaying && !player.playbackTestBusy
        let passed = finished && heardPlaying && errors.isEmpty && largestClock > 0 && peakLevel > 0.01 && endedAtZero
        player.stop()
        player.onMouthLevel = nil; player.onPlaybackState = nil; player.onError = nil
        let result: [String: Any] = [
            "passed": passed, "actualPlaybackObserved": heardPlaying,
            "largestActualSampleClock": largestClock, "peakPCMMouthLevel": peakLevel,
            "nonzeroMouthEvents": nonzeroMouthEvents, "drainedNaturally": finished,
            "mouthAndPlayerZeroBeforeStop": endedAtZero, "errors": errors, "playbackStates": states,
            "runtimeSeconds": ProcessInfo.processInfo.systemUptime - started,
            "sentenceCount": 1, "captureOrMicrophone": false, "settingsPersisted": false,
            "source": "pcm-rms", "phonemeEnabled": false
        ]
        if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
        }
        exit(passed ? EXIT_SUCCESS : EXIT_FAILURE)
    }
}
