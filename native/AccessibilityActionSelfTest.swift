import AppKit

/// Concatenate the ACCESSIBILITY ACTIONS marker block from QuietCompanion.swift
/// before this file and compile with -parse-as-library -framework AppKit.
/// Only model objects and spy closures are created: no NSApplication, NSView,
/// window, Host, permission request, speech or input event is initialized.
@main
struct AccessibilityActionSelfTest {
    static func main() {
        precondition(NSApp == nil, "The silent AX test must not initialize NSApplication")
        var checks = 0
        func check(_ value: Bool, _ message: String) {
            checks += 1; precondition(value, message)
        }
        check(companionAccessibilityActionAllowed(enabled: true, hidden: false, alpha: 1, visibleWindow: true), "visible enabled action")
        check(!companionAccessibilityActionAllowed(enabled: false, hidden: false, alpha: 1, visibleWindow: true), "cannot offer while consumed/disabled")
        check(!companionAccessibilityActionAllowed(enabled: true, hidden: true, alpha: 1, visibleWindow: true), "hidden ancestor cannot act")
        check(!companionAccessibilityActionAllowed(enabled: true, hidden: false, alpha: 0.08, visibleWindow: true), "transparent action cannot act")
        check(!companionAccessibilityActionAllowed(enabled: true, hidden: false, alpha: .nan, visibleWindow: true), "invalid alpha cannot act")
        check(!companionAccessibilityActionAllowed(enabled: true, hidden: false, alpha: 1, visibleWindow: false), "detached/hidden window cannot act")

        var enabled = true
        var emitted: [String] = []
        var frame = NSRect(x: 10, y: 20, width: 50, height: 60)
        let parent = NSAccessibilityElement()
        let action = CompanionAccessibilityButton(label: "摸摸头", identifier: "quiet-companion.interaction.head", parent: parent,
            frame: { frame }, available: { enabled }, press: { emitted.append("head"); return true })
        check(action.isAccessibilityElement(), "button participates in AX")
        check(action.accessibilityRole() == .button, "semantic AX button role")
        check(action.accessibilityLabel() == "摸摸头", "readable label")
        check(action.accessibilityIdentifier() == "quiet-companion.interaction.head", "stable identifier")
        check((action.accessibilityParent() as AnyObject?) === parent, "parent is the owning AX element")
        parent.setAccessibilityChildren([action])
        check((parent.accessibilityChildren()?.first as AnyObject?) === action, "owner retains the same child identity")
        check(action.accessibilityFrameInParentSpace() == frame, "local frame")
        check(action.isAccessibilityEnabled(), "live availability")
        check(action.accessibilityPerformPress(), "press calls existing interaction")
        check(emitted == ["head"], "exactly one action")
        enabled = false
        check(!action.isAccessibilityEnabled(), "availability is rechecked")
        check(!action.accessibilityPerformPress(), "stale AX element cannot act after disabled")
        check(emitted == ["head"], "disabled press has no side effect")
        frame = NSRect(x: 40, y: 80, width: 100, height: 120)
        check(action.accessibilityFrameInParentSpace() == frame, "local frame updates without recreating identity")
        check(action.accessibilityIdentifier() == "quiet-companion.interaction.head", "identity survives geometry update")

        for kind in ["head", "body", "skirt"] {
            let button = CompanionAccessibilityButton(label: kind, identifier: "quiet-companion.interaction.\(kind)", parent: nil,
                frame: { .zero }, available: { true }, press: { emitted.append(kind); return true })
            check(button.accessibilityPerformPress(), "body-region action available")
            check(emitted.last == kind, "body-region action keeps its exact semantic kind")
        }
        let unavailableAction = CompanionAccessibilityButton(label: "不可用", identifier: "unavailable", parent: nil,
            frame: { .zero }, available: { true }, press: { false })
        check(!unavailableAction.accessibilityPerformPress(), "dispatch failure is not reported as success")
        var owner: NSObject? = NSObject()
        let stale = CompanionAccessibilityButton(label: "失效", identifier: "stale", parent: owner,
            frame: { .zero }, available: { [weak owner] in owner != nil }, press: { emitted.append("stale"); return true })
        owner = nil
        check(stale.accessibilityParent() == nil, "virtual action does not retain its owner")
        check(!stale.accessibilityPerformPress(), "released owner cannot act")
        check(!emitted.contains("stale"), "released owner has no side effect")
        check(NSApp == nil, "No application or window was initialized")
        print("accessibility-actions: \(checks) checks passed; no application, window, Host, capture, TTS or input events")
    }
}
