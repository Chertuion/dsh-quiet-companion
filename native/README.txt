Native companion component — Q 0.5.x

Build
  ./build.sh
The final stdout line is a unique staged app path:
  /private/tmp/quiet-companion-build.XXXXXX/QuietCompanion.app
Compilation, ad-hoc signing and strict signature verification happen outside
Documents. cp -X and ditto --noextattr --norsrc copy resources without metadata.
No global xattr removal, quarantine bypass, or production notarization occurs.
An optional first argument copies the completed bundle to that destination.

Q-character assets, timed poses and native mesh
The only build source remains ../assets/orange-character; its active identity
is now schemaVersion:3, characterId:"orange-q-companion". Invalid/missing art
stops the build before Swift compilation. No old bundle, blue character or
older orange-character schema is used as a fallback. Runtime layout:
  Contents/Resources/pet/{idle.png,shy.png,pet-manifest.json}
  Contents/Resources/pet/sheets/<name>.png
--assets-dir applies the same strict identity/schema validation. Invalid art
uses a neutral symbol and disables face-local mouth geometry.

The manifest uses columns:4, rows:4, sheets:{id:relativePNGPath} and clips.
All 24 MotionAction keys are required: idle, waiting, thinking, working,
working_search, working_command, success, error, dragging, dragging_release,
head_pat, poke, skirt, eat_token, idle_stretch, idle_yawn, shy, concern, tease,
sleep, replying, waiting_approval, idle_look and wave. A tail clip is rejected;
old inbound tail interactions remain an alias for skirt only.
Each clip contains 1..64 frames, frameMs:16..5000 and loop:boolean. Each frame
has sheet, row, column, optional durationMs:16..5000, and optional mouth:
[x,y,width,height]. Missing durationMs uses frameMs; total clip duration must
not exceed two minutes. Mouth/hit coordinates use normalized top-left UV.
staticMouths.idle and .shy provide separate mouth rectangles for the still art.
The build checks mouth sizes against the renderer's small-frame limits:
width 0.002..0.12 and height 0.002..0.075, fully inside the image. A pose without
mouth geometry does not get a guessed mouth. Optional hitRegions head/body/
skirt and anchors.mouth retain normalized geometry. State choice is resolved
by MotionState.swift instead of the old stateMap/workingActivityMap.

PNG sheets are square, at least 4x4 and at most 4096x4096. Different sheets
may use different pixel dimensions. Integer floor cell edges preserve every
source pixel, and each crop has a common logical square display size. The
runtime caches at most four decoded sheets within 64 MiB and twelve current
pose frames. Timed poses follow a monotonic clock and do not restart when an
equivalent Host snapshot arrives. Persistent sleep, pending thinking, actual
speech, approval waiting and personality moods have distinct semantic paths.
Explicit wake clears persistent sleep; touches and model idle do not. Actual
PCM playback temporarily uses the calibrated replying pose without clearing
the sleep flag, then restores sleep when playback ends. Drag begins by stopping
speech so a drag pose never receives an unmapped speaking mouth. Finite gestures
still complete at their real deadline when reduced motion holds the first pose;
Agent/config updates do not restart that deadline.

AvatarMeshRenderer.swift uses a native SpriteKit affine vertex grid to add
small continuous breathing/head/edge movement between supplied poses. These
are mesh deformations of supplied art, not additional hand-drawn frames or a
rigged Live2D model. Frame-local mouth geometry and the same forward/inverse
grid transform drive visible mouths, snack destinations and alpha hit testing.
The NSImageView retains the source image for alpha metadata but does not draw
it under the mesh, avoiding double images. Its event layer owns drag/click/
right-click while the renderer's view does not consume input.
Static mode disables mesh micro motion while retaining PCM mouth movement.
Reduced motion and hidden panels close the mouth and disable motion; showing
again requires a fresh mouth-level input. Hiding also stops local speech.

PCM speech and mouth level
SpeechPCMPlayer.swift replaces the direct AVSpeechSynthesizer.speak path.
AVSpeechSynthesizer.write creates owned Float32 mono PCM from Float32/Int16/
Int32 planar or interleaved input. The player computes 20ms RMS windows and
queries AVAudioPlayerNode's actual sample clock with output presentation
latency; no letter count, generated-text duration, synthesis callback wall
time or random loop drives the mouth. Buffer underruns preserve real silent
sample gaps. Phoneme/viseme timing is not enabled in this version.
Only generated model speech explicitly marked speak:true and locally enabled
voice output is read aloud, plus the explicit local voice-test button. Voice
output still defaults false; lipSyncEnabled defaults true and has its own
native/Host checkbox. It has no effect without actual local speech, except
explicit safe synthetic-PCM preview controls. Pause/snooze, mute, replacement,
hide and shutdown cancel audio and close the mouth. Synthesis EOF is not the
playback end: actual dataPlayedBack completions and all queued PCM must drain.
Queued data is bounded across canceled generations by leases: 8 MiB, 30s,
512 buffers; text is capped at 2000 characters and synthesized in <=64-character
segments, with generation/playback-clock timeouts. No microphone, capture,
network transport or audio history file is added by this output player.

