#!/usr/bin/env bash
# Install the packed DSH Work tarballs into a profile.
#
# Usage:
#   DSH_HOME=/path/to/home ./scripts/install-work-profile.sh <profile> <dist-dir>
#
# The script initializes the profile, allowlists the koffi build that pnpm
# otherwise refuses on a clean profile, installs the five tarballs, and
# appends the bundle layer (the desktop CLI does not append it for file specs).
set -euo pipefail

PROFILE="${1:-work}"
DIST="${2:-dist}"
DSH_BIN="${DSH_BIN:-dsh}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

echo "profile: $PROFILE"
echo "home:    $DSH_HOME"
echo "dist:    $DIST"

# 1. Initialize the profile. A clean profile can trip pnpm's ignored-build
#    guard on koffi; the dependencies are still written, so continue.
"$DSH_BIN" plugin --profile "$PROFILE" add @deepseek-ai/dsh-web-app@0.2.2-rc.2 || true

# 2. Allow the koffi postinstall before retrying.
if [ -f "$PROFILE_DIR/pnpm-workspace.yaml" ]; then
  if ! grep -q '^allowBuilds:' "$PROFILE_DIR/pnpm-workspace.yaml"; then
    printf '\nallowBuilds:\n  koffi: true\n' >> "$PROFILE_DIR/pnpm-workspace.yaml"
  fi
fi

# 3. Install the bundle and its plugin packages.
"$DSH_BIN" plugin --profile "$PROFILE" add \
  @deepseek-ai/dsh-web-app@0.2.2-rc.2 \
  "$DIST/dsh-work-bundle-0.1.0.tgz" \
  "$DIST/dsh-work-host-0.1.0.tgz" \
  "$DIST/dsh-work-feishu-0.1.0.tgz" \
  "$DIST/dsh-work-client-0.1.0.tgz" \
  "$DIST/dsh-work-skills-0.1.0.tgz"

# 4. Ensure the bundle layer is present (file specs are installed as plain
#    dependencies by the current desktop CLI).
node - "$PROFILE_DIR/package.json" <<'NODE'
const fs = require('node:fs')
const file = process.argv[2]
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
manifest.dsh ??= { profile: { bundles: [] } }
manifest.dsh.profile ??= { bundles: [] }
const bundles = manifest.dsh.profile.bundles ??= []
const ordered = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@dsh-work-plug/bundle']
const rest = bundles.filter((name) => !ordered.includes(name))
manifest.dsh.profile.bundles = [...ordered, ...rest]
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
NODE

echo
echo "installed. start with:"
echo "  DSH_HOME=\"$DSH_HOME\" $DSH_BIN --profile $PROFILE --no-open"
