#!/bin/bash
set -e

# Bump patch version
VERSION=$(node -e "const p=JSON.parse(require('fs').readFileSync('package.json','utf8'));const v=p.version.split('.');console.log(v[0]+'.'+v[1]+'.'+(+v[2]+1))")
bash bash-scripts/update_version.sh "$VERSION"

# Build
pnpm build

# Copy to wolffish-app (strip sourcemaps and dev artifacts)
TARGET="../wolffish-app/src/defaults/workspace/extension"
rm -rf "$TARGET"
mkdir -p "$TARGET"
rsync -a --exclude='*.map' --exclude='refresh.js' dist/ "$TARGET/"

# Commit, tag, and push
git add -A
git commit -m "release: v${VERSION}"
git tag "v${VERSION}"
git push && git push --tags

echo "Released v${VERSION}"
