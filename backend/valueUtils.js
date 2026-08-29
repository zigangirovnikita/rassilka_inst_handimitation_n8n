export function stringValue(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return String(value).trim();
}

