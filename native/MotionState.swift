import Foundation

/// Semantic action names only. This module never loads artwork, starts a clock,
/// generates randomness, plays audio or calls a model.
enum MotionAction: String, CaseIterable {
    case idle
    case waiting
    case thinking
    case working
    case workingSearch = "working_search"
    case workingCommand = "working_command"
    case success
    case error
    case dragging
    case draggingRelease = "dragging_release"
    case headPat = "head_pat"
    case poke
    case skirt
    case eatToken = "eat_token"
    case idleStretch = "idle_stretch"
    case idleYawn = "idle_yawn"
    case shy
    case concern
    case tease
    case sleep
    case replying
    case waitingApproval = "waiting_approval"
    case idleLook = "idle_look"
    case wave
}

/// A caller-owned value snapshot. Keep sleeping=true until an explicit wake
/// signal, and clear temporaryAction when that action actually finishes.
/// Repeated equivalent input resolves to the same clip key; a renderer should
/// compare keys instead of restarting playback on each settings/status update.
struct MotionContext: Equatable {
    var agentPhase = "idle"
    var activity = ""
    var modelPending = false
    var mood = "idle"
    var sleeping = false
    var dragging = false
    var speaking = false
    var temporaryAction: String?
    /// Optional idle embellishment selected by the caller, never by a timer here.
    var idleAction: String?

    func resolve() -> String {
        MotionState.resolve(self).rawValue
    }

    /// Pure interaction reducer. Unknown names leave the previous value intact.
    /// A touch does not implicitly wake a sleeping companion. A legacy tail
    /// signal is accepted as skirt without rewriting stored historical records.
    func applyingInteraction(_ input: String) -> MotionContext {
        var next = self
        switch MotionState.normalized(input) {
        case "sleep":
            next.sleeping = true
            next.temporaryAction = nil
        case "wake":
            next.sleeping = false
            next.temporaryAction = MotionAction.idleStretch.rawValue
        case "drag_hold", "dragging":
            next.dragging = true
            next.temporaryAction = nil
        case "landing", "dragging_release":
            next.dragging = false
            next.temporaryAction = MotionAction.draggingRelease.rawValue
        default:
            if let action = MotionState.interaction(input) {
                next.temporaryAction = action.rawValue
            }
        }
        return next
    }

    /// Restore the *current* context, not a phase captured when a gesture began.
    func finishingTemporaryAction() -> MotionContext {
        var next = self
        next.temporaryAction = nil
        return next
    }
}

enum MotionState {
    /// Priority, highest first:
    /// dragging > actual speaking > persistent sleep > explicit temporary action
    /// > model pending > urgent Agent state > mood > ordinary Agent state
    /// > caller-selected idle embellishment > idle.
    /// Mood sleep is a pose suggestion; persistent sleep belongs to the explicit
    /// sleeping flag and applyingInteraction("sleep"/"wake") lifecycle.
    static func resolve(_ context: MotionContext) -> MotionAction {
        if context.dragging { return .dragging }
        // Speaking is a temporary visual override, not a wake signal. The sleep
        // flag survives and is restored as soon as real playback ends.
        if context.speaking { return .replying }
        if context.sleeping { return .sleep }
        if let temporary = context.temporaryAction.flatMap(interaction) { return temporary }
        if context.modelPending { return .thinking }

        let phase = agentAction(context.agentPhase, activity: context.activity)
        if phase == .waitingApproval || phase == .waiting || phase == .error { return phase }
        if let mood = moodAction(context.mood) { return mood }
        if phase != .idle { return phase }
        if let idle = context.idleAction.flatMap(idleAction) { return idle }
        return .idle
    }

    fileprivate static func normalized(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased().replacingOccurrences(of: "-", with: "_")
    }

    fileprivate static func interaction(_ input: String) -> MotionAction? {
        let value = normalized(input)
        let aliases: [String: MotionAction] = [
            "head": .headPat, "body": .poke, "tail": .skirt,
            "feed": .eatToken, "wake": .idleStretch,
            "drag_hold": .dragging, "landing": .draggingRelease
        ]
        return aliases[value] ?? MotionAction(rawValue: value)
    }

    private static func idleAction(_ input: String) -> MotionAction? {
        switch normalized(input) {
        case "idle": return .idle
        case "idle_look": return .idleLook
        case "wave": return .wave
        case "idle_stretch": return .idleStretch
        case "idle_yawn": return .idleYawn
        default: return nil
        }
    }

    private static func moodAction(_ input: String) -> MotionAction? {
        switch normalized(input) {
        case "shy": return .shy
        case "concern", "concerned": return .concern
        case "tease", "playful": return .tease
        case "happy", "success": return .success
        case "sleep", "sleepy": return .sleep
        case "thinking": return .thinking
        case "error", "failed": return .error
        default: return nil
        }
    }

    private static func agentAction(_ input: String, activity: String) -> MotionAction {
        switch normalized(input) {
        case "waiting_approval", "waitingapproval", "awaiting_approval", "approval":
            return .waitingApproval
        case "waiting_user", "waitinguser", "awaiting_user", "waiting", "queued", "blocked":
            // Waiting for an answer remains distinct from waiting for approval.
            return .waiting
        case "replying", "responding": return .replying
        case "thinking": return .thinking
        case "completed", "done", "finished", "success": return .success
        case "error", "failed": return .error
        case "running", "working", "busy", "tool", "executing":
            switch normalized(activity) {
            case "search", "searching", "browse", "browsing", "read", "reading":
                return .workingSearch
            case "command", "commanding", "shell", "terminal", "test", "testing":
                return .workingCommand
            default: return .working
            }
        case "working_search": return .workingSearch
        case "working_command": return .workingCommand
        // Idle, cancellation and unrecognized phases never invent activity.
        default: return .idle
        }
    }
}
