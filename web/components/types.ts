// The view model the dashboard renders. Server components map database rows
// onto these; client components never see a pg row or a Date object.

export type Suggestion = {
  id: string;
  type: string;
  body: string;
  createdAt: string;
  patternLabel: string | null;
  patternDescription: string | null;
  patternLastSeen: string | null;
  ticketCount: number | null;
  questionCount: number | null;
  questions: string[];
  articleTitle: string | null;
  articleUrl: string | null;
};

export type Pattern = {
  id: string;
  label: string;
  description: string;
  ticketCount: number;
  questionCount: number;
  lastSeen: string;
  questions: string[];
};

/** Facts about the last worker run, shown in the header and the empty state. */
export type Stats = {
  pending: number;
  approved: number;
  dismissed: number;
  patterns: number;
  tickets: number;
  questionnaires: number;
  lastRun: string | null;
};

export const EMPTY_STATS: Stats = {
  pending: 0,
  approved: 0,
  dismissed: 0,
  patterns: 0,
  tickets: 0,
  questionnaires: 0,
  lastRun: null,
};

/** The command that produces everything on this screen. */
export const WORKER_COMMAND = 'node worker/index.mjs';
