# Design

Visual system for the Docloop dashboard. Read alongside [PRODUCT.md](./PRODUCT.md), which owns
who this is for and why. This file owns how it looks.

## Theme

Light only, fully resolved. Every token below is a semantic name, so a dark theme later is a value
swap rather than a rewrite — but no dark values are defined or half-supported today.

**Scene it is designed for:** a bright room, mid-morning, twenty focused minutes spent working a
review queue to empty and closing the tab.

**Mood:** code review at 9am. The machine proposes, the human decides, and the evidence sits one
keystroke away. This is deliberately not a newsroom and not an analytics console — the nearest
honest analog to this screen is a diff review, and it should carry that posture: dense, calm,
decision-shaped.

**Color strategy:** Restrained. Neutrals carry the surface; the brand violet appears only on the
selected row, the primary action, and focus. Status is carried by pale tinted fills with dark
text, never by saturated blobs.

## Color

OKLCH throughout. No hex anywhere in the codebase.

```css
:root {
  /* Surface */
  --bg:            oklch(1 0 0);              /* pure white — the mood lives in type and brand, not the paper */
  --surface:       oklch(0.972 0.004 280);    /* panels, the evidence rail, table headers */
  --line:          oklch(0.905 0.006 280);    /* hairlines, row dividers */
  --line-strong:   oklch(0.820 0.008 280);    /* input borders, focused container edges */

  /* Text */
  --ink:           oklch(0.220 0.020 280);    /* body and headings — 13.6:1 on --bg */
  --muted:         oklch(0.480 0.015 280);    /* secondary text, meta — 4.9:1 on --bg */

  /* Brand */
  --primary:       oklch(0.420 0.140 282);    /* selected row, primary action, focus ring */
  --primary-hover: oklch(0.370 0.145 282);
  --primary-tint:  oklch(0.965 0.020 282);    /* selected-row background wash */
  --on-primary:    oklch(1 0 0);              /* white text on primary — 5.9:1 */

  /* Accent — signal, not decoration */
  --accent:        oklch(0.620 0.170 45);     /* marks, dots, rules. Never carries small text. */
  --accent-ink:    oklch(0.440 0.130 45);     /* text on --accent-tint */
  --accent-tint:   oklch(0.955 0.030 60);

  /* Semantic state */
  --ok-ink:        oklch(0.420 0.110 152);
  --ok-tint:       oklch(0.955 0.030 152);
  --danger-ink:    oklch(0.450 0.170 25);
  --danger-tint:   oklch(0.960 0.025 25);

  --focus:         var(--primary);
}
```

**Why violet, given that AI-purple-on-white is a saturated cliché.** The brand seed landed on hue
280. Rather than take the obvious mid-lightness violet, primary sits at L 0.42 — dark enough to
read as ink with intent rather than as a product-tour highlight — and it is used on well under
10% of the surface. The identity is carried by typography and layout; the violet only ever marks
*where you are* and *what the primary action is*.

**Status pills use pale tint plus dark text, never saturated fills.** A saturated pill at this size
cannot hold AA-contrast small text, and a queue full of colored blobs reads as an alert dashboard
rather than a work list.

### Contrast floors (verified, not assumed)

| Pair | Ratio | Requirement |
|---|---|---|
| `--ink` on `--bg` | ~13.6:1 | AA body (4.5) |
| `--muted` on `--bg` | ~4.9:1 | AA body (4.5) — muted is still real text |
| `--on-primary` on `--primary` | ~5.9:1 | AA body |
| `--accent-ink` on `--accent-tint` | ~7.1:1 | AA body |
| `--ok-ink` on `--ok-tint` | ~7.4:1 | AA body |
| `--danger-ink` on `--danger-tint` | ~6.8:1 | AA body |
| `--line` on `--bg` | ~1.3:1 | decorative hairline, not an affordance boundary |

Placeholder text uses `--muted`, not a lighter gray. Disabled controls drop opacity on the whole
control, never the text color alone.

