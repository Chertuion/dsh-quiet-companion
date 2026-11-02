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
    'skirt', 'eat_token', 'idle_stretch', 'idle_yawn'
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
try:
    manifest = json.loads((source / 'pet-manifest.json').read_text())
    check(isinstance(manifest, dict), 'manifest must be an object')
    check(manifest.get('schemaVersion') == 2 and manifest.get('characterId') == 'orange-book-companion', 'unsupported character/schema')
    check(manifest.get('columns') == 4 and manifest.get('rows') == 4, 'atlas must be 4x4')
    sheets, clips = manifest.get('sheets'), manifest.get('clips')
    check(isinstance(sheets, dict) and 0 < len(sheets) <= 16, 'sheets must contain 1..16 PNG entries')
    check(isinstance(clips, dict) and required <= clips.keys() and 'tail' not in clips, 'all sixteen orange clips, including skirt, are required')
    dimensions = []
    for relative in sheets.values():
        width, height = png_size(relative)
        check(width >= 4 and height >= 4, 'sheet dimensions must be at least four pixels')
        dimensions.append((width, height))
    check(len(set(dimensions)) == 1, 'all sheets must share dimensions')
    for name, clip in clips.items():
        check(isinstance(clip, dict), 'invalid clip: ' + name)
        frames, frame_ms = clip.get('frames'), clip.get('frameMs')
        check(isinstance(frames, list) and len(frames) == 4, 'each clip needs exactly four frames: ' + name)
        check(type(frame_ms) in (int, float) and math.isfinite(frame_ms) and 16 <= frame_ms <= 5000, 'invalid frameMs: ' + name)
        check(type(clip.get('loop')) is bool, 'loop must be boolean: ' + name)
        for frame in frames:
            check(isinstance(frame, dict) and frame.get('sheet') in sheets, 'unknown frame sheet: ' + name)
            check(all(type(frame.get(axis)) is int and 0 <= frame[axis] < 4 for axis in ('row', 'column')), 'invalid frame coordinates: ' + name)
    state_map, activity_map = manifest.get('stateMap'), manifest.get('workingActivityMap')
    check(isinstance(state_map, dict) and state_map.get('IDLE') == 'idle', 'stateMap.IDLE must be idle')
    check(isinstance(activity_map, dict) and all(value in clips for value in [*state_map.values(), *activity_map.values()]), 'state/activity map references unknown clip')
    regions, anchors = manifest.get('hitRegions') or {}, manifest.get('anchors') or {}
    check(isinstance(regions, dict) and isinstance(anchors, dict), 'geometry must be an object')
    for name, rectangle in regions.items():
        check(name in ('head', 'body', 'skirt') and isinstance(rectangle, list) and len(rectangle) == 4, 'invalid hit region')
        check(all(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1 for value in rectangle), 'hit region must be normalized')
        check(rectangle[2] > 0 and rectangle[3] > 0 and rectangle[0] + rectangle[2] <= 1 and rectangle[1] + rectangle[3] <= 1, 'hit region outside cell')
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
/bin/cat "$native_dir/PetAnimation.swift" "$native_dir/GrowthViews.swift" "$native_dir/QuietCompanion.swift" > "$staging_dir/main.swift"
/usr/bin/xcrun swiftc -swift-version 5 -O -target arm64-apple-macos14.0 \
  -module-cache-path "$module_cache" \
  -framework AppKit -framework ScreenCaptureKit -framework CoreGraphics \
  -framework AVFoundation -framework Speech -framework CoreMedia -framework ImageIO \
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
