import { loadQueue } from './_lib/data';
import Review from '@/components/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The queue is the page. The pattern and its questionnaire are evidence for the
// decision in front of you, so they render in the right pane rather than as a
// competing section; the ranked leaderboard lives at /patterns.
export default async function Page() {
  const { data, error } = await loadQueue();

  return <Review suggestions={data.suggestions} stats={data.stats} dbError={error} />;
}
