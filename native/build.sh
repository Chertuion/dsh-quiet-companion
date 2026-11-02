#!/bin/zsh
set -eu
native_dir="${0:A:h}"
staging_dir="$(/usr/bin/mktemp -d /private/tmp/quiet-companion-build.XXXXXX)"
app_path="$staging_dir/QuietCompanion.app"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources/pet" "$staging_dir/module-cache"
/usr/bin/xcrun swiftc -swift-version 5 -O -target arm64-apple-macos14.0 \
  -module-cache-path "$staging_dir/module-cache" \
  -framework AppKit -framework ScreenCaptureKit -framework CoreGraphics \
  "$native_dir/QuietCompanion.swift" -o "$app_path/Contents/MacOS/QuietCompanion"
/bin/cp -X "$native_dir/Info.plist" "$app_path/Contents/Info.plist"
for pet_asset in idle.png shy.png; do
  if [[ -f "$native_dir/../assets/$pet_asset" ]]; then
    /bin/cp -X "$native_dir/../assets/$pet_asset" "$app_path/Contents/Resources/pet/$pet_asset"
  fi
done
# Sign outside Documents so its file provider cannot attach bundle metadata.
/usr/bin/codesign --force --sign - "$app_path" >/dev/null
/usr/bin/codesign --verify --strict "$app_path"
/usr/bin/plutil -lint "$app_path/Contents/Info.plist"
if [[ $# -gt 0 ]]; then
  /usr/bin/ditto --noextattr --norsrc "$app_path" "$1"
fi
print -r -- "$app_path"
