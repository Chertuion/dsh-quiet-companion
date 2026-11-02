#!/bin/zsh
set -eu
native_dir="${0:A:h}"
staging_dir="$(/usr/bin/mktemp -d /private/tmp/quiet-companion-build.XXXXXX)"
app_path="$staging_dir/QuietCompanion.app"
module_cache="${QUIET_COMPANION_MODULE_CACHE_DIR:-$staging_dir/module-cache}"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources/pet" "$module_cache"
# Only this reviewed character source may enter a fresh bundle. Validate before
# compiling; never fall back to an older bundled character or loose art files.
/usr/bin/python3 - "$native_dir/../assets/orange-character" "$app_path/Contents/Resources/pet" <<'PY_ASSETS'
import json, math, shutil, struct, sys
from pathlib import Path
source, destination = map(Path, sys.argv[1:])
source = source.resolve()
required = {
    'idle', 'waiting', 'thinking', 'working', 'working_search', 'working_command',
    'success', 'error', 'dragging', 'dragging_release', 'head_pat', 'poke',
    'skirt', 'eat_token', 'idle_stretch', 'idle_yawn', 'shy', 'concern',
    'tease', 'sleep', 'replying', 'waiting_approval', 'idle_look', 'wave'
}
def check(condition, message):
    if not condition:
        raise ValueError(message)
def image_path(relative):
    check(isinstance(relative, str), 'PNG path must be text')
    path = Path(relative)
    check(not path.is_absolute() and '..' not in path.parts and path.suffix.lower() == '.png', 'unsafe PNG path')
    resolved = (source / path).resolve()
    check(resolved.is_relative_to(source) and resolved != source, 'PNG must remain inside orange-character')
    return resolved
def png_size(relative):
    path = image_path(relative)
    with path.open('rb') as file:
        header = file.read(24)
    check(header[:8] == b'\x89PNG\r\n\x1a\n' and header[12:16] == b'IHDR', 'not a PNG: ' + relative)
    width, height = struct.unpack('>II', header[16:24])
    check(0 < width <= 4096 and 0 < height <= 4096, 'PNG dimensions must be 1..4096')
    return width, height
def valid_rect(rectangle, mouth=False):
    check(isinstance(rectangle, list) and len(rectangle) == 4, 'invalid rectangle')
    check(all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1 for value in rectangle), 'rectangle must be normalized')
    check(rectangle[2] > 0 and rectangle[3] > 0 and rectangle[0] + rectangle[2] <= 1 and rectangle[1] + rectangle[3] <= 1, 'rectangle outside cell')
    if mouth:
        check(0.002 <= rectangle[2] <= 0.12 and 0.002 <= rectangle[3] <= 0.075, 'mouth must be a small explicit face-local rectangle')
try:
    manifest = json.loads((source / 'pet-manifest.json').read_text())
    check(isinstance(manifest, dict), 'manifest must be an object')
    check(manifest.get('schemaVersion') == 3 and manifest.get('characterId') == 'orange-q-companion', 'unsupported character/schema')
    check(manifest.get('columns') == 4 and manifest.get('rows') == 4, 'atlas must be 4x4')
    sheets, clips = manifest.get('sheets'), manifest.get('clips')
    check(isinstance(sheets, dict) and 0 < len(sheets) <= 32, 'sheets must contain 1..32 PNG entries')
    check(isinstance(clips, dict) and len(clips) <= 64 and required <= clips.keys() and 'tail' not in clips, 'all 24 Q-character clips, including skirt, are required')
    for relative in sheets.values():
        width, height = png_size(relative)
        check(width >= 4 and width == height, '4x4 sheets must be square; different sheets may have different pixel sizes')
    for name, clip in clips.items():
        check(isinstance(clip, dict), 'invalid clip: ' + name)
        frames, frame_ms = clip.get('frames'), clip.get('frameMs')
        check(isinstance(frames, list) and 1 <= len(frames) <= 64, 'each clip needs 1..64 frames: ' + name)
        check(type(frame_ms) in (int, float) and math.isfinite(frame_ms) and 16 <= frame_ms <= 5000, 'invalid frameMs: ' + name)
        check(type(clip.get('loop')) is bool, 'loop must be boolean: ' + name)
        total_ms = 0
        for frame in frames:
            check(isinstance(frame, dict) and frame.get('sheet') in sheets, 'unknown frame sheet: ' + name)
            check(all(type(frame.get(axis)) is int and 0 <= frame[axis] < 4 for axis in ('row', 'column')), 'invalid frame coordinates: ' + name)
            duration = frame.get('durationMs') if frame.get('durationMs') is not None else frame_ms
            check(type(duration) in (int, float) and math.isfinite(duration) and 16 <= duration <= 5000, 'invalid frame duration: ' + name)
            total_ms += duration
            if frame.get('mouth') is not None:
                valid_rect(frame['mouth'], mouth=True)
        check(total_ms <= 120000, 'clip duration exceeds two minutes: ' + name)
    regions, anchors = manifest.get('hitRegions') or {}, manifest.get('anchors') or {}
    check(isinstance(regions, dict) and isinstance(anchors, dict), 'geometry must be an object')
    for name, rectangle in regions.items():
        check(name in ('head', 'body', 'skirt'), 'unknown hit region')
        valid_rect(rectangle)
    static_mouths = manifest.get('staticMouths')
    check(isinstance(static_mouths, dict) and {'idle', 'shy'} <= static_mouths.keys(), 'staticMouths.idle and .shy are required')
    for name, rectangle in static_mouths.items():
        check(name in ('idle', 'shy'), 'unknown static mouth geometry')
        valid_rect(rectangle, mouth=True)
    for point in anchors.values():
        check(isinstance(point, list) and len(point) == 2 and all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1 for value in point), 'invalid normalized anchor')
    png_size('idle.png'); png_size('shy.png')
    # copyfile copies bytes only; no Finder metadata or old unreferenced art.
    for relative in {'idle.png', 'shy.png', *sheets.values()}:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(image_path(relative), target)
    shutil.copyfile(source / 'pet-manifest.json', destination / 'pet-manifest.json')
except (OSError, ValueError, TypeError, KeyError, struct.error) as error:
    sys.exit('Orange character assets rejected: ' + str(error))
PY_ASSETS
/bin/cat "$native_dir/MotionState.swift" "$native_dir/SpeechPCMPlayer.swift" "$native_dir/AvatarMeshRenderer.swift" "$native_dir/PetAnimation.swift" "$native_dir/GrowthViews.swift" "$native_dir/QuietCompanion.swift" > "$staging_dir/main.swift"
/usr/bin/xcrun swiftc -swift-version 5 -O -target arm64-apple-macos14.0 \
  -module-cache-path "$module_cache" \
  -framework AppKit -framework ScreenCaptureKit -framework CoreGraphics \
  -framework AVFoundation -framework Speech -framework CoreMedia -framework ImageIO \
  -framework SpriteKit -framework Accelerate \
  -framework ApplicationServices -framework Carbon \
  "$staging_dir/main.swift" -o "$app_path/Contents/MacOS/QuietCompanion"
/bin/cp -X "$native_dir/Info.plist" "$app_path/Contents/Info.plist"
# Sign outside Documents so its file provider cannot attach bundle metadata.
/usr/bin/codesign --force --sign - "$app_path" >/dev/null
/usr/bin/codesign --verify --strict "$app_path"
/usr/bin/plutil -lint "$app_path/Contents/Info.plist"
if [[ $# -gt 0 ]]; then
  /usr/bin/ditto --noextattr --norsrc "$app_path" "$1"
fi
print -r -- "$app_path"
