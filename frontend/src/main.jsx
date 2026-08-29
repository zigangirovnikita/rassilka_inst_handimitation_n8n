import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Save,
  Trash2
} from 'lucide-react';
import {
  createAccount,
  deleteAccount,
  listProfiles,
  reconnectAccount,
  saveExecutorSettings,
  startExecutor,
  stopExecutor
} from './api.js';
import './executor.css';

const STATUS_LABELS = {
  idle: 'Остановлен',
  waiting: 'Ждет',
  running: 'Работает',
  paused: 'Пауза',
  completed: 'Рассылка завершена'
};

function App() {
  const [profiles, setProfiles] = useState([]);
  const [openIds, setOpenIds] = useState(new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function refresh(silent = false) {
    try {
      const data = await listProfiles();
      setProfiles(data.profiles || []);
      setError('');
      if (!silent && data.profiles?.length) {
        setOpenIds(current => current.size ? current : new Set([data.profiles[0].instagramProfileId]));
      }
    } catch (err) {
      if (!silent) setError(err.message || String(err));
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(true), 3000);
    return () => clearInterval(timer);
  }, []);

  async function runAction(key, action) {
    setBusy(key);
    setError('');
    try {
      await action();
      await refresh(true);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy('');
    }
  }

  async function addProfile() {
    await runAction('create', async () => {
      const result = await createAccount();
      if (result.account?.instagramProfileId) {
        setOpenIds(current => new Set([...current, result.account.instagramProfileId]));
      }
    });
  }

  function toggleOpen(id) {
    setOpenIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Instagram Agent</h1>
          <p>Локальный исполнитель рассылок через n8n</p>
        </div>
        <button className="primary-btn" onClick={addProfile} disabled={Boolean(busy)}>
          {busy === 'create' ? <Loader2 className="spin" size={18} /> : <Plus size={18} />}
          Добавить профиль
        </button>
      </header>

      {error ? <div className="notice error">{error}</div> : null}

      <section className="profile-list">
        {!profiles.length ? (
          <div className="empty-state">
            <h2>Профилей пока нет</h2>
            <p>Добавьте Instagram профиль, затем вставьте webhook и включите рассылку.</p>
          </div>
        ) : profiles.map(profile => (
          <ProfileRow
            key={profile.instagramProfileId}
            profile={profile}
            open={openIds.has(profile.instagramProfileId)}
            busy={busy}
            onToggle={() => toggleOpen(profile.instagramProfileId)}
            onAction={runAction}
          />
        ))}
      </section>
    </main>
  );
}

