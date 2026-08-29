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
- Fix: Added `VITE_API_URL` override while keeping `http://127.0.0.1:8731` as the production default.
- Files changed: `frontend/src/api.js`, `README.md`, `docs/BUG_FIX_LOG.md`.
- Verification: `pnpm check`, `pnpm build`, UI smoke test against a temporary backend port.
- Do not regress: Keep the installed app default on `8731`, but allow local tests to point at an isolated backend.

## 2026-08-29 - Distinct Mac App Name

- Area: packaging
- Symptoms: The standalone n8n executor used the same visible macOS app name as the older Instagram Agent app.
- Root cause: The initial split reused the old product name.
- Fix: Renamed the packaged app, window title, DMG volume, and installer filename to `Instagram Agent n8n`.
- Files changed: `src-tauri/tauri.conf.json`, `scripts/package-mac-dmg.mjs`, `README.md`, `docs/BUG_FIX_LOG.md`.
- Verification: Tauri build and DMG verification.
- Do not regress: Keep this app visibly distinct from the older `rassilka` application.
