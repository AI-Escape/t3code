#!/bin/bash
# t4 fork dev helper: run server tests (or a command) in the Node 26 build container.
# usage: ./.t4-test.sh <vitest path filters...>   |   ./.t4-test.sh --cmd "<shell>"
if [ "$1" = "--cmd" ]; then shift; CMD="$*"; else CMD="pnpm exec vp test run $*"; fi
exec docker run --rm --user 1000:1000 -e HOME=/tmp/h -e CI=1 -e NO_COLOR=1 \
  -v "$(cd "$(dirname "$0")" && pwd)":/src -w /src/apps/server node:26-bookworm bash -c \
  "mkdir -p /tmp/h; npm install -g --prefix /tmp/h --silent pnpm@\$(node -p 'require(\"/src/package.json\").packageManager.split(\"@\")[1]') >/dev/null 2>&1; export PATH=/tmp/h/bin:\$PATH; $CMD"
