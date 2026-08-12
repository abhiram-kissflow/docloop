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

create table if not exists suggestions (
  id         bigserial primary key,
  type       text not null check (type in ('update','create','media')),
  pattern_id bigint references patterns(id) on delete set null,
  article_id bigint references articles(id) on delete set null,
  body       text not null,
  status     text not null default 'pending'
             check (status in ('pending','approved','dismissed')),
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
