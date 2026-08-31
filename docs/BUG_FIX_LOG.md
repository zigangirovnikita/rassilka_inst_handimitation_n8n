# Bug Fix Log

This file records bugs and decisions for the standalone n8n Instagram executor.

## 2026-08-28 - Standalone N8N Executor Split

- Area: architecture/build
- Symptoms: The previous local outreach app had many product screens and local data paths that must not be included in the new public executor repository.
- Root cause: The n8n executor started as a simplified mode inside a larger app.
- Fix: Created a separate repository with only the multi-profile n8n executor, local backend, React control panel, Tauri wrapper, and Mac installer workflow.
- Files changed: all files in this repository.
- Verification: `pnpm check`, `pnpm build`, Tauri build, DMG verification.
- Do not regress: Do not copy old product screens, runtime databases, browser profiles, Postgres credentials, or old local app storage into this repo.

## 2026-08-28 - Login Refresh And Account Deletion Guardrails

- Area: automation/storage/frontend
- Symptoms: Chrome refreshed every few seconds during Instagram login; deleted or unconfirmed profiles could remain visible.
- Root cause: Detection navigated while the user was typing, and earlier drafts could be persisted before a confirmed login.
- Fix: Login opens Instagram once and polls without navigation; account drafts are saved only after a username is detected; deleting an account removes settings, jobs, events, and account row after UI confirmation.
- Files changed: `automation/instagramWorker.js`, `backend/profileStore.js`, `backend/server.js`, `frontend/src/main.jsx`.
- Verification: Syntax/build checks and manual login-flow code review.
- Do not regress: Do not call `page.goto()` repeatedly while the user is typing login credentials. Do not persist unconfirmed account drafts.

## 2026-08-28 - Sent Status And Completed Mailing

- Area: automation/storage/frontend
- Symptoms: A message could be sent in Instagram but shown as an error; when n8n had no more recipients the app did not show completion.
- Root cause: Local success depended too much on the final n8n report, and `no_task` responses were treated as temporary waiting.
- Fix: Mark a job sent immediately after Instagram send confirmation; n8n report failure becomes a warning only. `no_task`/`completed` responses disable the executor and show `Рассылка завершена`.
- Files changed: `automation/n8nExecutorWorker.js`, `automation/n8nExecutorResponse.js`, `frontend/src/main.jsx`.
- Verification: Syntax/build checks and worker-path review.
- Do not regress: A successful Instagram send must stay locally sent even if the status report webhook times out.

## 2026-08-29 - Safe API Port Override

- Area: frontend/development
- Symptoms: Local smoke tests could accidentally point the new frontend at another backend already running on `127.0.0.1:8731`.
- Root cause: The frontend API URL was hardcoded.
- Fix: Added `VITE_API_URL` override; the standalone production default is now `http://127.0.0.1:8732`.
- Files changed: `frontend/src/api.js`, `README.md`, `docs/BUG_FIX_LOG.md`.
- Verification: `pnpm check`, `pnpm build`, UI smoke test against a temporary backend port.
- Do not regress: Keep the installed app default on `8732`, but allow local tests to point at an isolated backend.

## 2026-08-29 - Distinct Mac App Name

- Area: packaging
- Symptoms: The standalone n8n executor used the same visible macOS app name as the older Instagram Agent app.
- Root cause: The initial split reused the old product name.
- Fix: Renamed the packaged app, window title, DMG volume, and installer filename to `Instagram Agent n8n`.
- Files changed: `src-tauri/tauri.conf.json`, `scripts/package-mac-dmg.mjs`, `README.md`, `docs/BUG_FIX_LOG.md`.
- Verification: Tauri build and DMG verification.
- Do not regress: Keep this app visibly distinct from the older `rassilka` application.

## 2026-08-29 - Dedicated Backend Port

- Area: backend/frontend/tauri
- Symptoms: The standalone executor could see an older app backend on `127.0.0.1:8731` and mistakenly treat it as its own backend.
- Root cause: The split reused the old backend port and the same health service marker.
- Fix: Moved this standalone app default backend port to `127.0.0.1:8732` in backend, frontend, and Tauri readiness checks.
- Files changed: `backend/server.js`, `frontend/src/api.js`, `src-tauri/src/backend_runtime.rs`, `README.md`, `docs/BUG_FIX_LOG.md`.
- Verification: `pnpm check`, `pnpm build`, `cargo check`, Tauri build, DMG verification.
- Do not regress: Do not move the standalone n8n executor back to `8731`; that port belongs to the older app.

## 2026-08-30 - Safety Audit Fixes