## Typography

**IBM Plex Sans** for everything a human reads as language. **IBM Plex Mono** for machine facts —
counts, IDs, timestamps, source tags, code paths. Both loaded via `next/font/google` with
`display: swap`, self-hosted by Next at build time. Two members of one superfamily: a real contrast
axis without the mismatch of pairing two unrelated faces.

The split is meaning, not decoration. It is the visual form of the "machine proposes, human
decides" principle — mono is how the system states a fact about itself, sans is how anyone makes
an argument. Model-authored prose (suggestion bodies) stays in sans, because it is prose, and is
marked as machine-authored by a labelled rule above it rather than by a font change.

Fixed rem scale, ratio ≈1.2. No `clamp()` — product UI at consistent DPI does not want fluid type.

```css
--t-meta:  0.75rem;    /* 12px — mono: counts, ids, timestamps */
--t-xs:    0.8125rem;  /* 13px — labels, table headers */
--t-sm:    0.9375rem;  /* 15px — dense UI body, list rows */
--t-base:  1rem;       /* 16px — prose: suggestion bodies, questionnaire questions */
--t-md:    1.1875rem;  /* 19px — section headings */
--t-lg:    1.5rem;     /* 24px — page title */
```

Weights: 400 body, 500 UI labels and buttons, 600 headings. No weight above 600 — this interface
never shouts.

Prose columns cap at 68ch. Table and list rows may run denser. `text-wrap: balance` on headings,
`text-wrap: pretty` on suggestion bodies.

**No all-caps tracked eyebrows.** Section identity comes from position, weight, and a hairline —
not from a tiny tracked kicker over every block.

## Layout

The queue is the page. The pattern leaderboard and questionnaires are *evidence for the decision
in front of you*, not separate destinations — so they do not get their own equal-weight sections
competing for attention.

**Two-pane review shell**, the shape of every tool built for working through a list:

```
┌──────────────────────────────────────────────────────────┐
│ Docloop            18 pending · last run 6h ago      [?] │  thin header, --line bottom
├────────────────────┬─────────────────────────────────────┤
│ QUEUE (420px)      │ EVIDENCE (fluid, max 68ch prose)    │
│                    │                                     │
│ ▸ suggestion row   │  The suggestion body                │
│   suggestion row   │  ── machine-authored ──             │
│   suggestion row   │                                     │
│   …                │  Pattern that produced it           │
│                    │  · ticket count, last seen (mono)   │
│                    │  · the questions users actually ask │
│                    │                                     │
│                    │  [ Approve ]  [ Dismiss ]           │
└────────────────────┴─────────────────────────────────────┘
```

- Grid for the two-pane shell, flex inside each pane. Independent scroll per pane.
- **No card grid.** Rows are separated by hairlines, not boxes. Nested cards are never used.
- **No hero metrics.** Counts live inline in the header and beside pattern names, in mono, at
  `--t-meta`. A number is a fact, not a feature.
- The pattern leaderboard is reachable as a secondary view, not a competing top section — the
  ranked list of patterns matters when you are *researching*, and that is a different visit.
- Spacing rhythm varies deliberately: 8px inside a row, 16px between row groups, 32px between
  evidence blocks, 48px above the decision buttons so the commit action has air around it.

**Responsive is structural.** Below 900px the two panes become one: the queue is the page, and
selecting a row pushes the evidence view over it with a back affordance. Type sizes do not change.

**z-index scale** (semantic, never arbitrary): `--z-sticky: 10`, `--z-dropdown: 20`,
`--z-overlay: 30`, `--z-toast: 40`.

### Corner radius

Four named steps. Radius was the last axis in the stylesheet still written as raw pixels, and it
had drifted to five values — 3, 4, 6, 8 and 999 — across seven rules. Three and four pixels apart
is not a decision anyone made; it is what happens when each rule picks its own number.

