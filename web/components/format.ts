// Formatting for facts the system states about itself. Kept pure and shared so
// the same string appears on the server and after hydration.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "6h ago". Coarse on purpose — nobody triages by the minute. */
export function relativeTime(value: string | null): string {
  if (!value) return 'never';
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return 'unknown';

  const delta = Date.now() - then;
  if (delta < 0) return 'just now';
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 30 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  return `${Math.floor(delta / (30 * DAY))}mo ago`;
}

/** "2026-08-11 09:42Z" — the exact fact, for a title attribute. */
export function absoluteTime(value: string | null): string {
  if (!value) return 'never';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** The queue row title. Never invents text: falls back to what is actually known. */
export function suggestionTitle(s: {
  patternLabel: string | null;
  articleTitle: string | null;
  type: string;
}): string {
  return s.patternLabel ?? s.articleTitle ?? `Unlinked ${s.type} suggestion`;
}