- Area: backend/frontend/automation/storage/tauri/tests/docs
- Symptoms: External audit found real risks: exposed local API, stop/delete races, duplicate sends after crash, reconnecting the wrong Instagram account, trusting `target_url`, treating bad leads as system failures, weak restriction/send detection, stale `AGENTS.md`, and no focused contract tests.
- Root cause: The first standalone release optimized for a small manual test and kept too much trust in local calls and n8n payloads.
- Fix: Added local API token and origin checks, including Tauri origins, hid executor secrets from profile listing, added Chrome preflight, made stop abort current n8n waits and check before Send, made delete wait for worker shutdown, blocked reconnect to a different username, blocked duplicate saved Instagram usernames, ignored n8n `target_url`, added `sending/uncertain`, deduped recent recipients, split lead/account/system failures, added Instagram restriction checks, improved send confirmation, changed Tauri shutdown to SIGTERM first and stop backend on window/app lifecycle exit, corrected `AGENTS.md` port, split oversized worker modules, and added focused tests.
- Files changed: `backend/apiSecurity.js`, `backend/server.js`, `backend/storage.js`, `backend/identity.js`, `backend/n8nExecutorStore.js`, `backend/profileStore.js`, `automation/instagramWorker.js`, `automation/n8nExecutorWorker.js`, `frontend/src/api.js`, `frontend/src/main.jsx`, `src-tauri/src/lib.rs`, `src-tauri/src/backend_runtime.rs`, `tests/executor-contract.test.js`, `AGENTS.md`, `README.md`, `docs/BUG_FIX_LOG.md`.
- Verification: `pnpm check`, `pnpm test`, `pnpm build`, `cargo check`, Tauri release build, DMG verification, installed app health/API check.
- Do not regress: Keep local API protected, never expose profile `secret`, never send after stop, never delete an active profile directory, never save one detected Instagram username as two local profiles, never navigate to untrusted `target_url`, and never auto-resend `sending/uncertain` jobs.

## 2026-08-30 - Tauri WebView API Load Failed

- Area: backend/security/desktop
- Symptoms: The installed macOS app showed `Load failed`, and `Добавить профиль` did not open the Instagram login flow.
- Root cause: The local API origin whitelist covered dev origins and `tauri://tauri.localhost`, but the production Tauri WebView can call the backend from `tauri://localhost`. The strengthened CORS/API protection rejected that origin before the frontend could obtain its local API token.
- Fix: Allowed both `tauri://localhost` and `tauri://tauri.localhost`, kept regular websites rejected, and added the private-network CORS header for local desktop requests.
- Files changed: `backend/apiSecurity.js`, `tests/executor-contract.test.js`, `docs/BUG_FIX_LOG.md`.
- Verification: `pnpm check`, `pnpm test`, `pnpm build`, installed app API checks for `tauri://localhost`, `tauri://tauri.localhost`, and `http://tauri.localhost`.
- Do not regress: Tauri production origins must be tested in addition to Node-based localhost smoke tests.

## 2026-08-31 - Windows Installer Support

- Area: desktop/packaging/automation
- Symptoms: The app only had a macOS install path and packaged a runtime binary named `node`, which does not work as the backend launcher on Windows.
- Root cause: The first release was built and smoke-tested only on macOS.
- Fix: Made desktop runtime preparation write `node.exe` on Windows, made the Tauri backend launcher choose `runtime/node.exe` on Windows, hid the backend console window, packaged the whole `desktop-runtime` directory, added Windows Chrome path checks, and added a Windows GitHub Actions NSIS installer workflow.
- Files changed: `scripts/prepare-desktop-runtime.mjs`, `src-tauri/src/backend_runtime.rs`, `src-tauri/tauri.conf.json`, `automation/instagramWorker.js`, `.github/workflows/windows-release.yml`, `package.json`, `README.md`, `AGENTS.md`, `installers/README.md`, `docs/BUG_FIX_LOG.md`.
- Verification: Local syntax/tests/build/Rust checks on macOS plus GitHub Actions Windows build for the actual installer.
- Do not regress: Do not hardcode the desktop runtime to macOS-only `runtime/node`; Windows release artifacts must be built on Windows.

## 2026-08-31 - Bundled Windows WebView2 Runtime

- Area: desktop/packaging/windows
- Symptoms: On a Windows machine without Microsoft Edge WebView2 Runtime, the installed app could start but fail before showing the UI.
- Root cause: The NSIS bundle relied on Tauri's default `downloadBootstrapper` WebView2 install mode; that is too fragile for home-use distribution where the target machine may lack WebView2 or may not complete the bootstrapper download/install.
- Fix: Explicitly set `bundle.windows.webviewInstallMode.type` to `offlineInstaller` so the Windows installer embeds the WebView2 installer and can install the UI runtime itself.
- Files changed: `src-tauri/tauri.conf.json`, `docs/BUG_FIX_LOG.md`.
- Verification: `pnpm check`, `pnpm test`, `pnpm build`, GitHub Actions Windows installer build.
- Do not regress: Keep Windows installer autonomous even if it makes the `.exe` much larger; do not switch back to `downloadBootstrapper` without a deliberate release decision.
