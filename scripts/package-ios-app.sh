#!/bin/sh
# Package a signed device build of the iOS app as an IPA for scripts/publish-native-build.py.
# Run on the Mac that built it, after an Xcode build for a device or "Any iOS Device":
#   scripts/package-ios-app.sh .../Build/Products/Debug-iphoneos/OmarchyRemote.app OmarchyRemote-<build>.ipa
# It refuses an app whose signature is broken (for example, a resource changed after signing) and
# checks the signature again inside the finished IPA.
set -eu
if [ $# -ne 2 ]; then
  echo "usage: $0 path/to/App.app output.ipa" >&2
  exit 2
fi
app=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
out=$(cd "$(dirname "$2")" && pwd)/$(basename "$2")
platform=$(/usr/libexec/PlistBuddy -c 'Print :DTPlatformName' "$app/Info.plist")
if [ "$platform" != iphoneos ]; then
  echo "$app is a $platform build; build for a device or Any iOS Device" >&2
  exit 1
fi
codesign --verify --deep --strict "$app"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/Payload" "$work/check"
ditto "$app" "$work/Payload/$(basename "$app")"
rm -f "$out"
(cd "$work" && ditto -c -k --sequesterRsrc --keepParent Payload "$out")
ditto -x -k "$out" "$work/check"
codesign --verify --deep --strict "$work/check/Payload/$(basename "$app")"
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist")
echo "Packaged build $build: $out"
shasum -a 256 "$out"
