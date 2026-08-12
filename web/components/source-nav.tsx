import Link from 'next/link';

/**
 * The top nav. Docloop now has three producers — ticket mining, code-change staleness and
 * release drafting — and until this existed the queue mixed all of them with no way to tell
 * them apart or look at one at a time. A reviewer judges them differently: "12 tickets ask
 * this" is a different claim from "a push touched code this documents", and a changelog draft
 * is a different job again.
 *
 * Server-rendered links, not client state: the filter belongs in the URL so a view is
 * shareable and the back button behaves. No JS needed to change it.
 *
 * Counts are of ALL pending rows, never the filtered set — numbers that move when you filter
 * make a nav unreadable.
 */

/**
 * Ordered deliberately: the biggest producer first, then by how directly a human acts on it.
 *
 * `command` is the worker that fills each source. It lives here, beside the label, because the
 * empty state needs it and the two must not drift: an empty Releases view that tells you to run
 * the MINING worker is worse than telling you nothing, and that is exactly what a single shared
 * WORKER_COMMAND constant produced.
 */
export const SOURCES: { key: string; label: string; hint: string; command: string }[] = [
  { key: 'mining', label: 'Tickets', hint: 'Raised from recurring support questions', command: 'node worker/index.mjs' },
  { key: 'staleness', label: 'Code changes', hint: 'Raised when a push touched documented code', command: 'node worker/staleness.mjs' },
  { key: 'release', label: 'Releases', hint: 'Raised when a release shipped something user-visible', command: 'node worker/newdoc.mjs' },
  { key: 'whatsnew', label: "What's New", hint: 'Drafted changelog entries awaiting review', command: 'node worker/whatsnew.mjs' },
];

/** The nav's own vocabulary, for anything that has to name a source outside the nav. */
export const sourceMeta = (key: string | null) => SOURCES.find((s) => s.key === key) ?? null;

export default function SourceNav({
  active,
  bySource,
}: {
  active: string | null;
  bySource: Record<string, number>;
}) {
  const total = Object.values(bySource).reduce((a, b) => a + b, 0);

  // A source with nothing pending still shows, greyed, rather than vanishing. A nav whose items
  // appear and disappear teaches nobody what the system does.
  const items = [
    { key: null as string | null, label: 'All', hint: 'Every pending suggestion', n: total },
    ...SOURCES.map((s) => ({ ...s, n: bySource[s.key] ?? 0 })),
  ];

  return (
    <nav className="dl-nav" aria-label="Filter the queue by where a suggestion came from">
      {items.map((item) => {
        const isActive = active === item.key;
        return (
          <Link
            key={item.key ?? 'all'}
            href={item.key ? `/?source=${item.key}` : '/'}
            aria-current={isActive ? 'page' : undefined}
            title={item.hint}
            className={`dl-nav-item${isActive ? ' is-active' : ''}${item.n === 0 ? ' is-empty' : ''}`}
          >
            {item.label}
            <span className="dl-mono dl-nav-count" aria-hidden="true">
              {item.n}
            </span>
            <span className="sr-only">, {item.n} pending</span>
          </Link>
        );
      })}
    </nav>
  );
}
