---
name: grounded-implementation
description: >-
  Use this BEFORE writing or changing code in an existing codebase — when implementing a
  feature, adding functionality, fixing a non-trivial bug, or refactoring. It enforces a
  survey-first discipline: search the existing code for reusable utilities, patterns, and
  conventions; place new code where it belongs instead of cramming everything into one file;
  reuse before reinventing; and add only right-sized extensibility (no speculative
  abstractions). Trigger it even when the user just says "add X", "build Y", or "make it do Z"
  without mentioning structure, reuse, or conventions — those are exactly the requests where
  code sprawl, duplication, and codebase-ignoring happen. Skip only for genuinely trivial
  one-line edits (a typo, a single constant, a version bump).
---

# Grounded Implementation

## Why this exists

Left to its defaults, an agent under task pressure tends to do three things that quietly rot a
codebase: it **dumps everything into one growing file**, it **reinvents code that already
exists** instead of reusing it, and it **ignores the conventions the codebase already
established**. Each one is cheap to avoid and expensive to undo. The fix is not heroic — it is
to *look before you build*. A few minutes of surveying the existing code is the single
highest-leverage thing you can do, because it changes what you write, not just how you clean up
afterward.

This skill is a gate you pass through on the way into implementation. Work the four steps in
order. They are mostly about judgment, so where a call is genuinely tricky, follow the pointer
into [references/judgment-calls.md](references/judgment-calls.md) instead of guessing.

## The gate — do these in order

### 1. SURVEY before writing (highest leverage — do not skip)

Before you write a single line, understand the ground you are building on:

- **Search for what already exists.** Grep/glob for the types, functions, helpers, and patterns
  the task touches. If the search is broad (many files, several naming conventions), dispatch a
  subagent so the file-reading doesn't bury your own context — ask it "what existing utilities,
  patterns, and conventions are relevant to <task>, and where do they live?"
- **Find where the new code belongs.** Which module/file/layer owns this responsibility today?
  What is the closest existing example to follow? (e.g. "how are the other RPC handlers
  written?")
- **Write a 3–5 line fit-plan** before coding: what you'll **reuse**, what you'll **extend**,
  what is **genuinely new**, and **where each piece goes**. This is not ceremony — it forces the
  reuse/placement decisions to happen *before* the code exists, when they're still free.

Skipping this is what causes every problem below. If you find yourself opening a new file
without having searched for an existing home, stop and survey.

### 2. REUSE before writing

- **Extend what exists over creating new.** If a helper, type, or pattern already does 80% of
  the job, build on it. Match the existing style and naming rather than introducing your own.
- **Don't drastically change established patterns** to suit one new case — iterate on the
  pattern first.
- **Consolidate only genuine duplication of *knowledge*** — the same constant, rule, schema, or
  config that must always change together. Do **not** merge two snippets just because they
  *look* alike; code that changes for different reasons is coincidental duplication, and merging
  it couples unrelated things.
- **Wrong-abstraction STOP signal:** if serving a new caller would require adding a
  boolean/mode flag plus an `if`-branch to a shared helper, stop — duplicate a small copy for
  the new caller instead. *Duplication is cheaper than the wrong abstraction.*

Tricky reuse/DRY calls → [references/judgment-calls.md](references/judgment-calls.md) (§Reuse & DRY).

### 3. PLACE it right — don't grow a god file

- **One reason to change.** Before appending to an existing file/class, name its current
  responsibilities. If the new code's reason-to-change differs from all of them, it belongs in a
  new unit, not bolted onto this one.
- **Watch for god-file signals:** you can't name the unit without "and" or a vague
  `Manager/Helper/Util` suffix; every change keeps landing in the same file; testing one part
  needs unrelated setup. When any fires, extract the part you're touching.
- **Route to the right layer.** Don't co-locate concerns — presentation shouldn't build queries,
  data-access shouldn't embed business rules. Put new logic in the layer that owns it, behind a
  clear interface, instead of inlining it wherever you happen to be.

Structure/SRP edge cases → [references/judgment-calls.md](references/judgment-calls.md) (§Structure & SRP).

### 4. Right-size extensibility

Extensibility means *easy to change later*, achieved through cohesion, low coupling, and narrow
interfaces — **not** pre-built machinery for futures nobody asked for.

- **Build now:** clear names, small functions, a clean interface boundary, no duplicated
  knowledge. This is malleability — it's cheap and it *is* the extensibility.
- **Don't build now:** unused config knobs, dormant hooks, generic strategy/plugin layers, or
  parameters no current caller passes. These add complexity today for a hypothetical tomorrow.
- **Decisive test for a proposed seam:** *Does it add complexity today, and is there a real
  current consumer?* No consumer + adds complexity → skip it. You earn abstractions from real,
  repeated usage, not from imagined usage.

YAGNI-vs-extensibility details → [references/judgment-calls.md](references/judgment-calls.md) (§Extensibility).

## Before you say "done" — self-check

Confirm each, out loud, against what you actually wrote:

- [ ] I searched the codebase for existing code before writing new code.
- [ ] I reused/extended what existed and matched its conventions.
- [ ] I added no speculative abstraction (every seam has a real current consumer).
- [ ] New code lives where its responsibility belongs; I didn't grow a god file.
- [ ] No coincidental duplication merged; no flag-laden shared helper created.
- [ ] The project's build/lint/test pass (for pi-for-vscode: `npm run compile`).

If a box can't be checked, fix it before reporting completion — a checklist you can't honestly
tick is the signal, not a formality.

## Never

- **Never** dump unrelated responsibilities into one file because it's where you happened to be.
- **Never** reimplement something the codebase already provides without first searching for it.
- **Never** add a config option, flag, or abstraction layer that no current caller uses.
- **Never** claim completion while the self-check above has an unticked box.

## When to skip

Skip the full gate for genuinely trivial changes — a typo, a single constant or version bump, a
one-line fix in a file you already fully understand. The survey step is proportional to the
task; don't make a three-line change into a research project.