Privacy and activation
Observation, screen capture, system audio, voice output and memory default off.
These are standalone native-helper defaults. The Host bridge supplies its
persisted settings; the complete plugin defaults memory to enabled.
The app follows the default Harness model (useDefaultModel=true); there is no
separate API URL, key entry, Keychain item, or alternative provider transport.
Screen capture needs confirmed image capability, explicit same-model consent
and macOS screen-recording authorization. It prefers the foreground window;
fallback display capture excludes this pet. The native helper keeps only a
local visual fingerprint and JPEG frame in memory, suppresses unchanged frames
and emits a maximum 1280-pixel JPEG. The parent may admit selected keyframes to
Harness attachments; those keyframes can persist locally. Both UI disclosure
and consent dialog explain this instead of promising zero image storage.
Screen consent binds provider + U+001F + model and is cleared on model changes.
App-level consent and actual macOS authorization are separate. After an explicit
confirmation, a false screen preflight retains the current-model consent as
pending instead of repeating the dialog. Screen/AX requests are attempted at
most once per helper process; rechecking reads existing permission only.
macOS may require restarting the app after its first screen-recording grant:
https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos
After permission becomes ready, the user must explicitly enable again. Returning
from System Settings or refreshing status never starts capture or pointer play.
Explicit disable cancels pending consent. A model/capability change, real pause,
snooze, language change or shutdown cancels an in-flight confirmation; unrelated
voice/memory/growth/appearance settings and identical model refreshes do not.

System audio
A separate explicit consent gate captures only system playback through
ScreenCaptureKit. No microphone API or audio input tap is used. The stream
requests mono 16 kHz, excludes this process's audio, and discards its tiny video
output. SFSpeechAudioBufferRecognitionRequest.requiresOnDeviceRecognition is
true; capability and authorization are checked. Unsupported device/language
combinations show unavailable and never fall back to network recognition.
Only short text deltas are emitted; no audio files or PCM payloads leave the
helper. Audio consent is a separate audioConsentPair bound to the default
provider/model. Parent-side speech output temporarily suppresses recognition.
The feature remains conditional on the user's macOS permissions and installed
on-device recognition support; it is not guaranteed on every Mac or language.

Timing
Foreground app/idle sensing runs every 1.5 seconds only while observation is
enabled. Metadata is emitted on app/idle-state changes, not every timer tick.
Screen sampling defaults to 3 seconds (configurable 1..30) and local visual
difference suppresses duplicates. The parent decides whether an event merits
a model call or a spoken response. There is no periodic canned speech loop.

Native UI
Transparent floating NSPanel, all Spaces/fullscreen auxiliary behavior,
alpha-aware transparent-region click-through, edge snap, saved position,
size and opacity, reduced motion, menu-bar restore, pause/snooze, memory editor,
agent progress card, usage/balance/budget views and model-generated chat.
The memory editor edits only manually pinned factsText. A separate read-only
window displays all learned and pinned facts with their actual ids and slots,
so the user can copy a target for /forget or /忘记 in chat. Learned facts are
never fed back through the manual-pin editor. Counts show facts/pinned/episodes.
Head/body/skirt/sleep/wake/drag/landing emit interactions to the parent;
feeding emits the snack-offer intent documented below.
Native local poses do not fabricate model dialogue. TTS uses system voices
and is opt-in; parent speech must explicitly contain speak:true.

JSONL protocol
Outbound events:
  ready, request-models, observation, settings, chat, interaction,
  transcript, request-memory, memory-save, memory-clear, request-usage, quit.
observation:
  app, bundleId, idleSeconds, timestamp(milliseconds), contextChanged;
  changed visual frames additionally carry screen:{data,mimeType,width,height},
  frameChanged and visualChange. Optional windowTitle comes only from the
  consented screen-capture path.
transcript:
  text(short delta), timestamp, source:'system-audio', onDevice:true, language.
