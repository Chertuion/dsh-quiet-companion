#!/bin/zsh
set -eu
native_dir="${0:A:h}"
staging_dir="$(/usr/bin/mktemp -d /private/tmp/quiet-companion-build.XXXXXX)"
app_path="$staging_dir/QuietCompanion.app"
module_cache="${QUIET_COMPANION_MODULE_CACHE_DIR:-$staging_dir/module-cache}"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources/pet" "$module_cache"
/bin/cat "$native_dir/PetAnimation.swift" "$native_dir/QuietCompanion.swift" > "$staging_dir/main.swift"
/usr/bin/xcrun swiftc -swift-version 5 -O -target arm64-apple-macos14.0 \
  -module-cache-path "$module_cache" \
  -framework AppKit -framework ScreenCaptureKit -framework CoreGraphics \
  -framework AVFoundation -framework Speech -framework CoreMedia -framework ImageIO \
  -framework ApplicationServices -framework Carbon \
  "$staging_dir/main.swift" -o "$app_path/Contents/MacOS/QuietCompanion"
/bin/cp -X "$native_dir/Info.plist" "$app_path/Contents/Info.plist"
for pet_asset in idle.png shy.png; do
  if [[ -f "$native_dir/../assets/$pet_asset" ]]; then
    /bin/cp -X "$native_dir/../assets/$pet_asset" "$app_path/Contents/Resources/pet/$pet_asset"
  fi
done
animations_source="$native_dir/../assets/animations"
if [[ ! -d "$animations_source" ]]; then
  animations_source="$native_dir/QuietCompanion.app/Contents/Resources/pet/animations"
fi
if [[ -d "$animations_source" ]]; then
  /usr/bin/ditto --noextattr --norsrc "$animations_source" "$app_path/Contents/Resources/pet/animations"
fi
# Sign outside Documents so its file provider cannot attach bundle metadata.
/usr/bin/codesign --force --sign - "$app_path" >/dev/null
/usr/bin/codesign --verify --strict "$app_path"
/usr/bin/plutil -lint "$app_path/Contents/Info.plist"
if [[ $# -gt 0 ]]; then
  /usr/bin/ditto --noextattr --norsrc "$app_path" "$1"
fi
print -r -- "$app_path"
