import Link from 'next/link';
import { loadPatterns } from '../_lib/data';
import Header from '@/components/header';
import LeaderboardKeys from '@/components/leaderboard-keys';
import { absoluteTime, plural, relativeTime } from '@/components/format';
import { WORKER_COMMAND } from '@/components/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The secondary view. Ranked patterns matter when you are researching, and that
// is a different visit from working the queue — so it is a route of its own
// rather than a third section competing for the same screen.
export default async function PatternsPage() {
  const { data, error } = await loadPatterns();
  const { patterns, stats } = data;

  return (
    <div className="dl-app">
      <LeaderboardKeys />

      <Header pending={error ? null : stats.pending} lastRun={stats.lastRun}>
        <Link className="dl-btn dl-btn--quiet" href="/">
          Back to queue
          <span className="dl-kbd" aria-hidden="true">
            Esc
          </span>
        </Link>
      </Header>

      <div className="dl-pane">
        <div className="dl-pane-head">
          <h1 className="text-xs font-semibold">Patterns by ticket count</h1>
          <span className="dl-mono text-muted">{patterns.length}</span>
        </div>

        {error ? (
          <div className="dl-pane-body">
            <section className="dl-prose">
              <h2 className="text-md">The database is unreachable.</h2>
              <p className="mt-2">
                Provision Postgres, set DATABASE_URL, apply{' '}
                <span className="dl-mono">web/schema.sql</span>, and reload.
              </p>
              <p className="dl-machine mt-8">reported by postgres</p>
              <p className="dl-mono text-muted mt-2">{error}</p>
            </section>
          </div>
        ) : patterns.length === 0 ? (
          <div className="dl-pane-body">
            <section className="dl-prose">
              <h2 className="text-md">No patterns yet.</h2>
              <p className="text-muted mt-2">
                Patterns appear once the worker has clustered support conversations. It last ran{' '}
                <span suppressHydrationWarning>{relativeTime(stats.lastRun)}</span>.
              </p>
              <p className="text-muted mt-8">Run it from the repository root:</p>
              <p className="dl-mono mt-2 inline-block rounded border border-line bg-surface px-2 py-1 text-ink">
                {WORKER_COMMAND}
              </p>
            </section>
          </div>
        ) : (
          <ol>
            {patterns.map((p, i) => (
              <li key={p.id} className="flex gap-4 border-b border-line px-6 py-4">
                <span className="dl-mono text-muted w-6 shrink-0 pt-1">
                  {String(i + 1).padStart(2, '0')}
                </span>

                <div className="dl-measure min-w-0">
                  <h2 className="text-sm font-medium">{p.label}</h2>

                  {p.description && (
                    <p className="dl-prose text-muted mt-2">{p.description}</p>
                  )}

                  <p className="dl-mono text-muted mt-2">
                    {p.ticketCount} {plural(p.ticketCount, 'ticket')}
                    <span aria-hidden="true"> · </span>
                    {p.questionCount} {plural(p.questionCount, 'question')}
                    <span aria-hidden="true"> · </span>
                    <span title={absoluteTime(p.lastSeen)} suppressHydrationWarning>
                      last seen {relativeTime(p.lastSeen)}
                    </span>
                  </p>

                  {p.questions.length > 0 && (
                    <ol className="mt-4 list-decimal pl-5 text-sm">
                      {p.questions.map((question, qi) => (
                        <li key={qi} className="mt-2 first:mt-0">
                          {question}
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
