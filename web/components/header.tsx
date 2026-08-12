import type { ReactNode } from 'react';
import { absoluteTime, plural, relativeTime } from './format';

/**
 * The thin header from DESIGN.md's shell diagram: title, pending count in mono,
 * last run, and one affordance on the right. Presentational only, so both the
 * server-rendered leaderboard and the client review pane can use it.
 *
 * `pending: null` means the count is unknown — when the database is unreachable
 * the header says nothing rather than claiming a confident zero.
 */
export default function Header({
  pending,
  lastRun,
  nav,
  children,
}: {
  pending: number | null;
  lastRun: string | null;
  /** The source filter. Sits on its own row so it reads as navigation, not as an affordance. */
  nav?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="dl-header">
      <span className="dl-title">Docloop</span>

      {pending !== null && (
        <>
          <p className="dl-mono text-muted min-w-0 truncate" suppressHydrationWarning>
            <span className="text-ink">{pending}</span> pending
            <span aria-hidden="true"> · </span>
            <span title={absoluteTime(lastRun)}>last run {relativeTime(lastRun)}</span>
          </p>
          <span className="sr-only">
            {pending} pending {plural(pending, 'suggestion')}
          </span>
        </>
      )}

      <div className="ml-auto flex items-center gap-2">{children}</div>
      {nav}
    </header>
  );
}
