Native companion component — 0.4.1 — 2026-11-02

Build
  ./build.sh
The final stdout line is a unique staged app path:
  /private/tmp/quiet-companion-build.XXXXXX/QuietCompanion.app
Compilation, ad-hoc signing and strict signature verification happen outside
Documents. cp -X and ditto --noextattr --norsrc copy resources without metadata.
No global xattr removal, quarantine bypass, or production notarization occurs.
An optional first argument copies the completed bundle to that destination.

Orange character assets and atlas schema
The only build source is ../assets/orange-character. Missing or invalid assets
stop the build before Swift compilation. No previous bundled resources,
../assets/animations, or legacy loose art are used as a fallback. Only the
manifest, idle.png, shy.png and its referenced PNG sheets enter the new app:
  Contents/Resources/pet/idle.png
  Contents/Resources/pet/shy.png
  Contents/Resources/pet/pet-manifest.json
  Contents/Resources/pet/sheets/<name>.png
--assets-dir PATH may override this pet root, but the same identity/schema
validation applies to both animated and still modes. An unsupported character,
incomplete manifest or invalid PNG produces an orange neutral sun symbol;
it never falls back to the previous blue-haired character.

Required manifest structure (all sixteen clips must be provided):
  schemaVersion: 2
  characterId: "orange-book-companion"
  columns: 4
  rows: 4
  sheets: {"sheet-id": "sheets/file.png", ...}
  clips: {
    "idle": {
      "frames": [
        {"sheet":"sheet-id", "row":0, "column":0},
        {"sheet":"sheet-id", "row":0, "column":1},
        {"sheet":"sheet-id", "row":0, "column":2},
        {"sheet":"sheet-id", "row":0, "column":3}
      ],
      "frameMs":250,
      "loop":true
    }, ...
  }
  stateMap: {"IDLE":"idle", "THINKING":"thinking", "WORKING":"working",
             "WAITING":"waiting", "SUCCESS":"success", "ERROR":"error"}
  workingActivityMap: {"search":"working_search", "command":"working_command"}
Required clip keys are idle, waiting, thinking, working, working_search,
working_command, success, error, dragging, dragging_release, head_pat, poke,
skirt, eat_token, idle_stretch and idle_yawn. Each has exactly four frames,
row/column 0..3, a finite frameMs in 16..5000 and a boolean loop. Choose loop
false for temporary interactions that should return to the active agent pose;
dragging and ordinary activity clips can loop. All state/activity targets
must exist, and stateMap.IDLE must equal idle. A legacy tail clip is rejected.

Sheets must be valid PNG files, each at least 4x4 and at most 4096x4096, with
all sheets sharing the same dimensions. They need not be divisible by four:
source cell edges use floor(column*width/4) and floor(row*height/4), so a
1254x1254 sheet has 313/314-pixel crops and a stable 313.5x313.5 display size.
Keep a consistent character scale, canvas and baseline across all cells.
Static idle.png/shy.png can have a different aspect ratio and are also bounded
to 4096px. Paths must be relative PNG paths that resolve inside this source.

Optional manifest geometry uses normalized 0..1 coordinates from each cell's
top-left corner, applied to the actual aspect-fit display rectangle:
  hitRegions: {"head":[0.20,0.02,0.60,0.30],
               "body":[0.22,0.32,0.56,0.31],
               "skirt":[0.10,0.63,0.80,0.35]}
  anchors: {"mouth":[0.50,0.23]}
These shown values are the defaults. Hit rectangles must stay inside the cell;
the mouth anchor controls the visible snack's destination. Transparent pixels
remain click-through. Interactions emit head/body/skirt; an old inbound tail
name is accepted only as an alias for skirt and never emitted.

PetAnimation.swift reads actual PNG keyframes and manifest timing/state maps.
The cache holds at most four decoded sheets within 64 MiB plus at most twelve
current-clip frame images; switching clips clears that clip's frame cache.
Reduced motion uses only the first frame of each requested pose. The settings
switch selects this same orange character's dynamic atlas or supplied still
art. This is four-keyframe sprite animation, not Live2D or the prior thousands
of WebP frames; all sixteen states use the new character resources.

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
  videoAudioEnabled, speechLanguage, voiceEnabled, voiceIdentifier, voiceRate,
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
toggle-growth-panel shares the right-click menu action and changes only the
sidebar appearance; it emits a partial settings event containing that one
field, preserving all other Host growth configuration.
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
Self-test checks default-off settings, the orange manifest and all 16x4
PNG atlas cells, reporting pngDecoded, characterId, clipCount, frameCount
and allFramesDecoded. ImageIO decoding does
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
It does not install or change the real desktop profile or its permissions.
