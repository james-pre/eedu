#!/bin/bash
# Generate TS types for Canvas

set -euo pipefail

script_dir="$(dirname "${BASH_SOURCE[0]}")"
root="$(realpath "$(dirname "$script_dir")")"

mkdir -p "$root/lib"
cd "$root/lib"
git clone https://github.com/instructure/canvas-lms
cd canvas-lms
bundle install
bundle exec rake doc:openapi
npx openapi-typescript public/doc/openapi/canvas.openapi.yaml -o "$root/lib/canvas.d.ts"
perl -0777 -pi -e 's{^\s*/\*.*?\*/}{}gms' "$root/lib/canvas.d.ts"
