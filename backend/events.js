export function nowIso() {
  return new Date().toISOString();
}

export function logEvent(db, instagramProfileId, level, message) {
  db.prepare(`
    INSERT INTO event_logs (instagram_profile_id, level, message, created_at)
    VALUES (?, ?, ?, ?)
  `).run(instagramProfileId || '', level, message, nowIso());
}
