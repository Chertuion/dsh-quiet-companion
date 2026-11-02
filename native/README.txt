Native companion preview component — 2026-11-02

Status
The Swift source compiles for Apple Silicon, targeting macOS 14 or later.
The executable's --self-test mode passed. This mode does not create an app,
read foreground activity, capture the screen, or request permissions.
The interactive windows and live observation have not been launched or tested
by the native build task. Desktop integration and UI QA belong to the plugin
integration task. Screen/video understanding is explicitly unavailable in this
preview, regardless of model capabilities or incoming settings.

Build
  ./build.sh
Default output is a newly created, unique staging location outside Documents:
  /private/tmp/quiet-companion-build.XXXXXX/QuietCompanion.app
The build prints the exact path on its last output line.
Executable smoke test:
  /private/tmp/quiet-companion-build.XXXXXX/QuietCompanion.app/Contents/MacOS/QuietCompanion --self-test

Build packaging
Compilation, ad-hoc signing and strict signature verification now pass in the
/private/tmp staging directory. Copying source data uses cp -X; the build does
not remove quarantine, Finder attributes or any other attributes globally.
Documents' file provider attaches Finder metadata to .app directories, so the
plugin packager should read the staged app into a tar archive without xattrs.
Do not use the obsolete earlier native/build directory; it was generated build
output and has been removed with its module cache.

Implemented in source, awaiting interactive QA
- Transparent floating NSPanel, all Spaces/fullscreen auxiliary behavior.
- Dragging and saved position; saved size and opacity.
- Local affectionate click response, double-click chat, two image expressions.
- Right-click menu, menu-bar restore, pause, 30-minute snooze, settings, quit.
- Periodic foreground-app and idle metadata, disabled by default.
- A fixed notice explains that app awareness and text companionship are available,
  while screen/video understanding is not connected.
- Screen/video checkbox is disabled and no screen-recording permission is requested.
- Incoming settings cannot enable screen capture; all paths force it off.
- Future capture implementation remains behind screenshotFeatureAvailable=false.
- No audio capture, no input control, no screenshot files/history.
- Parent-owned stdin/stdout JSONL protocol; stdin EOF stops the helper.

Protocol
Settings fields:
  observationEnabled, screenEnabled, captureIntervalSeconds (3..60, default 8),
  snoozeUntil (Unix epoch milliseconds), provider, model, consentPair.
Consent binding for future versions:
  consentPair is provider + U+001F + model. This preview clears it and does not
  offer a screenshot consent dialog or capture activation.
Outbound events:
  ready, observation, settings, chat, request-models, quit.
Inbound commands:
  speech, status, models, settings (nested settings object), open-settings, shutdown.
Optional --assets-dir points to a directory containing idle.png and shy.png.
Otherwise images are read from the app bundle's Resources/pet directory.
The build copies ../assets/idle.png and ../assets/shy.png when present.

Scope
The two full-body images support expression changes and a simple floating
movement. They are not a full walk/drag/landing/feeding animation library.
Model selection, provider calls and installable DSH bundle packaging belong
to the backend integration and are not supplied by this native component alone.
