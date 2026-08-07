# Baton

A drift detector for `CLAUDE.md` / `AGENTS.md` — the memory files AI coding
agents read at the start of every session.

Multi-agent setups (Claude Code, AGENTS.md-style conventions, on-call
handoff docs) keep a "here's the state of the world" file that agents are
supposed to read before acting and update before finishing. In practice
those files rot: real commits land, the memory file doesn't get touched,
and the next agent session starts from a stale picture of the repo. Baton
catches that gap deterministically, by diffing the file's own claims
against real git history — no LLM call involved.

## Why this exists

This is our own daily problem. We run a multi-agent setup with a shared
state file, and after enough cycles the file quietly stopped matching
reality — commits nobody mentioned, files it referenced that had moved or
been deleted, cited work that was never actually done. Baton is the
tool we built to stop dogfeeding that drift back into every new agent
session.

It is not a general "docs are outdated" checker. Generic doc-staleness
tools already exist and are company-backed. Baton is scoped narrowly to
the thing that actually breaks agent workflows: the memory file an AI
agent reads to decide what to do next.

## Why deterministic, not LLM-based

Baton is regex- and git-log-based. No API calls, no tokens, no network
dependency beyond `git` itself.

That's not a shortcut — it's the point. The people who need a drift
checker for `CLAUDE.md`/`AGENTS.md` are, definitionally, already running
LLM agents against these files and paying for those calls. A drift
detector that adds another LLM round-trip on every check is asking the
same audience to pay twice to find out their own memory file is stale.
Zero marginal cost per check, deterministic output, works offline, runs
in CI without a secrets-managed API key. That's the entire competitive
wedge against any "AI-powered" alternative.

## What it checks

Baton reads a state file's `## Last Updated` date, then looks at every
git commit since that date (optionally restricted to `watchGlobs`
pathspecs) and reports three things:

- **Undocumented commits** — commits since `Last Updated` whose hash,
  message, or changed files are never mentioned anywhere in the state
  file's body.
- **Dangling references** — paths the state file cites (`` `src/foo.ts` ``,
  `` `docs/plan.md` ``) that no longer exist on disk where Baton runs. This
  is a filesystem check, not a `git ls-files` check: a gitignored directory
  a maintainer keeps populated locally (a personal `docs/` cache, generated
  notes, etc.) won't be flagged on their machine, but the exact same
  reference will show as dangling in CI or on any fresh clone, since
  gitignored content never made it into the checkout. If your state file
  intentionally links to gitignored local-only paths, add them to
  `ignorePatterns` rather than treating a CI-only dangling report as a bug.
- **Orphaned files** — files touched by a watched commit that are never
  named anywhere in the state file, even if their commit was otherwise
  "documented" by a matching commit message.

Plus a **staleness** check: days since `Last Updated` vs. a configurable
threshold.

## Install

```bash
npm install
npm run build
```

`bin/baton` points at `dist/cli.js`; `npm link` (or add `./node_modules/.bin`
to your `PATH`) to get a bare `baton` command.

## Config

Create `baton.config.json` at your repo root:

```json
{
  "stateFile": ["CLAUDE.md", "AGENTS.md"],
  "watchGlobs": ["docs/**", "src/**", "projects/**"],
  "staleDaysThreshold": 3
}
```

- `stateFile` — path (or array of paths) to the memory file(s) to check,
  relative to `repoRoot`. A single string checks one file; an array checks
  every listed file in one run and aggregates the results. This is how you
  point Baton at both `CLAUDE.md` and `AGENTS.md` in one command instead of
  running it twice with two configs. If one of the listed files has no
  `Last Updated` declaration at all (common when, say, `AGENTS.md` is a
  maintained state file but `CLAUDE.md` is just static instructions), that
  file is reported as `COULD NOT CHECK` and the rest are still checked and
  reported normally — it does not discard the whole run. `--fail-on-drift`
  still exits `1` in that case, since an unchecked file shouldn't read as a
  silent pass.
- `watchGlobs` — pathspecs passed straight to `git log --`. Omit to watch
  the whole repo.
- `staleDaysThreshold` — days since `Last Updated` before staleness is
  flagged (default `3`).
- `lastUpdatedHeading` — override the heading Baton looks for (default
  `"Last Updated"`).
- `repoRoot` — override the repo root Baton resolves paths against
  (default: nearest `git rev-parse --show-toplevel` from cwd).
- `ignorePatterns` — array of regex strings (matched with `new RegExp(pattern).test(path)`)
  for paths that should never be reported as a dangling reference or an
  orphaned file. Use this for a path you know is fine but Baton would
  otherwise flag — a planned-but-not-yet-created path, a generated or
  vendored file, etc. — the same escape hatch tools like
  `markdown-link-check`'s `ignorePatterns` or ESLint's `ignorePatterns`
  provide for their own false positives:

  ```json
  {
    "ignorePatterns": ["^projects/not-built-yet/"]
  }
  ```

