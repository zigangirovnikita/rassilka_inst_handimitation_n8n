# Instagram Agent n8n Executor

Локальное приложение для ручного n8n-сценария рассылки в Instagram. Приложение хранит отдельные Chrome-сессии Instagram, по расписанию запрашивает у n8n следующего получателя, открывает профиль, отправляет скриншот в n8n, получает текст сообщения, отправляет Direct и возвращает статус.

## Что умеет

- несколько Instagram профилей в одном приложении;
- отдельный webhook, лимит, интервал и рабочее окно для каждого профиля;
- фоновая отправка через отдельный Chrome-профиль без использования основного браузера;
- журнал действий внутри каждого аккаунта;
- таймаут ожидания n8n 3 минуты, чтобы зависшая задача не ломала следующие отправки;
- статус `Рассылка завершена`, когда n8n возвращает `no_task` или `completed`.

## Установка на Mac

1. Скачайте DMG из GitHub Releases.
2. Откройте DMG и перенесите `Instagram Agent n8n.app` в `Applications`.
3. Запустите приложение.
4. Нажмите `Добавить профиль`, войдите в Instagram в открывшемся Chrome и дождитесь, пока приложение определит username.
5. Вставьте webhook n8n, задайте лимиты и нажмите `Включить рассылку`.

Если DMG еще не загружен в Release, можно скачать репозиторий и запустить `installers/install-mac.command`.

## Установка на Windows

1. Установите Google Chrome.
2. Скачайте Windows x64 installer `.exe` из последнего GitHub Release. Для WebView2-исправления нужен файл `Instagram.Agent.n8n_0.2.1_x64-setup.exe` или новее.
3. Запустите installer. Если Windows покажет установку Microsoft Edge WebView2 Runtime, разрешите ее и дождитесь завершения.
4. Откройте `Instagram Agent n8n`.
5. Нажмите `Добавить профиль`, войдите в Instagram в открывшемся Chrome и дождитесь, пока приложение определит username.
6. Вставьте webhook n8n, задайте лимиты и нажмите `Включить рассылку`.

## Контракт webhook n8n

Все запросы идут методом `POST` в webhook, указанный в настройках профиля. Во всех событиях есть общие поля:

```json
{
  "event": "next_task",
  "workspace_id": "workspace_...",
  "instagram_profile_id": "igp_...",
  "app_profile_name": "account_name",
  "secret": "rassilka_...",
  "timestamp": "2026-08-28T12:00:00.000Z"
}
```

### `next_task`

Приложение спрашивает, кому писать следующим.

```json
{
  "event": "next_task",
  "sent_today": 4,
  "daily_limit": 30
}
```

n8n должен вернуть задачу:

```json
{
  "job_id": "unique-job-id",
  "target_username": "username"
}
```

`job_id` формирует n8n. Он должен быть уникальным в рамках профиля и получателя, чтобы приложение не отправило одну задачу повторно. Приложение доверяет `target_username`, валидирует его и само строит Instagram URL. `target_url` можно не отправлять.

Если получателей больше нет:

```json
{
  "status": "completed",
  "message": "Рассылка завершена"
}
```

или:

```json
{
  "no_task": true,
  "message": "Рассылка завершена"
}
```

### `profile_opened`

Приложение открыло профиль и отправляет скриншот.

```json
{
  "event": "profile_opened",
  "job_id": "unique-job-id",
  "target_username": "username",
  "target_url": "https://www.instagram.com/username/",
  "screenshot_base64": "...",
  "screenshot_mime": "image/png",
  "result": {
    "can_message": true,
    "is_private": false,
    "page_url": "https://www.instagram.com/username/"
  }
}
```

n8n должен вернуть текст:

```json
{
  "message_text": "Привет! ..."
}
```

### `sent`

Приложение подтвердило отправку в Instagram.

```json
{
  "event": "sent",
  "job_id": "unique-job-id",
  "target_username": "username",
  "target_url": "https://www.instagram.com/username/"
}
```

### `failed`

Задача не отправлена.

```json
{
  "event": "failed",
  "job_id": "unique-job-id",
  "target_username": "username",
  "target_url": "https://www.instagram.com/username/",
  "reason": "no_message_button",
  "error": "Кнопка сообщения недоступна"
}
```

Возможные `reason`: `no_message_button`, `login_required`, `profile_unavailable`, `message_text_empty`, `send_confirmation_missing`, `n8n_timeout`, `browser_error`.

События `no_message_button`, `profile_unavailable`, `message_text_empty`, `send_confirmation_missing` и timeout после получения конкретной задачи считаются пропуском лида, а не аварией аккаунта. `login_required` и признаки Instagram checkpoint/rate-limit останавливают конкретный аккаунт.

## Разработка

```bash
pnpm install
pnpm dev
```

Локальные адреса:

- frontend: `http://127.0.0.1:5173`
- backend: `http://127.0.0.1:8732`

Для теста на другом backend-порту можно запустить frontend так:

```bash
VITE_API_URL=http://127.0.0.1:18732 pnpm dev:frontend
```

Проверки:

```bash
pnpm check
pnpm test
pnpm build
pnpm prepare:desktop
pnpm exec tauri build --target aarch64-apple-darwin --bundles app
node scripts/package-mac-dmg.mjs
pnpm run build:windows
```