settings (flattened):
  observationEnabled, screenEnabled, captureIntervalSeconds, snoozeUntil,
  provider, model, useDefaultModel:true, consentPair, audioConsentPair,
  videoAudioEnabled, speechLanguage, voiceEnabled, lipSyncEnabled, voiceIdentifier, voiceRate,
  memoryEnabled, agentProgressEnabled, reduceMotion, dynamicSkinEnabled,
  growthPanelVisible (default false),
  dailyTokenBudget, dailyBudget, inputPricePerMillion, outputPricePerMillion.
Direct user consent adds screenConsent:true or audioConsent:true.
Inbound:
  speech:{text,mood,speak?}, status:{text}, models:{models,defaultProvider,
  defaultModel}, settings:{settings}, agent, usage, memory, open-settings,
  shutdown. Agent snapshots use current:{phase,toolName,turn,step,
  observedCompletedSteps,...}, activeCount and waitingCount; no percent is
  invented. mood changes poses only and idle restores any active agent pose.
  Usage supports nested usage/budget/balance and estimatedCosts by currency.
  Memory uses factsText for editable pins and facts for the read-only full view.
  Parent-supplied models/settings normally do not echo a settings event. Unsafe
  incoming enable requests receive the actual disabled settings instead.
  Persisted screen
  and audio consent are accepted only for the current route and existing OS
  permissions; incoming state never requests permission automatically.
  ping:{id:string} returns pong:{id:string}, bounded to 128 characters, without
  observing, changing settings or calling any model. stdin uses availableData
  so short live-pipe commands do not wait for a 65 KB buffer or EOF.
stdin EOF shuts down the helper and owned capture resources.

LaunchServices transport and Speech crash fix (0.2.1)
The real 2026-11-02 14:54 crash was a TCC privacy-description termination, not
an audio-format or SCStream error. The helper's own Info.plist contained
NSSpeechRecognitionUsageDescription, but macOS attributed its direct-spawned
Speech authorization to the responsible DeepSeek Harness process, whose
Info.plist did not contain that key. Do not modify the official signed app.
The Host now launches this .app through macOS LaunchServices and passes:
  --ipc-socket <private AF_UNIX path> --ipc-token <ephemeral authentication token>
The socket and its parent directory must be owned by the current uid with no
group/other access. Before NSApplication starts, the helper connects and uses
the same duplex FileHandle for its existing JSONL protocol. ready additionally
contains pid, parentPid and ipcToken; the Host authenticates before accepting
other events. No token is written to a log by this helper. Socket EOF follows
the existing shutdown path. Standalone stdin and --preview remain supported.
Speech permission requests additionally require the authenticated-socket
launch mode and a nonempty purpose string in the helper's own bundle. Legacy
bare-spawn usage shows a safe upgrade message instead of requesting Speech.
No official app signature, TCC database or system permission is bypassed.

Optional pointer play
mousePlayEnabled defaults false; mousePlayAfterMinutes defaults 20 and is
clamped to 5..120. enable-mouse-play is an explicit control action with native
confirmation and an AXIsProcessTrustedWithOptions prompt. App consent persists
while the OS grant is pending, but the feature remains disabled until the user
explicitly enables with a real AX grant. Incoming configuration
cannot enable pointer play without that consent and existing AX permission.
mouse-play is the Host policy's trigger, not a timer or model instruction.
It rechecks active observation, no pressed mouse buttons/modifiers, recent
input (idle <=90s), no native modal/permission request/drag, secure input,
foreground application exclusions and focused menu/dialog roles. Independent
native cooldown is at least 30 minutes. The visual tug runs for 1.2 seconds,
has a hard 1.5-second stop and a maximum displacement of 160 pixels. It uses
only CGWarpMouseCursorPosition, which the SDK documents as generating no events.
Global/local input monitors cancel on real movement, mouse press, scrolling or
any key including Esc; every tick also checks for unexpected physical movement.
No click, keystroke, cursor/hardware disassociation or sustained drag is posted.
Pause, settings changes, chat, hide and shutdown cancel the local action.
native-status includes mouseAuthorized, mousePlayActive and mouseStatus.
Preview only changes the pet pose/status and never calls AX permission requests
or CGWarp. The self-test verifies pointer play defaults off; live preview
regression exercises only this inert branch, not a real user cursor movement.

