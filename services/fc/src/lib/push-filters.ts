// services/fc/src/lib/push-filters.ts
// Pure helpers used by push-dispatch. No I/O.

export function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

export function isForegroundDevice(presence, deviceId) {
  if (!Array.isArray(presence)) return false;
  return presence.some(p => p.device_id === deviceId);
}

// Returns true if `now` is inside the DnD window for the user's tz.
// dnd_start_min / dnd_end_min are local-minute-of-day (0..1439).
export function inDnd(prefs, now = new Date()) {
  if (prefs == null) return false;
  if (prefs.dnd_start_min == null || prefs.dnd_end_min == null) return false;
  const tz = prefs.dnd_tz || 'Asia/Shanghai';
  const localMin = minutesInTz(now, tz);
  const a = prefs.dnd_start_min, b = prefs.dnd_end_min;
  if (a === b) return false;
  if (a < b) return localMin >= a && localMin < b;
  // cross-midnight
  return localMin >= a || localMin < b;
}

function minutesInTz(date, tz) {
  // Use Intl.DateTimeFormat with timeZone to compute h:m in target tz.
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  const h = Number(parts.find(p => p.type === 'hour').value);
  const m = Number(parts.find(p => p.type === 'minute').value);
  return h * 60 + m;
}
