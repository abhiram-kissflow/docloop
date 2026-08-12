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
  select s.id, s.type, s.source, s.body, s.created_at,
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
  where s.status = 'pending' and ($1::text is null or s.source = $1::text)
  -- INTERLEAVED BY SOURCE, not newest-first. Recency is the wrong axis once producers have very
  -- different volumes: one push raises nine staleness rows at the same instant and buries
  -- everything older, including the single What's New draft — which is the most reviewable item
  -- in the queue. Ranking within each source and then taking rank 1 from every source, rank 2
  -- from every source, and so on means the top of the queue always shows what each producer
  -- found, and no producer can crowd out another by being noisy.
  order by row_number() over (partition by s.source order by s.created_at desc, s.id desc),
           s.created_at desc, s.id desc
  limit 200`;

// Counts for the nav. Computed over ALL pending rows, never the filtered set — a filter that
// changes the numbers beside the other filters makes the nav unreadable.
const BY_SOURCE_SQL = `
  select source, count(*)::int as n from suggestions where status='pending' group by source`;

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
export async function loadQueue(
  source: string | null = null,
): Promise<Loaded<{ suggestions: Suggestion[]; stats: Stats }>> {
  try {
    const [queue, stats, bySource] = await Promise.all([
      q<Record<string, unknown>>(QUEUE_SQL, [source]),
      q<Record<string, unknown>>(STATS_SQL),
      q<Record<string, unknown>>(BY_SOURCE_SQL),
    ]);

    const s = stats.rows[0] ?? {};
    return {
      data: {
        suggestions: queue.rows.map(
          (r): Suggestion => ({
            id: String(r.id),
            type: String(r.type ?? ''),
            source: String(r.source ?? 'mining'),
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
          bySource: Object.fromEntries(
            bySource.rows.map((r) => [String(r.source ?? 'mining'), num(r.n)]),
          ),
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
          // The leaderboard does not render the source nav, so it needs no per-source counts.
          bySource: {},
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
