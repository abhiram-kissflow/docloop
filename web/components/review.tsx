'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Header from './header';
import SourceNav from './source-nav';
import { absoluteTime, plural, relativeTime, suggestionTitle } from './format';
import { WORKER_COMMAND, type Stats, type Suggestion } from './types';

type Decision = 'approved' | 'dismissed';

/** Only http(s) links are rendered as links. Article URLs arrive from ingested
 *  data, and `javascript:` in an href is a stored XSS with extra steps. */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Human label for a source value. The raw slugs are internal vocabulary, not reader-facing. */
function sourceLabel(source: string): string {
  if (source === 'mining') return 'ticket';
  if (source === 'staleness') return 'code change';
  if (source === 'release') return 'release';
  if (source === 'whatsnew') return "what's new";
  return source;
}

export default function Review({
  suggestions,
  stats,
  dbError,
  activeSource = null,
}: {
  suggestions: Suggestion[];
  stats: Stats;
  dbError: string | null;
  /** The ?source= filter in force, so the nav can mark the current view. */
  activeSource?: string | null;
}) {
  const router = useRouter();

  const [removed, setRemoved] = useState<string[]>([]);
  const [leaving, setLeaving] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(suggestions[0]?.id ?? null);
  const [busy, setBusy] = useState<Decision | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [view, setView] = useState<'queue' | 'evidence'>('queue');

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const helpButton = useRef<HTMLButtonElement>(null);
  const reduced = useRef(false);

  /** True only while the panes are stacked, where the evidence view covers the queue. */
  const isNarrow = () => window.matchMedia('(max-width: 899px)').matches;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    reduced.current = mq.matches;
    const onChange = () => {
      reduced.current = mq.matches;
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const rows = useMemo(
    () => suggestions.filter((s) => !removed.includes(s.id)),
    [suggestions, removed],
  );

  // Selection never falls into nothing while the queue still has work.
  useEffect(() => {
    if (rows.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (!rows.some((r) => r.id === selectedId)) setSelectedId(rows[0].id);
  }, [rows, selectedId]);

  const selected = rows.find((s) => s.id === selectedId) ?? null;
  // Live count. The query is capped, so anything the cap hid is added back —
  // and that overflow is recomputed on every refresh rather than accumulated.
  const overflow = Math.max(0, stats.pending - suggestions.length);
  const pending = rows.length + overflow;

  const select = useCallback((id: string, { focus = true } = {}) => {
    setSelectedId(id);
    setActionError(null);
    if (focus) {
      const el = rowRefs.current.get(id);
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    }
  }, []);

  /** Closing the overlay returns focus to the control that opened it, never to <body>. */
  const closeHelp = useCallback(() => {
    setHelpOpen(false);
    helpButton.current?.focus();
  }, []);

  /**
   * Leaving the evidence view on a narrow screen. The pane slides away, so
   * whatever was focused inside it is about to become invisible — focus lands on
   * the row it belongs to instead of being dropped.
   */
  const backToQueue = useCallback(() => {
    setView('queue');
    if (selectedId) rowRefs.current.get(selectedId)?.focus();
  }, [selectedId]);

  const move = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const index = rows.findIndex((r) => r.id === selectedId);
      const next = index === -1 ? 0 : Math.min(rows.length - 1, Math.max(0, index + delta));
      select(rows[next].id);
    },
    [rows, selectedId, select],
  );

  const decide = useCallback(
    async (status: Decision) => {
      const target = selected;
      // `leaving` also guards: the row stays selectable for 180ms while it
      // collapses, and a second keystroke must not decide it twice.
      if (!target || busy || leaving.includes(target.id)) return;

      setBusy(status);
      setActionError(null);
      try {
        const res = await fetch(`/api/suggestions/${target.id}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        if (res.status === 401) {
          router.push('/login');
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        setActionError(
          status === 'approved'
            ? 'Could not record the approval. The suggestion is unchanged.'
            : 'Could not record the dismissal. The suggestion is unchanged.',
        );
        setBusy(null);
        return;
      }

      // Focus goes to the next row, never to <body>.
      const index = rows.findIndex((r) => r.id === target.id);
      const next = rows[index + 1] ?? rows[index - 1] ?? null;

      setBusy(null);
      setLeaving((prev) => [...prev, target.id]);

      window.setTimeout(
        () => {
          setLeaving((prev) => prev.filter((id) => id !== target.id));
          setRemoved((prev) => [...prev, target.id]);
          // On a narrow screen the evidence pane is covering the queue, so the
          // row taking focus would be focused-but-hidden. The decision is made;
          // the queue is the page again, and the next row is visibly focused.
          if (isNarrow()) setView('queue');
          if (next) {
            setSelectedId(next.id);
            rowRefs.current.get(next.id)?.focus();
          } else {
            setSelectedId(null);
          }
          rowRefs.current.delete(target.id);
          router.refresh();
        },
        reduced.current ? 0 : 180,
      );
    },
    [selected, busy, leaving, rows, router],
  );

  // The whole triage path from the keyboard (DESIGN.md §Keyboard).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT');

      if (event.key === 'Escape') {
        if (helpOpen) setHelpOpen(false);
        else if (view === 'evidence') setView('queue');
        return;
      }

      // Typing 'a' in a text field must never approve anything.
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      // With the help overlay up, only '?' answers.
      if (helpOpen && event.key !== '?') return;

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          break;
        case 'k':
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          break;
        case 'a':
          event.preventDefault();
          void decide('approved');
          break;
        case 'd':
          event.preventDefault();
          void decide('dismissed');
          break;
        case 'g':
          event.preventDefault();
          router.push('/patterns');
          break;
        case '?':
          event.preventDefault();
          setHelpOpen((open) => !open);
          break;
        default:
          break;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [move, decide, router, helpOpen, view]);

  const help = (
    <button
      type="button"
      className="dl-btn dl-btn--quiet"
      aria-haspopup="dialog"
      aria-expanded={helpOpen}
      onClick={() => setHelpOpen((open) => !open)}
    >
      Keyboard
      <span className="dl-kbd" aria-hidden="true">
        ?
      </span>
    </button>
  );

  if (dbError) {
    return (
      <div className="dl-app">
        <Header pending={null} lastRun={null}>
          {help}
        </Header>
        <div className="dl-pane">
          <div className="dl-pane-body">
            <NoDatabase error={dbError} />
          </div>
        </div>
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="dl-app">
        <Header pending={0} lastRun={stats.lastRun} nav={<SourceNav active={activeSource} bySource={stats.bySource} />}>
          <Link className="dl-btn dl-btn--quiet" href="/patterns">
            Patterns
          </Link>
          {help}
        </Header>
        <div className="dl-pane">
          <div className="dl-pane-body">
            <QueueEmpty stats={stats} cleared={removed.length > 0} />
          </div>
        </div>
        {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
      </div>
    );
  }

  return (
    <div className="dl-app">
      <Header pending={pending} lastRun={stats.lastRun} nav={<SourceNav active={activeSource} bySource={stats.bySource} />}>
        <Link className="dl-btn dl-btn--quiet" href="/patterns">
          Patterns
        </Link>
        {help}
      </Header>

      <div className="dl-panes" data-view={view}>
        <section className="dl-pane dl-pane--queue" aria-label="Suggestion queue">
          <div className="dl-pane-head">
            <h2 className="text-xs font-semibold">Pending review</h2>
            <span className="dl-mono text-muted">{rows.length}</span>
          </div>

          <ul>
            {rows.map((s) => {
              const isSelected = s.id === selectedId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) rowRefs.current.set(s.id, el);
                      else rowRefs.current.delete(s.id);
                    }}
                    aria-current={isSelected}
                    className={`dl-row${leaving.includes(s.id) ? ' dl-row--leaving' : ''}`}
                    onClick={() => {
                      select(s.id, { focus: false });
                      setView('evidence');
                    }}
                  >
                    <span className="dl-row-title block truncate">{suggestionTitle(s)}</span>
                    <span className="dl-row-meta">
                      <span className={`dl-pill dl-pill--src dl-src-${s.source}`}>{sourceLabel(s.source)}</span>
                      <span className="dl-mono">{s.type}</span>
                      {s.ticketCount !== null && (
                        <span className="dl-mono">
                          {s.ticketCount} {plural(s.ticketCount, 'ticket')}
                        </span>
                      )}
                      <span className="dl-mono" title={absoluteTime(s.createdAt)} suppressHydrationWarning>
                        {relativeTime(s.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {rows.length >= 200 && (
            <p className="text-meta text-muted px-5 py-4">
              Showing the 200 most recent. Work the queue down to see the rest.
            </p>
          )}
        </section>

        <section className="dl-pane dl-pane--evidence" aria-label="Evidence">
          <div className="dl-pane-head">
            <button
              type="button"
              className="dl-btn dl-btn--quiet dl-back"
              onClick={() => setView('queue')}
            >
              Back to queue
            </button>
            <h2 className="text-xs font-semibold">Evidence</h2>
          </div>

          <div className="dl-pane-body">
            {selected ? (
              <Evidence
                suggestion={selected}
                busy={busy}
                error={actionError}
                onDecide={decide}
              />
            ) : (
              <p className="text-muted">Select a suggestion to read its evidence.</p>
            )}
          </div>
        </section>
      </div>

      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  );
}

function Evidence({
  suggestion,
  busy,
  error,
  onDecide,
}: {
  suggestion: Suggestion;
  busy: Decision | null;
  error: string | null;
  onDecide: (status: Decision) => void;
}) {
  const href = safeHref(suggestion.articleUrl);

  return (
    <article>
      <div className="dl-block">
        <h1 className="dl-measure text-lg">{suggestionTitle(suggestion)}</h1>
        <p className="dl-mono text-muted mt-2">
          {suggestion.type}
          <span aria-hidden="true"> · </span>
          <span title={absoluteTime(suggestion.createdAt)} suppressHydrationWarning>
            proposed {relativeTime(suggestion.createdAt)}
          </span>
        </p>
      </div>

      <div className="dl-block">
        {/* Machine-authored rule: the reader must always be able to tell model
            text from human text without being told. */}
        <p className="dl-machine">
          generated · worker run {absoluteTime(suggestion.createdAt)}
        </p>
        {/*
          These strings originate from public support tickets and are rendered as
          JSX text deliberately: React escapes them. Swapping in a markdown or
          HTML renderer would turn a stored <script> into live XSS.
          See BLUEPRINT.md §10.2 — ticket text is attacker-controlled and is
          data, never instruction.
        */}
        <p className="dl-prose dl-body mt-2">{suggestion.body}</p>
      </div>

      {(suggestion.patternLabel || suggestion.patternDescription) && (
        <div className="dl-block">
          <h2 className="dl-block-head">Pattern that produced it</h2>
          <p className="dl-prose mt-2 font-medium">{suggestion.patternLabel ?? 'Unnamed pattern'}</p>
          {suggestion.patternDescription && (
            <p className="dl-prose text-muted mt-2">{suggestion.patternDescription}</p>
          )}
          <p className="dl-mono text-muted mt-2">
            {suggestion.ticketCount ?? 0} {plural(suggestion.ticketCount ?? 0, 'ticket')}
            <span aria-hidden="true"> · </span>
            {suggestion.questionCount ?? 0} {plural(suggestion.questionCount ?? 0, 'question')}
            <span aria-hidden="true"> · </span>
            <span title={absoluteTime(suggestion.patternLastSeen)} suppressHydrationWarning>
              last seen {relativeTime(suggestion.patternLastSeen)}
            </span>
          </p>
        </div>
      )}

      {suggestion.questions.length > 0 && (
        <div className="dl-block">
          <h2 className="dl-block-head">The questions users actually ask</h2>
          <ol className="dl-prose mt-2 list-decimal pl-5">
            {suggestion.questions.map((question, i) => (
              <li key={i} className="mt-2 first:mt-0">
                {question}
              </li>
            ))}
          </ol>
        </div>
      )}

      {(suggestion.articleTitle || href) && (
        <div className="dl-block">
          <h2 className="dl-block-head">Article this touches</h2>
          <p className="dl-prose mt-2">
            {href ? (
              <a href={href} target="_blank" rel="noreferrer noopener" className="underline">
                {suggestion.articleTitle ?? href}
              </a>
            ) : (
              (suggestion.articleTitle ?? '')
            )}
          </p>
        </div>
      )}

      <div className="dl-decide">
        <button
          type="button"
          className="dl-btn dl-btn--primary"
          disabled={busy !== null}
          onClick={() => onDecide('approved')}
        >
          {busy === 'approved' ? 'Approving…' : 'Approve'}
          <span className="dl-kbd" aria-hidden="true">
            a
          </span>
        </button>
        <button
          type="button"
          className="dl-btn dl-btn--danger"
          disabled={busy !== null}
          onClick={() => onDecide('dismissed')}
        >
          {busy === 'dismissed' ? 'Dismissing…' : 'Dismiss'}
          <span className="dl-kbd" aria-hidden="true">
            d
          </span>
        </button>
        {error && (
          <span role="alert" className="text-sm text-danger-ink">
            {error}
          </span>
        )}
      </div>
    </article>
  );
}

function QueueEmpty({ stats, cleared }: { stats: Stats; cleared: boolean }) {
  // When the last row leaves there is no next row to take focus, so the heading
  // that replaced the queue takes it instead. Focus is never dropped to <body>.
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (cleared) heading.current?.focus();
  }, [cleared]);

  return (
    <section className="dl-prose">
      <h1 className="text-md" ref={heading} tabIndex={-1}>
        The queue is empty.
      </h1>
      <p className="text-muted mt-2">
        Every suggestion the worker has produced so far has been decided. Nothing publishes without
        passing through this screen, so there is nothing outstanding.
      </p>

      <dl className="mt-8 text-sm">
        <Fact
          term="Last worker run"
          value={`${relativeTime(stats.lastRun)} (${absoluteTime(stats.lastRun)})`}
        />
        <Fact term="Patterns on record" value={String(stats.patterns)} />
        <Fact term="Tickets clustered into them" value={String(stats.tickets)} />
        <Fact term="Questionnaires recorded" value={String(stats.questionnaires)} />
        <Fact
          term="Decided so far"
          value={`${stats.approved} approved · ${stats.dismissed} dismissed`}
        />
      </dl>

      <p className="text-muted mt-8">Run it again from the repository root:</p>
      <p className="dl-mono mt-2 inline-block rounded border border-line bg-surface px-2 py-1 text-ink">
        {WORKER_COMMAND}
      </p>
    </section>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-2 border-b border-line py-2">
      <dt className="text-muted min-w-56">{term}</dt>
      <dd className="dl-mono text-ink" suppressHydrationWarning>
        {value}
      </dd>
    </div>
  );
}

function NoDatabase({ error }: { error: string }) {
  return (
    <section className="dl-prose">
      <h1 className="text-md">The database is unreachable.</h1>
      <p className="mt-2">
        The dashboard is running, and the receiver endpoints still accept webhooks. It cannot read
        patterns, questionnaires, or the review queue until Postgres answers.
      </p>
      <ol className="mt-4 list-decimal pl-5">
        <li className="mt-2 first:mt-0">Provision Postgres and set DATABASE_URL in the environment.</li>
        <li className="mt-2">
          Apply <span className="dl-mono">web/schema.sql</span> to it.
        </li>
        <li className="mt-2">Reload this page.</li>
      </ol>
      <p className="dl-machine mt-8">reported by postgres</p>
      <p className="dl-mono text-muted mt-2">{error}</p>
    </section>
  );
}

const KEYS: Array<[string, string]> = [
  ['j  ↓', 'Next suggestion'],
  ['k  ↑', 'Previous suggestion'],
  ['a', 'Approve the selected suggestion'],
  ['d', 'Dismiss the selected suggestion'],
  ['g', 'Go to pattern leaderboard'],
  ['?', 'Keyboard help'],
  ['Esc', 'Close this / return to the queue'],
];

function HelpOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  return (
    <div
      className="dl-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
    >
      <div className="dl-overlay-card" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-baseline gap-2">
          <h2 className="text-md">Keyboard</h2>
          <button type="button" ref={closeRef} className="dl-btn dl-btn--quiet ml-auto" onClick={onClose}>
            Close
            <span className="dl-kbd" aria-hidden="true">
              Esc
            </span>
          </button>
        </div>
        <dl className="mt-4">
          {KEYS.map(([keys, action]) => (
            <div key={keys} className="flex items-center gap-4 border-t border-line py-2">
              <dt className="flex w-24 shrink-0 gap-2">
                {keys.split('  ').map((k) => (
                  <span key={k} className="dl-kbd">
                    {k}
                  </span>
                ))}
              </dt>
              <dd className="text-sm">{action}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
