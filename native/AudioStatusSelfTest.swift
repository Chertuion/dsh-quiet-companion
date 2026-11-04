import Foundation

/// Concatenate the PURE AUDIO STATUS block from QuietCompanion.swift before
/// this file and compile with -parse-as-library. No AppKit or capture is used.
@main
struct AudioStatusSelfTest {
    static func main() {
        var checks = 0
        func check(_ value: Bool, _ message: String) {
            checks += 1; precondition(value, message)
        }
        func status(active: Bool, starting: Bool = false, running: Bool = false) -> String {
            configuredSystemAudioStatus(enabled: true, active: active, awaitingConsent: false,
                starting: starting, running: running) ?? "missing"
        }
        let paused = status(active: false)
        check(paused.contains("已配置") && paused.contains("观察已暂停"), "configured with observation off is paused")
        check(!paused.contains("权限尚未生效"), "a successful grant cannot keep a stale permission error")
        check(status(active: false, starting: true).contains("暂停"), "observation pause dominates an in-flight start")
        check(status(active: false, running: true).contains("暂停"), "observation pause dominates prior running state")
        check(status(active: true).contains("等待启动"), "configured is not proof of capture start")
        let starting = status(active: true, starting: true)
        check(starting.contains("正在启动") && starting.contains("尚未确认"), "starting does not claim actual capture")
        check(!starting.contains("正在本机识别"), "starting differs from running")
        check(status(active: true, running: true).contains("正在本机识别"), "start completion reports actual recognition")
        check(status(active: true, starting: true, running: true).contains("正在本机识别"), "completed start wins before its defer clears starting")
        for active in [false, true] {
            let failed = configuredSystemAudioStatus(enabled: false, active: active, awaitingConsent: false,
                starting: false, running: false)
            check(failed == nil, "disabled state preserves a real unavailable/failure reason")
            let error = "本机识别不可用，声音理解已关闭。"
            check((failed ?? error) == error, "generic pause/ready text cannot hide actual failure")
        }
        check(configuredSystemAudioStatus(enabled: true, active: true, awaitingConsent: true,
            starting: true, running: false) == nil, "pending permission retains the actual permission message")
        check(configuredSystemAudioStatus(enabled: false, active: false, awaitingConsent: true,
            starting: false, running: false) == nil, "pending with observation off does not claim configured")
        print("audio-status: \(checks) checks passed; no permissions, AppKit, capture or audio playback")
    }
}
