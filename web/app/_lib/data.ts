import { q } from '@/lib/db';
import { EMPTY_STATS, type Pattern, type Stats, type Suggestion } from '@/components/types';

// Reads for the dashboard. The API routes are frozen by CONTRACT §3 and none of
// them serves this shape, so the server component reads the database directly
// rather than growing a route nobody else can use.
//
// Every query is wrapped: the page must render before Postgres is provisioned.

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const iso = (v: unknown): string | null => {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

// The queue plus everything needed to judge it: one round trip, so selecting a
// row costs no network at all.
const QUEUE_SQL = `
  select s.id, s.type, s.body, s.created_at,
         p.label       as pattern_label,
         p.description as pattern_description,
         p.ticket_count, p.question_count, p.last_seen,
         a.title as article_title, a.url as article_url,
         qn.questions
  from suggestions s
  left join patterns p on p.id = s.pattern_id
  left join articles a on a.id = s.article_id
  left join lateral (
    select questions from questionnaires
    where pattern_id = p.id order by created_at desc, id desc limit 1
  ) qn on true
  where s.status = 'pending'
  order by s.created_at desc, s.id desc
  limit 200`;

const STATS_SQL = `
  select
    (select count(*) from suggestions where status='pending')   as pending,
    (select count(*) from suggestions where status='approved')  as approved,
    (select count(*) from suggestions where status='dismissed') as dismissed,
    (select count(*) from patterns)                             as patterns,
    (select coalesce(sum(ticket_count), 0) from patterns)       as tickets,
    (select count(*) from questionnaires)                       as questionnaires,
    greatest(
      (select max(updated_at) from jobs where status in ('done','failed')),
      (select max(last_seen) from patterns)
    ) as last_run`;

const PATTERNS_SQL = `
  select p.id, p.label, p.description, p.ticket_count, p.question_count, p.last_seen,
         qn.questions
  from patterns p
  left join lateral (
    select questions from questionnaires
    where pattern_id = p.id order by created_at desc, id desc limit 1
  ) qn on true
  order by p.ticket_count desc, p.last_seen desc, p.id
  limit 100`;

export type Loaded<T> = { data: T; error: string | null };

/** The queue and the numbers above it. */
export async function loadQueue(): Promise<Loaded<{ suggestions: Suggestion[]; stats: Stats }>> {
  try {
    const [queue, stats] = await Promise.all([
      q<Record<string, unknown>>(QUEUE_SQL),
      q<Record<string, unknown>>(STATS_SQL),
    ]);

    const s = stats.rows[0] ?? {};
    return {
      data: {
        suggestions: queue.rows.map(
          (r): Suggestion => ({
            id: String(r.id),
            type: String(r.type ?? ''),
            body: String(r.body ?? ''),
            createdAt: iso(r.created_at) ?? '',
            patternLabel: r.pattern_label == null ? null : String(r.pattern_label),
            patternDescription:
              r.pattern_description == null ? null : String(r.pattern_description),
            patternLastSeen: iso(r.last_seen),
            ticketCount: r.ticket_count == null ? null : num(r.ticket_count),
            questionCount: r.question_count == null ? null : num(r.question_count),
            questions: strings(r.questions),
            articleTitle: r.article_title == null ? null : String(r.article_title),
            articleUrl: r.article_url == null ? null : String(r.article_url),
          }),
        ),
        stats: {
          pending: num(s.pending),
          approved: num(s.approved),
          dismissed: num(s.dismissed),
          patterns: num(s.patterns),
          tickets: num(s.tickets),
          questionnaires: num(s.questionnaires),
          lastRun: iso(s.last_run),
        },
      },
      error: null,
    };
  } catch (e) {
    return {
      data: { suggestions: [], stats: EMPTY_STATS },
      error: e instanceof Error ? e.message : 'unknown error',
    };
  }
}

/** The ranked leaderboard — the secondary, research-shaped view. */
export async function loadPatterns(): Promise<Loaded<{ patterns: Pattern[]; stats: Stats }>> {
  try {
    const [patterns, stats] = await Promise.all([
      q<Record<string, unknown>>(PATTERNS_SQL),
      q<Record<string, unknown>>(STATS_SQL),
    ]);

    const s = stats.rows[0] ?? {};
    return {
      data: {
        patterns: patterns.rows.map(
          (r): Pattern => ({
            id: String(r.id),
            label: String(r.label ?? ''),
            description: String(r.description ?? ''),
            ticketCount: num(r.ticket_count),
            questionCount: num(r.question_count),
            lastSeen: iso(r.last_seen) ?? '',
            questions: strings(r.questions),
          }),
        ),
        stats: {
          pending: num(s.pending),
          approved: num(s.approved),
          dismissed: num(s.dismissed),
          patterns: num(s.patterns),
          tickets: num(s.tickets),
          questionnaires: num(s.questionnaires),
          lastRun: iso(s.last_run),
        },
      },
      error: null,
    };
  } catch (e) {
    return {
      data: { patterns: [], stats: EMPTY_STATS },
      error: e instanceof Error ? e.message : 'unknown error',
    };
  }
}