Host controls and status
control:{action} supports enable-screen, disable-screen, enable-system-audio,
disable-system-audio, enable-mouse-play, disable-mouse-play, refresh-permissions,
pause, resume, snooze, show, hide, chat, feed, sleep, wake,
open-settings and refresh-status. set-appearance also accepts scale/opacity.
toggle-growth-panel shares the right-click menu action and changes only the
sidebar appearance; it emits a partial settings event containing that one
field, preserving all other Host growth configuration.
Enable actions are explicit user actions and use native confirmation plus OS
authorization; receiving settings never automatically requests permission.
The fallback native settings window need not appear for a Host enable action.
native-status is deduplicated and includes audioStatus, modelStatus,
screenAuthorized, audioAuthorized, helperVersion, voices:[{id,name,language}],
scale, opacity and permissionRequestInFlight, plus enabled/transport flags.
screenPermissionState is granted, not-authorized, restart-required or unavailable;
restart-required means a request has not produced usable access, not proof that
the user granted it. screenStatus explains the next step. screenConsentPending,
audioConsentPending, mouseConsentPending and permissionsNeedRestart distinguish
pending consent from real OS authorization. refresh-permissions reads screen,
Speech and AX state only, without requesting, enabling, capturing or moving.
request-status refreshes that snapshot without echoing settings.
Permission dialogs share an in-flight guard. A pair-bound request epoch is
checked after confirmation, in the Speech callback and after screen access;
queued material route/capability changes, disable, pause or shutdown invalidate it at
the reader thread before a modal main loop can delay their application.
Preview does not request authorization, capture data, speak or persist visual
and consent settings; status uses synthetic false authorization values.

Safe QA
  <staged app>/Contents/MacOS/QuietCompanion --self-test
Standalone SpeechPCMPlayerSilentTests.swift covers pure PCM formats, sine/
silence, clock mapping, cancellation, global lease limits and EOF/drain without
initializing TTS or an audio output engine. SpeechPCMPlayerPlaybackTest.swift
is a separate manual harness: concatenate it after SpeechPCMPlayer.swift,
compile with -parse-as-library and use --play-once only after announcing sound.
It plays exactly one fixed short sentence, samples the real playback clock/RMS
and checks natural drain/zero mouth, without capture or settings persistence.
Default execution of that manual harness starts no audio.
MotionStateSelfTest.swift and
AvatarMeshGeometrySelfTest.swift are standalone test programs; none is
concatenated into the production build.
PermissionPolicySelfTest.swift tests the marked pure policy block extracted from
QuietCompanion.swift (concatenate that block before the test and compile with
-parse-as-library). It checks per-process request gating, pending consent
retention, read-only refresh, same-model echoes and explicit revocation without
calling AppKit, TCC or observation APIs.
Self-test checks default-off capture/voice settings, lip-sync default true,
the Q-character manifest and every supplied PNG atlas cell, reporting
pngDecoded, characterId, clipCount, frameCount and allFramesDecoded. ImageIO decoding does
not create an NSImage or access WindowServer in this non-UI test.
It does not create NSApplication, observe activity, capture screen/system audio,
request permissions, speak, or call a model.
--preview opens the UI with all capture, speech and outbound chat/interaction
side effects suppressed for visual inspection. No observations, actual capture,
permission requests or network model calls should be made during automated QA.
Real screen/audio behavior requires a separate user-approved interactive test.
The live-pipe regression runs the actual --preview helper with stdin left open:
  python3 protocol-test.py <staged app>
It sends a sub-100-byte ping, fragmented JSON and an overlong bounded id,
requires each pong within two seconds, and always shuts down its own helper.
This UI test needs an unlocked, visible macOS WindowServer session; SpriteKit
scene-frame advancement is intentionally checked and a locked/occluded session
must be unlocked before visual QA. It does not request
screen/audio permission, observe activity or make model calls.
For the production launch/transport path:
  python3 protocol-test.py <staged app> --launch-services
The safe preview test checks a private socket's authenticated ready, tiny and
fragmented ping commands, voices/appearance/status and blocked preview audio
enable, then shuts down its own test app. It does not test actual Speech or
screen permissions; those still need the user's interactive authorization.

