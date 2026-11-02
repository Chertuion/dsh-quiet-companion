Native companion component — 0.2.0 — 2026-11-02

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
