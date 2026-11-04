import Foundation

/// Concatenate the marked pure policy from QuietCompanion.swift before this
/// file, then compile with -parse-as-library. No AppKit/TCC/capture is invoked.
@main
struct PermissionPolicySelfTest {
    static func main() {
        var checks = 0
        func check(_ value: Bool, _ label: String) {
            checks += 1
            precondition(value, label)
        }
        var gate = PermissionPromptGate()
        check(gate.state(authorized: false, available: false) == "unavailable", "legacy launch cannot request")
        check(gate.state(authorized: false, available: true) == "not-authorized", "fresh preflight")
        check(!gate.shouldRequest(authorized: true), "granted does not request")
        check(!gate.requested, "pre-existing grant does not consume request")
        check(gate.shouldRequest(authorized: false), "explicit initial request")
        check(!gate.shouldRequest(authorized: false), "pending does not re-request")
        check(gate.state(authorized: false, available: true) == "restart-required", "false after request is never success")
        check(gate.state(authorized: true, available: true) == "granted", "OS readiness wins")
        check(!gate.shouldRequest(authorized: true), "refresh never re-request")

        let state = PermissionContextSnapshot(provider: "host", model: "default", vision: true,
            observationEnabled: false, snoozeUntil: 0, speechLanguage: "zh-CN")
        let sameModel: [[String: Any]] = [["provider": "host", "model": "default", "vision": true]]
        check(!state.invalidated(by: ["type": "models", "defaultProvider": "host", "defaultModel": "default", "models": sameModel], now: 100), "same model refresh")
        let echoes: [[String: Any]] = [
            ["voiceEnabled": true], ["memoryEnabled": true], ["growthEnabled": true],
            ["observationEnabled": false, "screenEnabled": false, "consentPair": ""],
            ["provider": "host", "model": "default", "speechLanguage": "zh-CN"],
            ["snoozeUntil": 0.0], ["snoozeUntil": 50.0], ["reduceMotion": true]
        ]
        for setting in echoes {
            check(!state.invalidated(by: ["type": "settings", "settings": setting], now: 100), "unrelated/full false echo retains authorization")
        }
        for action in ["disable-screen", "disable-system-audio", "disable-mouse-play", "pause", "snooze"] {
            check(state.invalidated(by: ["type": "control", "action": action], now: 100), "explicit revocation cancels immediately")
        }
        check(!state.invalidated(by: ["type": "control", "action": "refresh-permissions"], now: 100), "read-only refresh")
        check(state.invalidated(by: ["type": "shutdown"], now: 100), "shutdown cancels")
        check(state.invalidated(by: ["type": "settings", "settings": ["provider": "other"]], now: 100), "route change cancels")
        check(state.invalidated(by: ["type": "settings", "settings": ["model": "other"]], now: 100), "model change cancels")
        check(state.invalidated(by: ["type": "settings", "settings": ["speechLanguage": "en-US"]], now: 100), "language change cancels")
        check(state.invalidated(by: ["type": "settings", "settings": ["snoozeUntil": 1000.0]], now: 100), "future snooze cancels")
        check(state.invalidated(by: ["type": "models", "models": [["provider": "host", "model": "default", "vision": false]]], now: 100), "capability loss cancels")
        var active = state
        active.observationEnabled = true
        check(active.invalidated(by: ["type": "settings", "settings": ["observationEnabled": false]], now: 100), "real pause transition cancels")

        let route = "host\u{1f}default"
        check(retainedConsentPair(incoming: "", current: route, route: route, hasRoute: true) == route, "empty Host echo cannot erase same-route app consent after restart")
        check(retainedConsentPair(incoming: "", current: route, route: "\u{1f}", hasRoute: false) == route, "unknown startup route defers stored consent decision")
        check(retainedConsentPair(incoming: "other", current: "", route: "\u{1f}", hasRoute: false).isEmpty, "unknown route cannot accept new consent")
        check(retainedConsentPair(incoming: "other", current: route, route: route, hasRoute: true).isEmpty, "foreign consent never retained")
        check(retainedConsentPair(incoming: route, current: "", route: route, hasRoute: true) == route, "matching persisted consent")
        check(retainedConsentPair(incoming: "", current: "", route: route, hasRoute: true).isEmpty, "explicit disable clears current first and empty echo cannot restore it")
        check(!consentRouteChanged(previous: "\u{1f}", hadModel: false, route: route, screen: route, audio: route), "first matching model binds stored consent")
        check(consentRouteChanged(previous: "\u{1f}", hadModel: false, route: "other\u{1f}model", screen: route, audio: route), "first different model revokes stored consent")
        check(!consentRouteChanged(previous: route, hadModel: true, route: route, screen: route, audio: route), "same model refresh retains")
        check(consentRouteChanged(previous: route, hadModel: true, route: "other\u{1f}model", screen: route, audio: route), "known route change revokes")
        print("permission-policy: \(checks) checks passed; no OS permission or observation APIs called")
    }
}
