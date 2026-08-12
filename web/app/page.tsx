import { loadQueue } from './_lib/data';
import Review from '@/components/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The queue is the page. The pattern and its questionnaire are evidence for the
// decision in front of you, so they render in the right pane rather than as a
// competing section; the ranked leaderboard lives at /patterns.
// The ?source= filter lives in the URL rather than in client state: a filtered view is then
// shareable, the back button behaves, and it needs no JavaScript to change.
const SOURCES = new Set(['mining', 'staleness', 'release', 'whatsnew']);

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).source;
  const value = Array.isArray(raw) ? raw[0] : raw;
  // Allowlisted, not passed through: this reaches SQL as a parameter either way, but an unknown
  // value should show everything rather than silently filtering to nothing.
  const source = value && SOURCES.has(value) ? value : null;

  const { data, error } = await loadQueue(source);

  return (
    <Review
      suggestions={data.suggestions}
      stats={data.stats}
      dbError={error}
      activeSource={source}
    />
  );
}