function ProfileRow({ profile, open, busy, onToggle, onAction }) {
  const executor = profile.executor || {};
  const [draft, setDraft] = useState(() => settingsFromExecutor(executor));
  const keyPrefix = profile.instagramProfileId;

  useEffect(() => {
    setDraft(settingsFromExecutor(executor));
  }, [executor.webhookUrl, executor.dailyLimit, executor.minIntervalMinutes, executor.maxIntervalMinutes, executor.scheduleStart, executor.scheduleEnd]);

  const status = executor.status || 'idle';
  const connected = Boolean(profile.connected);
  const statusClass = connected ? 'connected' : 'disconnected';
  const nextRunText = useMemo(() => formatNextRun(executor.nextRunAt), [executor.nextRunAt]);

  function update(field, value) {
    setDraft(current => ({ ...current, [field]: value }));
  }

  async function save() {
    await onAction(`${keyPrefix}:save`, () => saveExecutorSettings(profile.instagramProfileId, draft));
  }

  async function start() {
    await onAction(`${keyPrefix}:start`, () => startExecutor(profile.instagramProfileId, draft));
  }

  async function stop() {
    await onAction(`${keyPrefix}:stop`, () => stopExecutor(profile.instagramProfileId));
  }

  async function reconnect() {
    await onAction(`${keyPrefix}:connect`, () => reconnectAccount(profile.instagramProfileId));
  }

  async function remove() {
    const username = profile.username ? `@${profile.username}` : 'этот профиль';
    if (!window.confirm(`Удалить ${username} из приложения? Сессия и настройки этого профиля будут удалены.`)) return;
    await onAction(`${keyPrefix}:delete`, () => deleteAccount(profile.instagramProfileId));
  }

  return (
    <article className={`profile-row ${open ? 'open' : ''}`}>
      <button className="profile-summary" onClick={onToggle}>
        {open ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
        <div className={`connect-dot ${statusClass}`}>
          {connected ? <CircleCheck size={18} /> : <CircleX size={18} />}
        </div>
        <div className="profile-title">
          <strong>{profile.username ? `@${profile.username}` : 'Профиль не подключен'}</strong>
          <span>{connected ? 'Подключен' : 'Не подключен'}</span>
        </div>
        <StatusPill status={status} enabled={executor.enabled} />
        <div className="profile-metrics">
          <span>{executor.sentToday || 0}/{executor.dailyLimit || draft.dailyLimit} сегодня</span>
          <span>{nextRunText}</span>
        </div>
      </button>

      {open ? (
        <div className="profile-details">
          <div className="settings-grid">
            <label className="field wide">
              <span>Webhook n8n</span>
              <input value={draft.webhookUrl} onChange={event => update('webhookUrl', event.target.value)} placeholder="https://..." />
            </label>
            <label className="field">
              <span>Лимит в день</span>
              <input type="number" min="1" max="100" value={draft.dailyLimit} onChange={event => update('dailyLimit', event.target.value)} />
            </label>
            <label className="field">
              <span>Интервал от, мин</span>
              <input type="number" min="1" max="240" value={draft.minIntervalMinutes} onChange={event => update('minIntervalMinutes', event.target.value)} />
            </label>
            <label className="field">
              <span>Интервал до, мин</span>
              <input type="number" min="1" max="360" value={draft.maxIntervalMinutes} onChange={event => update('maxIntervalMinutes', event.target.value)} />
            </label>
            <label className="field">
              <span>Начало по Москве</span>
              <input type="time" value={draft.scheduleStart} onChange={event => update('scheduleStart', event.target.value)} />
            </label>
            <label className="field">
              <span>Конец по Москве</span>
              <input type="time" value={draft.scheduleEnd} onChange={event => update('scheduleEnd', event.target.value)} />
            </label>
          </div>

          <div className="profile-actions">
            <button onClick={save} disabled={Boolean(busy)}>
              {busy === `${keyPrefix}:save` ? <Loader2 className="spin" size={17} /> : <Save size={17} />}
              Сохранить
            </button>
            {executor.enabled ? (
              <button className="danger-soft" onClick={stop} disabled={Boolean(busy)}>
                <Power size={17} />
                Выключить
              </button>
            ) : (
              <button className="success" onClick={start} disabled={!connected || Boolean(busy)}>
                <Power size={17} />
                Включить рассылку
              </button>
            )}
            <button onClick={reconnect} disabled={Boolean(busy)}>
              {busy === `${keyPrefix}:connect` ? <Loader2 className="spin" size={17} /> : <RefreshCw size={17} />}
              Переподключить
            </button>
            <button className="danger" onClick={remove} disabled={Boolean(busy)}>
              <Trash2 size={17} />
              Удалить
            </button>
          </div>

          <div className="runtime-line">
            <strong>{executor.step || 'Ожидает запуска'}</strong>
            {executor.lastError ? <span className="runtime-error">{executor.lastError}</span> : null}
          </div>

          <ActivityLog events={profile.events || []} />
        </div>
      ) : null}
    </article>
  );
}

function StatusPill({ status, enabled }) {
  const tone = status === 'completed' ? 'completed' : enabled ? status : 'idle';
  return <span className={`status-pill ${tone}`}>{STATUS_LABELS[status] || STATUS_LABELS.idle}</span>;
}

function ActivityLog({ events }) {
  return (
    <section className="activity-log">
      <h2>Журнал действий</h2>
      {!events.length ? (
        <p className="muted">Событий пока нет</p>
      ) : events.map(event => (
        <div className={`log-row ${event.level}`} key={event.id}>
          <time>{formatDate(event.createdAt)}</time>
          <span>{event.message}</span>
        </div>
      ))}
    </section>
  );
}

function settingsFromExecutor(executor) {
  return {
    webhookUrl: executor.webhookUrl || '',
    dailyLimit: executor.dailyLimit || 30,
    minIntervalMinutes: executor.minIntervalMinutes || 20,
    maxIntervalMinutes: executor.maxIntervalMinutes || 70,
    scheduleStart: executor.scheduleStart || '08:00',
    scheduleEnd: executor.scheduleEnd || '22:00'
  };
}

function formatDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function formatNextRun(value) {
  if (!value) return 'без таймера';
  return `следующее: ${formatDate(value)}`;
}

createRoot(document.getElementById('root')).render(<App />);
