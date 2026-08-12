'use client';

// Unhandled failures. Database trouble is caught in the loader and rendered as
// the no-database panel; this is the boundary for everything else.
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="dl-app">
      <header className="dl-header">
        <span className="dl-title">Docloop</span>
      </header>
      <div className="dl-pane">
        <div className="dl-pane-body">
          <section className="dl-prose">
            <h1 className="text-md">The dashboard could not render.</h1>
            <p className="mt-2">
              Nothing was approved or dismissed. Try again; if it keeps failing, the detail below
              identifies the request in the server logs.
            </p>
            <p className="dl-machine mt-8">reported by the server</p>
            <p className="dl-mono text-muted mt-2">{error.digest ?? error.message}</p>
            <p className="mt-8">
              <button type="button" className="dl-btn dl-btn--ghost" onClick={reset}>
                Try again
              </button>
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
