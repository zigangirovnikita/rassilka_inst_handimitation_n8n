#!/bin/zsh
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm не найден. Установите pnpm и повторите запуск."
  exit 1
fi

if ! command -v cargo >/dev/null 2>&1; then
  echo "Rust/Cargo не найден. Установите Rust и повторите запуск."
  exit 1
fi

pnpm install --prefer-offline
pnpm exec tauri build --target aarch64-apple-darwin --bundles app

APP_SOURCE="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Instagram Agent n8n.app"
APP_TARGET="/Applications/Instagram Agent n8n.app"

if [ -d "$APP_TARGET" ]; then
  rm -rf "$APP_TARGET"
fi

cp -R "$APP_SOURCE" "$APP_TARGET"
echo "Instagram Agent n8n установлен в Applications."
