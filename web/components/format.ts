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

/**
 * The queue row title. Never invents text: falls back to what is actually known.
 *
 * The body fallback matters more than it looks. A What's New draft has no pattern and no linked
 * article, so it used to render as "Unlinked create suggestion" — hiding its actual headline
 * ("Introducing Editable Grid for Table Views") until you clicked it. The single most reviewable
 * row in the queue looked like a null.
 */
export function suggestionTitle(s: {
  patternLabel: string | null;
  articleTitle: string | null;
  body?: string;
  type: string;
}): string {
  return (
    s.patternLabel ?? s.articleTitle ?? firstHeading(s.body) ?? `Unlinked ${s.type} suggestion`
  );
}

/**
 * First markdown heading, or the value under a bold field label, if there is one.
 *
 * The field-label case is not hypothetical: a What's New draft is a list of `**hs_name:**` style
 * labels with the value on the NEXT line, so taking the bold text gave every such row the title
 * "hs_name:" — a field name where the actual headline should be. A bold lead that looks like a
 * key (ends in a colon, or is a single lower-case token) means the title is the line below it.
 */
function firstHeading(body?: string): string | null {
  if (!body) return null;
  const lines = body.split('\n', 24).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (!t) continue;

    const heading = /^#{1,4}\s+(.+)$/.exec(t);
    if (heading) return clip(heading[1]);

    const bold = /^\*\*(.+?)\*\*:?\s*$/.exec(t);
    if (bold) {
      const label = bold[1].trim();
      const looksLikeKey = label.endsWith(':') || /^[a-z][a-z0-9_]*$/.test(label);
      if (!looksLikeKey) return clip(label);
      // A label alone on a line: the value is the next non-empty line.
      const value = lines.slice(i + 1).find(Boolean);
      if (value) return clip(value.replace(/^\*\*|\*\*$/g, ''));
    }
  }
  return null;
}

const clip = (s: string) => s.trim().slice(0, 90);
