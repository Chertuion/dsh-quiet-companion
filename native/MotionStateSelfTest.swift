import Foundation
import Darwin

/// Silent standalone test. Compile only this file plus MotionState.swift;
/// no AppKit, renderer, audio, permissions or model service is involved.
@main
struct MotionStateSelfTest {
    static func require(_ condition: @autoclosure () -> Bool, _ label: String) {
        if !condition() {
            FileHandle.standardError.write(Data(("MotionState self-test failed: " + label + "\n").utf8))
            exit(EXIT_FAILURE)
        }
    }

    static func main() {
        let expected: Set<String> = [
            "idle", "waiting", "thinking", "working", "working_search", "working_command",
            "success", "error", "dragging", "dragging_release", "head_pat", "poke",
            "skirt", "eat_token", "idle_stretch", "idle_yawn", "shy", "concern", "tease",
            "sleep", "replying", "waiting_approval", "idle_look", "wave"
        ]
        require(MotionAction.allCases.count == 24, "exactly twenty-four semantic actions")
        require(Set(MotionAction.allCases.map(\.rawValue)) == expected, "canonical clip names")
        require(MotionContext().resolve() == "idle", "default idle")

        for action in MotionAction.allCases {
            require(MotionContext(temporaryAction: action.rawValue).resolve() == action.rawValue,
                    "direct semantic action " + action.rawValue)
        }

        for phase in ["waiting-approval", "waiting_approval", "WAITING-APPROVAL", "approval"] {
            require(MotionContext(agentPhase: phase).resolve() == "waiting_approval", "approval phase alias")
        }
        for phase in ["waiting-user", "waiting_user", "queued", "blocked"] {
            require(MotionContext(agentPhase: phase).resolve() == "waiting", "user wait phase alias")
        }
        require(MotionContext(agentPhase: "replying").resolve() == "replying", "Agent replying")
        require(MotionContext(speaking: true).resolve() == "replying", "actual companion speaking")
        require(MotionContext(agentPhase: "tool", activity: "searching").resolve() == "working_search", "search activity")
        require(MotionContext(agentPhase: "running", activity: "commanding").resolve() == "working_command", "command activity")
        require(MotionContext(agentPhase: "running", activity: "testing").resolve() == "working_command", "test activity")
        require(MotionContext(agentPhase: "working", activity: "editing").resolve() == "working", "editing activity")
        require(MotionContext(agentPhase: "completed").resolve() == "success", "completed phase")
        require(MotionContext(agentPhase: "error").resolve() == "error", "error phase")

        let emotions = ["idle": "idle", "shy": "shy", "concern": "concern", "tease": "tease",
                        "happy": "success", "sleep": "sleep", "thinking": "thinking"]
        for (mood, expectedClip) in emotions {
            require(MotionContext(mood: mood).resolve() == expectedClip, "model mood " + mood)
        }
        require(MotionContext(agentPhase: "waiting-approval", mood: "happy").resolve() == "waiting_approval", "approval before decorative mood")
        require(MotionContext(agentPhase: "waiting-user", mood: "tease").resolve() == "waiting", "waiting for answer before mood")
        require(MotionContext(agentPhase: "working", modelPending: true, mood: "happy").resolve() == "thinking", "pending model before ordinary task/mood")

        let working = MotionContext(agentPhase: "tool", activity: "searching")
        var asleep = working.applyingInteraction("sleep")
        require(asleep.sleeping && asleep.resolve() == "sleep", "explicit persistent sleep")
        asleep.agentPhase = "completed"
        asleep.mood = "happy"
        asleep.modelPending = true
        asleep.speaking = true
        require(asleep.resolve() == "replying" && asleep.sleeping, "actual playback temporarily overrides sleep without waking")
        require(MotionContext(modelPending: true, speaking: true, temporaryAction: "head_pat").resolve() == "replying", "actual playback overrides pending and a temporary pose")
        asleep.speaking = false
        require(asleep.resolve() == "sleep", "playback completion restores persistent sleep")
        require(asleep.applyingInteraction("head").resolve() == "sleep", "ordinary touch does not implicitly wake")
        asleep.modelPending = false
        asleep.mood = "idle"
        asleep.agentPhase = "tool"
        let waking = asleep.applyingInteraction("wake")
        require(!waking.sleeping && waking.resolve() == "idle_stretch", "explicit wake and transition")
        require(waking.finishingTemporaryAction().resolve() == "working_search", "wake returns to current task")

        var touched = working.applyingInteraction("head")
        require(touched.resolve() == "head_pat", "touch has temporary priority")
        touched.agentPhase = "waiting-approval"
        require(touched.resolve() == "head_pat", "current short explicit interaction is stable")
        require(touched.finishingTemporaryAction().resolve() == "waiting_approval", "finish restores newly updated task")
        require(working.applyingInteraction("tail").resolve() == "skirt", "legacy tail means skirt")
        require(working.applyingInteraction("skirt").resolve() == "skirt", "current skirt interaction")

        let held = working.applyingInteraction("drag-hold")
        require(held.dragging && held.resolve() == "dragging", "drag begins")
        let landed = held.applyingInteraction("landing")
        require(!landed.dragging && landed.resolve() == "dragging_release", "landing transition")
        require(landed.finishingTemporaryAction().resolve() == "working_search", "landing restores task")
        require(MotionContext(modelPending: true, sleeping: true, dragging: true, speaking: true).resolve() == "dragging", "drag is highest priority")

        require(MotionContext(idleAction: "idle_look").resolve() == "idle_look", "caller-selected idle look")
        require(MotionContext(idleAction: "wave").resolve() == "wave", "caller-selected wave")
        require(MotionContext(agentPhase: "working", idleAction: "wave").resolve() == "working", "idle embellishment does not override work")
        require(MotionContext(agentPhase: "unknown", activity: "searching", mood: "unknown", temporaryAction: "unknown", idleAction: "unknown").resolve() == "idle", "unknown input safely idle")
        require(working.applyingInteraction("unknown") == working, "unknown interaction does not rewrite state")

        let repeated = MotionContext(agentPhase: "tool", activity: "commanding")
        let before = repeated
        for _ in 0..<10_000 {
            require(repeated.resolve() == "working_command", "same input keeps same playback key")
        }
        require(repeated == before, "resolution has no mutation or hidden progress")
        // A successful run deliberately produces no stdout, stderr or sound.
    }
}
