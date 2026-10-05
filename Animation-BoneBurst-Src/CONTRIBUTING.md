# Contributing to BoneBurst

Thanks for looking. Issues, bug reports and pull requests are all welcome.

## Before you open a PR

Read **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** first. It is long, but it
is not a style guide. It is a record of the things in this codebase that fail
*silently* when you get them wrong: the DragonBones 5.5 contract, the Flash
transform model, how undo stores values, why the preview is ground truth. Most
review comments on a first PR are already answered in there.

Three rules the code depends on, and one grep that checks the first:

1. **`core/` imports nothing from `view/`, `app/` or `io/`, and touches no DOM.**
   That is what lets the risky logic run under vitest in Node.

   ```bash
   grep -rn 'from "@/\(view\|app\|io\)' src/core/    # must print nothing
   ```

2. **A command replaces values, it never mutates them.** `core/doc/freeze.ts`
   enforces it in tests; turn it on in the browser too with
   `localStorage["animo.freezeValues"] = "1"`.

3. **Verify interactive fixes with real mouse input.** A synthetic
   `element.click()` bypasses pointerdown/pointerup and passes even when the
   thing is broken (see the DOM trap section in the architecture doc).

## Working on it

```bash
npm install
npm run dev          # Vite on :5181, Chrome or Edge
npm test             # vitest
npx tsc --noEmit     # typecheck alone, faster than a build while iterating
npm run build        # tsc --noEmit && vite build
```

A PR should keep `npm run build` and `npm test` green. New behaviour that can be
expressed as a pure function belongs in `core/` with a test beside it; that is
where the suite earns its keep.

## Commit messages and comments

Comments explain *why*, not *what*: the surrounding code is written that way
and a PR that reads differently is harder to review than one that is simply
wrong. No comment is better than a comment restating the line below it.

## Code of conduct

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