Each state file needs a heading Baton can find:

```markdown
## Last Updated
2026-08-01
```

A bold pseudo-heading works too — Baton's inline fallback tolerates markdown
emphasis markers around the label:

```markdown
**Last Updated**: 2026-08-01
```

## Usage

```bash
baton check [--config <path>] [--fail-on-drift]
```

- `--config <path>` — config file location (default `./baton.config.json`).
- `--fail-on-drift` — exit `1` when drift or staleness-past-threshold is
  found; otherwise exits `0` regardless (useful for a non-blocking CI
  report step vs. a hard gate).

Exit codes: `0` clean (or drift found without `--fail-on-drift`), `1`
drift found with `--fail-on-drift`, `2` configuration error (missing
config, unparseable config, missing state file) — kept distinct from `1`
so a broken CI setup doesn't read as "drift detected."

### Example: checking both CLAUDE.md and AGENTS.md

Given the config above, and a repo where `CLAUDE.md` is current but
`AGENTS.md` was last updated before a commit that added a new project
directory nobody mentioned in it:

```
$ baton check --fail-on-drift
Baton drift report
===================
State files (2):
  - CLAUDE.md
  - AGENTS.md

--- CLAUDE.md ---
Last updated: 2026-08-01 (1 day ago)
Staleness threshold: 3 day(s) — ok

Undocumented commits (0):
  none

Dangling references (0):
  none

Orphaned files (0):
  none

Result: CLEAN (CLAUDE.md)

--- AGENTS.md ---
Last updated: 2026-07-28 (5 days ago)
Staleness threshold: 3 day(s) — EXCEEDED

Undocumented commits (1):
  - a1b2c3d  2026-07-30  ship recon-scraper MVP

Dangling references (0):
  none

Orphaned files (1):
  - projects/recon-scraper/src/index.ts

Result: DRIFT DETECTED (AGENTS.md)

===================
Result: DRIFT DETECTED in 1/2 state file(s): AGENTS.md
$ echo $?
1
```

Baton also writes `.baton/report.json` on every run — the same data,
machine-readable, for wiring into CI annotations or a dashboard. A
single-`string` `stateFile` config keeps the original flat JSON shape
(`{ stateFile, ... }`); an array `stateFile` config produces the
aggregate shape (`{ stateFiles: [...], results: [...] }`) shown implicitly
above.

## Known limitations

- Text/regex-based path and date extraction — not a full markdown parser.
  Works well for the conventional "heading + bullet list" state-file style
  most `CLAUDE.md`/`AGENTS.md` files already use.
- No cross-repo checks; one repo, one `git log`, per run.
- Commit "documentation" matching is substring-based (hash, short hash, or
  exact message text appearing in the state file body) — paraphrased
  summaries of a commit aren't recognized as documenting it.
- A pytest node-id example (`` `path/to/test.py::test_name` ``) with a
  generic placeholder path that was never a real file is reported as a
  dangling reference, same as a real path that went stale. This is
  intentional, not a bug: the `::` suffix is exactly as likely to prefix a
  *real* test path in a real "run this specific test" example, and that
  path going stale (renamed/deleted) is a genuine, valuable drift signal —
  suppressing the whole shape to avoid the rarer placeholder case would
  blind baton to the more common real one. Use `ignorePatterns` in
  `baton.config.json` to silence a specific known-placeholder path.
- A bare subpath mention (`` `src/types.ts` ``) that matches under more than
  one directory already named earlier in the body (e.g. two projects in a
  monorepo that each have their own `src/types.ts`) resolves to whichever
  directory was named *first*, not necessarily the one the surrounding prose
  actually meant. This is a known gap, not a fix: disambiguating correctly
  would require tracking each reference's position in the text, which isn't
  done today. Name the fuller path (`projects/beta/src/types.ts`) instead of
  a bare one when a filename repeats across sibling directories in the same
  state file.
- Path extraction can't span a literal space or backslash (the candidate
  regex's character class has neither). A Windows-style path
  (`` `src\drift.ts` ``) is silently missed — harmless, no candidate is
  emitted. A real filename containing a space (`` `docs/My File.md` ``) is
  worse: matching stops at the space, producing a truncated candidate
  (`docs/My`) that gets reported as a false dangling reference whenever its
  first segment happens to name a real top-level directory. This is a known
  gap, not a fix: widening the match to span spaces inside backticks would
  regress the far more common case of a whole shell command quoted in
  backticks (`` `cd /app/src && npm test` ``) by reporting the entire
  command line as one bogus path instead of correctly isolating the real
  path inside it — nothing in the plain text distinguishes those two
  shapes. Avoid spaces in filenames referenced from state files (the
  overwhelmingly common convention already) to stay clear of this gap.

## Maintenance

This is a narrow, free tool maintained best-effort. Issues and PRs are
welcome; response time is not guaranteed.
