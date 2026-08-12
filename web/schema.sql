create table if not exists events (
  id          bigserial primary key,
  source      text not null check (source in ('github','intercom','generic')),
  type        text not null,
  payload     jsonb not null,
  received_at timestamptz not null default now()
);

create table if not exists patterns (
  id             bigserial primary key,
  label          text not null unique,
  description    text not null default '',
  question_count integer not null default 0,
  ticket_count   integer not null default 0,
  last_seen      timestamptz not null default now()
);

create table if not exists questionnaires (
  id         bigserial primary key,
  pattern_id bigint not null references patterns(id) on delete cascade,
  questions  jsonb not null,            -- string[]
  created_at timestamptz not null default now()
);

create table if not exists articles (
  id          bigserial primary key,
  external_id text unique,
  title       text not null,
  url         text,
  platform    text,
  features    jsonb not null default '[]'::jsonb
);

-- Article TEXT, added once a real export existed. Until this, the index knew that an article
-- existed and what area it covered, but not a word of what it said — which is why B1 could only
-- ever say "may be affected", why B2 was unbuildable (you cannot replay steps you cannot read),
-- and why C chose create-vs-update on titles alone.
--
-- `body` is NOT subject to the §6.1 scrub, and that is deliberate. §6 governs ticket-derived
-- text: attacker-influenced, customer-bearing, never published. An article is the opposite —
-- authored by the documentation team, reviewed, and already public. Scrubbing it would delete
-- legitimate documentation: 42 of 646 articles trip the guard, and every hit is the docs' own
-- example content (a support address inside an email-configuration walkthrough, code samples
-- containing URLs, a regex example, plan tables reading as digit runs).
--
-- `doc_updated_at` comes from the source system, not from us: it is when the WRITER last touched
-- the article, which is the only half of a staleness comparison we could not previously see.
alter table articles add column if not exists body           text;
alter table articles add column if not exists category       text;
alter table articles add column if not exists doc_updated_at timestamptz;
alter table articles add column if not exists imported_at    timestamptz;

-- Staleness asks "which articles cover this area and when were they last written", so the index
-- is on the pair rather than either alone.
create index if not exists articles_category_idx on articles (category, doc_updated_at desc);

create table if not exists suggestions (
  id         bigserial primary key,
  type       text not null check (type in ('update','create','media')),
  pattern_id bigint references patterns(id) on delete set null,
  article_id bigint references articles(id) on delete set null,
  body       text not null,
  status     text not null default 'pending'
             check (status in ('pending','approved','dismissed')),
  -- Where this came from: which workstream raised it. The queue mixes ticket-mined suggestions
  -- with code-change and release-driven ones, and a reviewer judges them differently — "12 tickets
  -- ask this" is a different claim from "a push touched code this documents".
  source     text not null default 'mining',
  created_at timestamptz not null default now()
);

create table if not exists jobs (
  id         bigserial primary key,
  kind       text not null,
  payload    jsonb not null default '{}'::jsonb,
  status     text not null default 'pending'
             check (status in ('pending','running','done','failed')),
  result     jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists jobs_pending_idx on jobs (status, id);
create index if not exists suggestions_status_idx on suggestions (status, created_at desc);
create index if not exists events_received_idx on events (received_at desc);