```css
--radius-sm:   4px;   /* skeletons, keycaps — things smaller than a button */
--radius-md:   6px;   /* buttons, inputs, nav items — the default */
--radius-lg:   8px;   /* overlays and raised panels */
--radius-pill: 999px; /* status pills only */
```

A fifth step is not a new decision to make — it is evidence the scale is being avoided.

## Components

Every interactive component ships default, hover, focus-visible, active, disabled, loading, and
error. Half a set is not a set.

- **Queue row** — title, status pill, mono ticket count, relative timestamp. States: default,
  hover (`--surface`), selected (`--primary-tint` plus a 2px `--primary` left marker on the
  *selected* row only — this is a position indicator, not a decorative side-stripe on every card),
  focus-visible, leaving (on approve/dismiss).
- **Button** — one shape across the whole surface. Primary (filled `--primary`), ghost (text plus
  hairline), danger (text `--danger-ink`, hairline, tint on hover). Never more than one primary
  button in view.
- **Status pill** — tint fill, dark ink text, no border, no icon. `pending` → accent,
  `approved` → ok, `dismissed` → neutral `--surface` + `--muted`.
- **Machine-authored rule** — a hairline with a small mono label (`generated · <model run>`) above
  any block of model-written prose. This is how the reader always knows who wrote what.
- **Empty state** — teaches, does not congratulate. When the queue is clear it states when the
  worker last ran, how many conversations it read, how many patterns it found, and the exact
  command to run it again. No illustration, no emoji, no confetti.
- **Error / no-database state** — the dashboard must render before Postgres exists. A plain panel
  naming what is unreachable and what to do, in the same edited voice as everything else.
- **Skeleton** — hairline-and-block placeholders matching final layout. No centered spinners.
- **Keyboard hints** — `kbd` styled as mono on `--surface` with a hairline. Shown in a `?` overlay,
  not permanently.

## Motion

150–200ms, `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quart). No bounce, no elastic, no
orchestrated page-load sequence — this loads into a task.

Motion is only ever state:

- Row leaves the queue on approve/dismiss: 180ms opacity and height collapse. Animating height is
  a layout property and normally avoided; here the list closing over a completed decision *is* the
  feedback, and nothing else conveys it as well.
- Selection change is instant. Zero delay between keystroke and evidence.
- Pane push on narrow screens: 200ms transform.
- Hover and focus transitions: 120ms color only.

```css
@media (prefers-reduced-motion: reduce) {
  /* Rows disappear immediately, panes swap without transform, colors change without transition.
     No animation is load-bearing for comprehension. */
}
```

Content is visible by default. No reveal is gated behind a class-triggered transition.

## Keyboard

The whole triage path works without a mouse, because that is what "queue to empty in twenty
minutes" actually requires.

| Key | Action |
|---|---|
| `j` / `↓` | Next suggestion |
| `k` / `↑` | Previous suggestion |
| `a` | Approve the selected suggestion |
| `d` | Dismiss the selected suggestion |
| `g` | Go to pattern leaderboard |
| `?` | Keyboard help |
| `Esc` | Close overlay / return to queue on narrow screens |

Focus is visibly managed: a 2px `--focus` ring at 2px offset, never removed, never replaced by a
color change alone. After a row leaves the queue, focus moves to the next row rather than being
dropped to `<body>`.

## Bans specific to this surface

- No charts. The MVP stores ranked counts and lists of questions; a donut chart over ten rows is
  looking busy instead of being useful.
- No gradient text, no glassmorphism, no decorative blur.
- No modal for approve or dismiss. The decision happens inline, where the evidence is.
- No colored side-stripes on cards or callouts. The one 2px left marker in the system indicates
  the selected row and nothing else.
- No icon-plus-heading-plus-text grids.
- No emoji anywhere in the interface.
  - This now has a data-side edge. The imported documentation carries emoji inside
    `articles.category` ("📒 User guide / Forms & Expressions"), because the doc platform's own
    category tree uses them. Storing that is fine; RENDERING it is not. Any view that surfaces a
    category must strip leading emoji first. The ban is on the interface, not the database.
