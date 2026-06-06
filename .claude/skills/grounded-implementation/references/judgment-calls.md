# Judgment Calls

The hard part of grounded implementation isn't the rules — it's the edge cases where two rules
seem to pull against each other (reuse vs. don't-couple, extensible vs. don't-over-engineer).
This file exists for those moments. Read the relevant section when a call is genuinely
ambiguous; otherwise the summary in SKILL.md is enough.

## Contents

- [Reuse & DRY](#reuse--dry) — when to consolidate, when duplication is the right answer
- [Structure & SRP](#structure--srp) — when to split a file, how to spot a god file
- [Extensibility](#extensibility) — building seams without over-engineering

---

## Reuse & DRY

**The order is SEARCH → REUSE → WRITE.** Search the codebase for similar functionality until you
find it or confirm it doesn't exist. Reuse: check existing functions/patterns/structure and
extend before creating new, aiming for the smallest change that works. Only then write
something genuinely new.

**DRY is about knowledge, not text.** The canonical statement (Hunt & Thomas) is: *"Every piece
of knowledge must have a single, unambiguous, authoritative representation within a system."*
The target is information *likely to change* — a constant, a business rule, a schema, an enum, a
config value — so that changing it in one place doesn't force edits in logically unrelated
places. That is when you consolidate to a single source of truth.

**The trap: coincidental duplication.** Two snippets that *look* identical right now but exist
for *different reasons* are not the same knowledge. Merging them couples things that should be
free to diverge — which is exactly what DRY warns against. Test before consolidating: *"If
requirement A changes, must this other copy change too, always?"* If not, leave them separate.

**The wrong abstraction is worse than duplication** (Sandi Metz). The failure sequence:
someone extracts shared code; a near-fit requirement arrives; they add a parameter and a
conditional to accommodate it; repeat, until the "abstraction" is a condition-laden procedure
nobody understands. *"Duplication is far cheaper than the wrong abstraction."*

- **Detector:** if satisfying a new caller requires adding a boolean/mode flag + an `if`-branch
  to a shared helper, that's the smell. Inline a separate copy for the new caller instead.
- **When asked to "de-duplicate":** first check whether the target helper is *already*
  flag-laden. If so, the correct refactor is to split it back apart (re-inline into each caller,
  then delete the unneeded bits), not to add yet another consumer.

**Rule of Three / AHA (Avoid Hasty Abstractions).** On the 1st and 2nd occurrence of similar
code, duplicate it — you don't yet know the shape of the abstraction. Extract a shared unit only
at the **3rd** concrete occurrence, *and* only when all three share the same reason to change.
This earns abstractions from real repetition rather than manufacturing them from one speculative
example. As Kent C. Dodds puts it, wait until "the commonalities scream at you for abstraction."

---

## Structure & SRP

**Single Responsibility — "one reason to change."** A unit should have one reason to change,
roughly one responsibility. Before appending a method/field to an existing class or file, state
the reasons it would currently need to change. If the new code introduces an *independent*
reason (e.g. adding HTTP parsing to a class that already does DB persistence), it belongs in a
new unit.

**God-file signals — any one of these means stop growing it and extract:**

1. You can't give the unit a precise single-purpose name without "and", or you reach for a vague
   `Manager` / `Helper` / `Util` / `Common` suffix.
2. Every change to the system keeps landing in the same file — it has become a junction
   everything passes through.
3. Testing one part requires setting up unrelated state for other parts (a coupling tell).
4. The file imports/references many unrelated subsystems, or *everything else imports from it*.

A god object is "tightly coupled to so much of the other code [that] maintenance becomes more
difficult — changes for one routine ripple into unrelated functions." The fix is
divide-and-conquer: split the large thing into cohesive single-responsibility units (a
monolithic `GameManager` → `PlayerManager`, `GameLogic`, `Renderer`, `InputHandler`,
`SaveSystem`). When you're mid-task and a signal fires, you don't have to fix the whole file —
extract the cohesive cluster you're currently touching into its own unit with a clear interface.

**Separation of concerns / layer routing.** Organize code into sections each addressing a single
concern behind a well-defined interface (presentation / business logic / data access /
persistence). Concretely: presentation code must not build queries; data-access code must not
embed business rules. If the function you're editing already crosses a layer boundary, route the
new logic to the layer that owns it rather than inlining it where you happen to be — so each
concern can be understood and changed in isolation.

---

## Extensibility

**YAGNI applies to features, not to malleability** (Fowler). The precise scoping line: *"Yagni
only applies to capabilities built into the software to support a presumptive feature; it does
not apply to effort to make the software easier to modify."* A presumptive feature carries three
costs — build, delay, and **carry** (the dormant code adds complexity that makes everything else
harder to change). Malleable, well-factored code carries none of those.

**The two-bucket classifier.** Sort every speculative addition:

- **Bucket A — presumptive feature/capability:** an unused config option, a dormant hook, a
  generic "pluggable strategy" nobody asked for, a parameter no current caller passes. → **YAGNI
  applies. Don't build it.**
- **Bucket B — malleability/health:** clear names, small functions, a clean interface boundary,
  no duplicated knowledge. → **Build it now. YAGNI does not apply.**

**Decisive test for a proposed "extensibility" seam:** *Does adding this seam increase
complexity today, and is there a real current consumer?*

- Adds complexity + no current consumer → skip it (Bucket A).
- Adds little/no complexity (it's just well-factored code) → keep it (Bucket B).

**Stay extensible by staying malleable.** Prefer the simplest concrete implementation that
satisfies the *actual* requirement, kept behind a narrow interface so it can be swapped later. A
clean interface boundary is cheap and reversible; a speculative plugin system, generic type
parameter, or config knob is expensive and hard to remove once callers depend on it.
Extensibility = "easy to change later," not "pre-built to handle everything."