Growth and visible snacks
GrowthViews.swift contains original AppKit cookie/candy/fishcake drawings.
It also maps the actual food catalog kinds mantou/lamian/dianxin/cake to
馒头/一碗拉面/精致点心/橡木蛋糕卷, using original bun/noodle-bowl/pastry/cream-roll
drawings; no food images or other external graphics are copied.
Inbound growth:{state,event?} is authoritative: level, experience,
nextLevelExperience, satiety/energy/mood (0..100), stage, optional levelTitle,
stats.earnedSnacks/eatenSnacks, snackCount, snacks and status. The right-hand
display renders at most eight concrete snack ids in stable left/right slots
around the character and beside her feet, clear of her face and speech bubble.
Existing snack ids retain their slots when other snacks disappear. The right
level/XP/body-state card and inventory label are hidden by default; the pet
panel stays 320 logical pixels wide. The menu or native/Host settings can
show that sidebar (420 pixels) without changing growth, rewards or the top
agent indicator. Expanding or scaling moves the panel only as far as needed
to fit its current screen's visible area; collapsing does not otherwise move
the character. Corrections save position outside preview mode. Its overflow label uses total snackCount, not just the
bounded entity array. Growth details remain available from the menu even
while the card is hidden. Transparent regions around the character and food
remain click-through; food hit testing excludes its transparent outer corners. The helper neither generates food nor changes inventory or XP.
Clicking a snack emits snack-offer:{id}. The existing feed action emits the
same intent without an id. Neither plays an eating action prematurely.
The pet image and snack views accept first mouse clicks on the inactive floating
panel. Snack hitTest uses the view's superview coordinates and excludes invisible
corners; it retains priority over the image below it. The Host replies with
notice:{kind:"snack-offer",text,reason} for accepted or refused offers. An explicit
interaction's safe model-error hint may use kind:"model-reply" on the same
operation channel. This is
a separate five-second operation bubble even when the growth card is hidden;
it does not change personality, speak, write chat history or trigger a model.
Actual eating still requires the authoritative snack-eaten event below.
Only a unique snack-eaten event moves the corresponding snack from its current
visible location to the mouth, fades it away and plays the real eat_token
clip. The native event-id cache suppresses repeated event replay. A genuinely
new, visible snack-spawned event floats down 22 logical pixels and settles in
0.55 seconds. For a batched reward, every newly visible id in that snapshot
arrives even if the event names only the last snack; startup inventory,
repeated snapshots and known snack ids never replay that arrival. Reduced motion keeps food still. Scale/sidebar changes
update resting slots and the active eating path without restarting either
animation or changing inventory. level-up adds a plain operation-status hint,
not fabricated character dialogue.
The Host decides if/when to eat and supplies all growth changes. Native status
includes petSleeping before interaction events so the Host can defer feeding.
The safe LaunchServices preview regression sends synthetic spawn/eat/replay/
level/sleep/wake messages and asserts there is no inventory-consumption echo.
It also verifies the default-hidden sidebar, the menu's one-field patch,
left/right slot bounds and stability, duplicate/reduced-motion arrival handling,
and resize/sidebar changes during an actual preview eating animation. A batch
of two new visible foods must add two arrivals, with no extra arrivals on
replay. Its preview-only preview-place-at-right-edge control positions only
the owned test panel, so sidebar expansion is tested against a real screen
edge; production mode ignores this test action.
Native status exposes growthPanelVisible, growthBadgeVisible,
inventoryLabelVisible, petPanelWidth (unscaled), panelWithinVisibleScreen,
snackLayout, snackPositions
(unscaled id/slot/x/y/width/height), snackArrivalCount and snackEatingActive
for these assertions. No observation or additional permission is involved.
The preview-only preview-click:{target:"snack"|"snack-corner"|"head"|"body"|"skirt",id?}
control dispatches synthetic mouse events through this owned panel's hitTest and
first-mouse responder path. It never posts an OS event or moves the real cursor.
preview-click-result reports the actual hit/accepted responder and preview-only
interaction/offer counters; preview suppresses every real Host interaction and
snack-offer event. The protocol regression also checks the independent notice
bubble and non-permission settings without using capture or a model.
It does not install or change the real desktop profile or its permissions.

Native motion and PCM preview diagnostics
native-status includes motionMode, currentClip, actualMouthLevel,
speechPlaying, source:"pcm-rms", lipSyncEnabled, previewPCMActive and compact
frameMetrics from actual SpriteKit scene updates, not a fabricated timer count.
request-status/refresh-status force a fresh snapshot. Only --preview accepts
control preview-pcm:{sampleFrame}, preview-pcm-stop, preview-action:{name} and
preview-reset-motion. preview-pcm uses a fixed in-memory sine/silence sequence
and explicit synthetic sample positions; it does not synthesize TTS, create an
audio output engine or claim speechPlaying:true. Production ignores all these
test actions. The safe LaunchServices regression checks mood restoration,
approval waiting, persistent sleep/wake, actual scene progression, synthetic
PCM mouths, static mouths without mesh movement and reduced/hidden clearing.
