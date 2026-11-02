Native companion component — 0.3.0 — 2026-11-02

Build
  ./build.sh
The final stdout line is a unique staged app path:
  /private/tmp/quiet-companion-build.XXXXXX/QuietCompanion.app
Compilation, ad-hoc signing and strict signature verification happen outside
Documents. cp -X and ditto --noextattr --norsrc copy resources without metadata.
No global xattr removal, quarantine bypass, or production notarization occurs.
An optional first argument copies the completed bundle to that destination.

Images and licensed animations
idle.png and shy.png are copied from ../assets when present. Optional animation
resources are copied from ../assets/animations; if that source is absent, a
previously packaged native/QuietCompanion.app/Contents/Resources/pet/animations
is used. Runtime resource layout:
  Contents/Resources/pet/idle.png
  Contents/Resources/pet/shy.png
  Contents/Resources/pet/animations/pet-manifest.json
  Contents/Resources/pet/animations/pet/<clip>/<frame>.webp
--assets-dir PATH can override Contents/Resources/pet.
PetAnimation.swift uses manifest frameMs/loop/stateMap/workingActivityMap.
It caches at most twelve decoded frames from one clip and clears them when
switching clips. Idle/thinking/working/waiting/success/error, head/body/tail,
feeding, dragging and drag-release use actual supplied frame sequences.
The source attribution and MIT license are included with those assets.
A settings switch selects the dynamic character or the supplied still art.
This is frame animation, not Live2D.

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
Head/body/tail/feed/sleep/wake/drag/landing emit interactions to the parent.
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
  videoAudioEnabled, speechLanguage, voiceEnabled, voiceIdentifier, voiceRate,
  memoryEnabled, agentProgressEnabled, reduceMotion, dynamicSkinEnabled,
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
  Parent-supplied models/settings never echo a settings event. Persisted screen
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
confirmation and an AXIsProcessTrustedWithOptions prompt; successful enable
alone persists consent and emits the enabled setting. Incoming configuration
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
disable-system-audio, pause, resume, snooze, show, hide, chat, feed, sleep, wake,
open-settings and refresh-status. set-appearance also accepts scale/opacity.
Enable actions are explicit user actions and use native confirmation plus OS
authorization; receiving settings never automatically requests permission.
The fallback native settings window need not appear for a Host enable action.
native-status is deduplicated and includes audioStatus, modelStatus,
screenAuthorized, audioAuthorized, helperVersion, voices:[{id,name,language}],
scale, opacity and permissionRequestInFlight, plus enabled/transport flags.
request-status refreshes that snapshot without echoing settings.
Permission dialogs share an in-flight guard. A pair-bound request epoch is
checked after confirmation, in the Speech callback and after screen access;
queued settings/model changes, disable, pause or shutdown invalidate it at
the reader thread before a modal main loop can delay their application.
Preview does not request authorization, capture data, speak or persist visual
and consent settings; status uses synthetic false authorization values.

Safe QA
  <staged app>/Contents/MacOS/QuietCompanion --self-test
Self-test checks default-off settings and decodes a real first WebP frame.
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
This UI test needs ordinary macOS WindowServer access; it does not request
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
tray renders at most eight concrete snack ids; its overflow badge uses total
snackCount, not just the bounded entity array. A compact level/XP/body-state
card opens a read-only detail window. The expanded panel stays transparent
outside the character, visible snacks and card, and does not cover her feet
or mouth. The helper neither generates food nor changes inventory or XP.
Clicking a snack emits snack-offer:{id}. The existing feed action emits the
same intent without an id. Neither plays an eating action prematurely.
Only a unique snack-eaten event moves the corresponding snack to the mouth,
fades it away and plays the real eat_token clip. The native event-id cache
suppresses repeated event replay. snack-spawned fades a displayed snack in;
level-up adds a plain operation-status hint, not fabricated character dialogue.
The Host decides if/when to eat and supplies all growth changes. Native status
includes petSleeping before interaction events so the Host can defer feeding.
The safe LaunchServices preview regression sends synthetic spawn/eat/replay/
level/sleep/wake messages and asserts there is no inventory-consumption echo.
It does not install or change the real desktop profile or its permissions.
