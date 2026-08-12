// Hairline-and-block placeholders in the shape of the finished layout, so the
// page does not reflow when the data lands. No centred spinner.
export default function Loading() {
  const rows = [0, 1, 2, 3, 4, 5, 6, 7];

  return (
    <div className="dl-app" aria-busy="true" aria-label="Loading the review queue">
      <header className="dl-header">
        <span className="dl-title">Docloop</span>
        <span className="dl-skel w-40" />
      </header>

      <div className="dl-panes" data-view="queue">
        <section className="dl-pane dl-pane--queue">
          <div className="dl-pane-head">
            <span className="dl-skel w-24" />
          </div>
          {rows.map((i) => (
            <div key={i} className="border-b border-line px-5 py-3">
              <span className="dl-skel w-3/5" />
              <span className="dl-skel mt-2 w-2/5" />
            </div>
          ))}
        </section>

        <section className="dl-pane dl-pane--evidence">
          <div className="dl-pane-head">
            <span className="dl-skel w-20" />
          </div>
          <div className="dl-pane-body dl-measure">
            <span className="dl-skel h-4 w-3/5" />
            <span className="dl-skel mt-8 w-full" />
            <span className="dl-skel mt-2 w-full" />
            <span className="dl-skel mt-2 w-4/5" />
            <span className="dl-skel mt-8 w-1/3" />
            <span className="dl-skel mt-4 w-full" />
            <span className="dl-skel mt-2 w-2/3" />
          </div>
        </section>
      </div>
    </div>
  );
}
