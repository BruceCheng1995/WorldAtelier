#!/usr/bin/env bash
# CI-only guest setup. The workflow owns this disposable WSL distribution.
set -euo pipefail
case "${1:-}" in
  install)
    export DEBIAN_FRONTEND=noninteractive
    printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
    chmod +x /usr/sbin/policy-rc.d
    apt-get update -qq
    apt-get install -y -qq docker.io docker-buildx docker-compose-v2 curl ca-certificates
    systemctl enable --now docker
    docker --version
    ;;
  build)
    for attempt in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 2; done
    docker info
    docker build --target verification -t worldatelier-verification:ci .
    docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges:true \
      --tmpfs /tmp:mode=1777 --tmpfs /app/.local:uid=1000,gid=1000,mode=0700 \
      --volume /data -e WORLD_ATELIER_TEST_EXECUTABLE_DIRECTORY=/data \
      -e WORLD_ATELIER_REQUIRE_LINUX_ISOLATION=1 worldatelier-verification:ci \
      --test tests/creation/linux-execution.test.mjs tests/creation/godot-diagnostics.test.mjs
    WORLD_ATELIER_PORT=48921 docker compose -p worldatelier-ci up -d --build --wait --wait-timeout 300
    ;;
  stop)
    WORLD_ATELIER_PORT=48921 docker compose -p worldatelier-ci logs --no-color || true
    WORLD_ATELIER_PORT=48921 docker compose -p worldatelier-ci down -v --remove-orphans || true
    ;;
  *) echo 'Usage: ci-wsl.sh install|build|stop' >&2; exit 2 ;;
esac
