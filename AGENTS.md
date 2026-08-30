# Project Instructions

This repository contains only the standalone Instagram Agent n8n Executor.

Do not copy, edit, or import the older `rassilka` product app into this repository. The older app has its own AGENTS.md and its own product scope. This repo is intentionally smaller: it is a local desktop executor that talks to a user-provided n8n webhook and performs browser actions through isolated Chrome profiles.

## Product Scope

- Manage multiple local Instagram Chrome sessions.
- Keep each Instagram profile isolated by `instagram_profile_id`.
- Store only local executor settings, jobs, events, and browser profiles.
- Ask n8n for the next task through one configured webhook per profile.
- Open the recipient profile, expand visible description when possible, capture a screenshot, send it to n8n, receive `message_text`, send the Instagram Direct message, then report `sent` or `failed`.
- Show profile connection state, mailing status, per-profile settings, and per-profile activity log.

## Out Of Scope

- Do not add the old product screens: base collection UI, template builder, Postgres base browser, campaign dashboard, local queue manager, or Meta/Apify settings.
- Do not commit runtime data, SQLite databases, Chrome profiles, logs, generated build output, `node_modules`, or Tauri target files.
- Do not put n8n URLs, Postgres credentials, server SSH keys, Instagram credentials, or user account data into source files.
- Do not create a second mailing path. The webhook contract is the integration boundary.

## Development

- Local frontend: `http://127.0.0.1:5173`
- Local backend: `http://127.0.0.1:8732`
- Main development command: `pnpm dev`
- Checks: `pnpm check`, `pnpm build`, `cargo check` from `src-tauri`
- Desktop runtime: `pnpm prepare:desktop`
- Mac app build: `pnpm exec tauri build --target aarch64-apple-darwin --bundles app`
- DMG package: `node scripts/package-mac-dmg.mjs`

## Code Rules

- Keep fixes targeted to the file that causes the bug.
- Prefer small modules over files larger than 400 lines.
- Do not rewrite whole files for narrow bugs.
- Read `docs/BUG_FIX_LOG.md` before changing behavior, storage, automation, account connection, deletion, worker timing, or packaging.
- Add a concise log entry when fixing a real bug, preventing a regression, or making a non-obvious integration decision.

## Critical Behavior

- Login Chrome must not refresh while the user is typing credentials. During login, open Instagram once and poll detection without repeated navigation.
- Do not persist an account draft until Instagram username is detected.
- Deleting an account must delete the account row, executor settings, jobs, events, and local Chrome profile directory.
- Delete must wait for the worker to stop before removing the Chrome profile directory.
- `job_id` comes from n8n and must be unique per profile task. The app uses it to avoid duplicate sending.
- Do not trust `target_url` from n8n for navigation. Validate `target_username` and build `https://www.instagram.com/{username}/` locally.
- A successful Instagram send must be marked `sent` locally before reporting status back to n8n. If the final report to n8n times out, keep local status as sent and log a warning.
- If a job reaches `sending` and then the app crashes/errors before confirmation, mark/recover it as `uncertain` and do not resend it automatically.
- If n8n returns `no_task`, `completed`, `done`, or `all_done`, disable the executor and show `Рассылка завершена`.
- Every n8n request has a 3 minute timeout. A timed-out task must not block the next scheduled run forever.
- Recognize Instagram message buttons in English and Russian, including `Message`, `Send message`, `Сообщение`, `Отправить сообщение`, and `Написать`.

## Webhook Contract

Use one POST webhook per Instagram profile. Branch inside n8n by the `event` field:

- `next_task`: app asks n8n for the next recipient.
- `profile_opened`: app sends screenshot and profile result.
- `sent`: app confirms message sent in Instagram.
- `failed`: app reports a skipped or failed recipient.
- `duplicate_job`: app saw an already-sent `job_id`.

The public README contains the user-facing payload examples. Keep README and implementation in sync when changing the contract.
