import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { classifyNextTaskResponse } from '../automation/n8nExecutorResponse.js';
import { isMessageButtonLabel } from '../automation/n8nExecutorWorker.js';
import { initDatabase } from '../backend/storage.js';
import { findAccountByUsername, upsertAccount } from '../backend/profileStore.js';
import { isAllowedOrigin } from '../backend/apiSecurity.js';
import {
  ensureExecutorProfile,
  getExecutorJob,
  listExecutorProfiles,
  upsertExecutorJob
} from '../backend/n8nExecutorStore.js';

test('classifies completed/no-task responses as completed', () => {
  assert.equal(classifyNextTaskResponse({ no_task: true }), 'completed');
  assert.equal(classifyNextTaskResponse({ status: 'completed' }), 'completed');
  assert.equal(classifyNextTaskResponse({ status: 'waiting', no_task: true }), 'waiting');
});

test('recognizes expected Instagram message button labels', () => {
  for (const label of ['Message', 'Send message', 'Сообщение', 'Отправить сообщение', 'Написать']) {
    assert.equal(isMessageButtonLabel(label), true, label);
  }
  assert.equal(isMessageButtonLabel('Follow'), false);
});

test('allows local Tauri origins and rejects regular websites', () => {
  assert.equal(isAllowedOrigin('tauri.localhost'), true);
  assert.equal(isAllowedOrigin('tauri://localhost'), true);
  assert.equal(isAllowedOrigin('tauri://tauri.localhost'), true);
  assert.equal(isAllowedOrigin('http://tauri.localhost'), true);
  assert.equal(isAllowedOrigin('https://example.com'), false);
});

test('does not expose executor secret in profile list', () => {
  const { db, cleanup } = makeDb();
  try {
    upsertAccount(db, {
      instagramProfileId: 'igp_test_secret',
      username: 'test_account',
      profileDir: '/tmp/igp_test_secret',
      connected: true
    });
    ensureExecutorProfile(db, 'igp_test_secret');
    const [profile] = listExecutorProfiles(db);
    assert.equal(profile.executor.secret, undefined);
    assert.equal(Boolean(profile.executor.webhookUrl), false);
  } finally {
    cleanup();
  }
});

test('finds existing Instagram account by normalized username', () => {
  const { db, cleanup } = makeDb();
  try {
    upsertAccount(db, {
      instagramProfileId: 'igp_test_duplicate',
      username: 'Sender.Account',
      profileDir: '/tmp/igp_test_duplicate',
      connected: true
    });
    const existing = findAccountByUsername(db, '@sender.account');
    assert.equal(existing.instagramProfileId, 'igp_test_duplicate');
  } finally {
    cleanup();
  }
});

test('builds target URL from username instead of trusting n8n target_url', () => {
  const { db, cleanup } = makeDb();
  try {
    upsertAccount(db, {
      instagramProfileId: 'igp_test_target',
      username: 'sender',
      profileDir: '/tmp/igp_test_target',
      connected: true
    });
    const job = upsertExecutorJob(db, 'igp_test_target', {
      job_id: 'job_1',
      target_username: 'real_user',
      target_url: 'https://example.com/wrong'
    });
    assert.equal(job.targetUrl, 'https://www.instagram.com/real_user/');
    assert.equal(getExecutorJob(db, 'igp_test_target', 'job_1').targetUsername, 'real_user');
  } finally {
    cleanup();
  }
});

function makeDb() {
  const root = mkdtempSync('/tmp/instagram-agent-n8n-test-');
  const db = initDatabase(join(root, 'storage', 'agent.sqlite'));
  return {
    db,
    cleanup() {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  };
}
