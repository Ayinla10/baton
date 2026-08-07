import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeDrift, getCommitsSince, parseStateFile } from "../src/drift.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distCli = join(__dirname, "..", "dist", "cli.js");

let repoDir: string;

function git(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, { cwd, env: env ?? process.env, encoding: "utf8" });
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "baton-test-"));
  git(["init", "-q"], dir);
  git(["config", "user.email", "baton-test@example.com"], dir);
  git(["config", "user.name", "Baton Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  return dir;
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = join(dir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commit(dir: string, relPaths: string[], message: string, dateISO: string): string {
  git(["add", ...relPaths], dir);
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: dateISO,
    GIT_COMMITTER_DATE: dateISO,
  };
  git(["commit", "-m", message], dir, env);
  return git(["rev-parse", "HEAD"], dir).trim();
}

function stateFileBody(lastUpdatedISODate: string, extra: string): string {
  return [
    "# Project State",
    "",
    "## Last Updated",
    lastUpdatedISODate,
    "",
    extra,
    "",
  ].join("\n");
}

beforeEach(() => {
  repoDir = initRepo();
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("parseStateFile", () => {
  it("extracts the Last Updated date and referenced paths", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody("2024-01-10", "Tracking `docs/plan.md` and `projects/`.");
    writeFile(repoDir, "STATE.md", body);
    mkdirSync(join(repoDir, "projects"), { recursive: true });

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });

    expect(state.lastUpdated?.toISOString().slice(0, 10)).toBe("2024-01-10");
    expect(state.referencedPaths).toContain("docs/plan.md");
  });

  it("returns null lastUpdated when no heading is present", () => {
    writeFile(repoDir, "STATE.md", "# Nothing here\n\nJust prose, no heading.\n");
    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    expect(state.lastUpdated).toBeNull();
  });

  it("extracts the Last Updated date from a bold pseudo-heading (no markdown heading)", () => {
    // Real-world convention seen in the wild (e.g. linkinator's AGENTS.md):
    // "**Last Updated**: DATE" instead of a "## Last Updated" heading. The
    // "**" sits between the label text and the colon, which the inline
    // fallback regex must tolerate.
    const body = "# Agent Guide\n\nSome content.\n\n**Last Updated**: 2025-12-27\n";
    writeFile(repoDir, "STATE.md", body);
    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    expect(state.lastUpdated?.toISOString().slice(0, 10)).toBe("2025-12-27");
  });
});

describe("computeDrift", () => {
  it("reports zero drift for a clean, up-to-date state file", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody("2024-01-10", "Tracking `docs/plan.md`.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(commits).toHaveLength(0);
    expect(report.undocumentedCommits).toHaveLength(0);
    expect(report.danglingReferences).toHaveLength(0);
    expect(report.orphanedFiles).toHaveLength(0);
    expect(report.hasDrift).toBe(false);
  });

  it("flags a commit that lands after Last Updated and is never mentioned", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody("2024-01-10", "Tracking `docs/plan.md`. Nothing else in flight.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    writeFile(repoDir, "projects/newthing.md", "surprise work");
    const hash = commit(
      repoDir,
      ["projects/newthing.md"],
      "ship a surprise feature",
      "2024-01-15T10:00:00+00:00"
    );

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.undocumentedCommits.map((c) => c.hash)).toContain(hash);
    expect(report.hasDrift).toBe(true);
  });

  it("flags a dangling reference when a cited path no longer exists", () => {
    const body = stateFileBody("2024-01-10", "Tracking `docs/removed.md` for the next step.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).toContain("docs/removed.md");
    expect(report.hasDrift).toBe(true);
  });

  it("flags a pytest node-id placeholder path as dangling (Cycle 56: accepted false positive, not fixed)", () => {
    // Dogfooding against macbre/sql-metadata's real AGENTS.md found a
    // "Running Single Test" example: `pytest test/test_file.py::test_name`,
    // where every component is a generic placeholder, not a real path.
    // A candidate fix — treat any path immediately followed by `::` (pytest
    // node-id syntax) as non-literal and skip the dangling check — was
    // considered and rejected: that syntax is exactly as likely to name a
    // *real* test file in a real "run this specific test" example, and a
    // real one going stale (renamed/deleted) is precisely the drift class
    // this tool exists to catch. Suppressing the whole `::` shape would
    // silently blind baton to that more valuable case to avoid a rarer,
    // lower-severity placeholder-example false positive. Locked in as
    // intentional behavior via this fixture, per the same reasoning as the
    // ignorePatterns escape hatch above (which remains the correct opt-out
    // for a specific repo that wants this suppressed).
    const body = stateFileBody(
      "2024-01-10",
      "### Running Single Test\n```bash\npytest test/test_file.py::test_name -vv\n```"
    );
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).toContain("test/test_file.py");
    expect(report.hasDrift).toBe(true);
  });

  it("suppresses a dangling reference matching an ignorePatterns entry (Cycle 37: false-positive escape hatch)", () => {
    // Every comparable path/link checker (markdown-link-check's
    // `ignorePatterns`, ESLint's `ignorePatterns`, ripgrep's `.rgignore`)
    // ships a config-level escape hatch for a path the tool would otherwise
    // flag but the user knows is fine — a planned-but-not-yet-created path,
    // in this case. Baton had no equivalent; a real false positive here had
    // no fix short of removing the mention entirely.
    const body = stateFileBody("2024-01-10", "Planned: `projects/not-built-yet/index.ts`.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);

    const withoutIgnore = computeDrift(repoDir, state, commits);
    expect(withoutIgnore.danglingReferences).toContain("projects/not-built-yet/index.ts");

    const withIgnore = computeDrift(repoDir, state, commits, {
      ignorePatterns: [/^projects\/not-built-yet\//],
    });
    expect(withIgnore.danglingReferences).not.toContain("projects/not-built-yet/index.ts");
    expect(withIgnore.hasDrift).toBe(false);
  });

  it("resolves a bare subpath against a directory reference mentioned elsewhere in the body (Cycle 13 false positive)", () => {
    // Real bug found dogfooding Baton on a shared multi-agent consensus file:
    // the body names a project directory (`projects/baton`) in one bullet
    // and a bare subpath (`src/drift.ts`) in another, without repeating the
    // full prefix. `src/drift.ts` doesn't exist at the repo root, but it
    // does exist under the directory context — must not be dangling.
    writeFile(repoDir, "projects/baton/src/drift.ts", "export {};");
    const body = stateFileBody(
      "2024-01-10",
      "Tracking `projects/baton`. Known limitation logged in `src/drift.ts`."
    );
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["projects/baton/src/drift.ts", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).not.toContain("src/drift.ts");
  });

  it("resolves a bare subpath via the ancestor directory of a full path, with no standalone directory mention (Cycle 48 false positive)", () => {
    // Real gap found running Baton against this monorepo's own real
    // consensus.md: it names a full nested path once (`projects/baton/
    // README.md`) and later mentions trailing segments bare (`src/cli.ts`),
    // but — unlike the Cycle 13 fixture above — never mentions the
    // containing directory (`projects/baton`) as its own standalone
    // reference anywhere in the body. The old dirContexts only credited a
    // directory as context if it was *itself* extracted as a bare mention,
    // so `src/cli.ts` had no context to resolve against and was reported
    // dangling even though it exists right next to the file that was named
    // in full.
    writeFile(repoDir, "projects/baton/README.md", "# Baton");
    writeFile(repoDir, "projects/baton/src/cli.ts", "export {};");
    const body = stateFileBody(
      "2024-01-10",
      "See `projects/baton/README.md` for details. Entry point lives in `src/cli.ts`."
    );
    writeFile(repoDir, "STATE.md", body);
    commit(
      repoDir,
      ["projects/baton/README.md", "projects/baton/src/cli.ts", "STATE.md"],
      "initial commit",
      "2024-01-05T10:00:00+00:00"
    );

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).not.toContain("src/cli.ts");
    expect(report.hasDrift).toBe(false);
  });

  it("resolves an ambiguous bare subpath to the first-named directory, not necessarily the intended one (Cycle 61: accepted limitation, not fixed)", () => {
    // Real gap found auditing resolveReferences' dirContexts: when two
    // different directories named in the same body (e.g. two projects in a
    // monorepo) each contain a same-named file, a later bare mention of that
    // filename resolves to whichever directory was named *first* in the
    // body — dirContexts is an unordered Set of directory strings, and
    // resolution just takes the first one that produces an existing path.
    // Textual proximity to the bare mention ("Beta's ... in `src/types.ts`")
    // isn't considered, because no candidate's source position is tracked
    // through extractReferencedPaths/resolveReferences.
    //
    // A correct fix (resolve by nearest-preceding named directory) requires
    // threading character offsets through extractReferencedPaths,
    // parseStateFile, and resolveReferences — a real refactor, not a
    // same-shape swap-in like the three containsWholeMatch fixes in cycles
    // #58-#60. Given real occurrences require two same-named files under two
    // different named directories in one state file (uncommon outside
    // multi-project monorepos with parallel layouts), the risk of that
    // refactor regressing the already-fixed Cycle 13/48 cases outweighs
    // fixing this rarer misattribution. Locked in as documented, accepted
    // behavior via this fixture — see README "Known limitations" — same
    // reasoning as the pytest node-id case above (Cycle 56).
    writeFile(repoDir, "projects/alpha/README.md", "# Alpha");
    writeFile(repoDir, "projects/alpha/src/types.ts", "export {};");
    writeFile(repoDir, "projects/beta/README.md", "# Beta");
    writeFile(repoDir, "projects/beta/src/types.ts", "export {};");
    const body = stateFileBody(
      "2024-01-10",
      "See `projects/alpha/README.md` for alpha. See `projects/beta/README.md` for beta. " +
        "Beta's shared types live in `src/types.ts`."
    );
    writeFile(repoDir, "STATE.md", body);
    commit(
      repoDir,
      [
        "projects/alpha/README.md",
        "projects/alpha/src/types.ts",
        "projects/beta/README.md",
        "projects/beta/src/types.ts",
        "STATE.md",
      ],
      "initial commit",
      "2024-01-05T10:00:00+00:00"
    );

    // Only beta's types.ts changes after last-updated; the bare mention
    // meant beta, but resolves to alpha (named first), so this commit is
    // misattributed as undocumented.
    writeFile(repoDir, "projects/beta/src/types.ts", "export const x = 1;");
    commit(repoDir, ["projects/beta/src/types.ts"], "update beta types", "2024-01-11T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.undocumentedCommits.map((c) => c.message)).toContain("update beta types");
    expect(report.hasDrift).toBe(true);
  });

  it("truncates a space-containing filename into a bogus dangling reference; silently misses a backslash path (Cycle 63: accepted limitation, not fixed)", () => {
    // Audited following up on Cycle 61's note that "unusual path shapes"
    // (spaces, Windows backslashes) were still open. Real gap: the
    // candidate regex's [\w.-] class contains neither a space nor a
    // backslash. A Windows-style path (`src\drift.ts`) simply fails to
    // match at all — a silent miss, harmless because it emits no candidate.
    // A real filename containing a space (`docs/My File.md`) is worse: the
    // regex still matches, but only up to the space, producing a truncated
    // candidate ("docs/My") that doesn't exist and gets reported as a false
    // dangling reference whenever its first segment happens to name a real
    // top-level directory (as `docs/` does here).
    //
    // A fix that widens matching to span spaces inside backticks was
    // considered and rejected: this repo's own consensus.md and the Cycle 35
    // regression guard above ("cd /app/src && npm test" -> just "app/src")
    // prove backtick-wrapped, space-containing content is overwhelmingly a
    // *shell command that contains a path*, not a *path that contains a
    // space*. Widening the match to span the whole backtick body would
    // regress the already-fixed Cycle 35 case, reporting the entire command
    // line as one bogus path instead of correctly isolating the real path
    // inside it. Nothing in the plain text distinguishes the two shapes.
    // Locked in as documented, accepted behavior — see README "Known
    // limitations" — same reasoning as the pytest node-id (Cycle 56) and
    // ambiguous bare-subpath (Cycle 61) cases above.
    mkdirSync(join(repoDir, "docs"), { recursive: true });
    writeFile(repoDir, "docs/My File.md", "placeholder");
    const body = stateFileBody(
      "2024-01-10",
      "See `docs/My File.md` for details. Also see `src\\drift.ts` (Windows-style)."
    );
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["STATE.md", "docs/My File.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });

    expect(state.referencedPaths).toContain("docs/My");
    expect(state.referencedPaths).not.toContain("docs/My File.md");
    expect(state.referencedPaths.some((p) => p.includes("drift.ts"))).toBe(false);
  });

  it("does not misread slash-separated prose as a dangling path (Cycle 28 false positive)", () => {
    // Real bug found dogfooding Baton on our own consensus.md: a trailing
    // slash was treated as sufficient evidence of a real path reference,
    // so ordinary prose containing "/" got misparsed as bogus repo-relative
    // candidates — "distribution/`workflow`-scope" (word/word alternatives),
    // "Cycles #25/#26" (a "#" breaks the match, leaving a bare "25/"), and
    // "`~/.ssh/`" (the leading `~` isn't in the path charclass, so the match
    // silently starts after it and strips the home-dir marker). None of
    // these were ever backtick-wrapped as the intended path text itself —
    // the convention every real reference in this file follows.
    const body = stateFileBody(
      "2024-01-10",
      "Tracking `docs/plan.md`. Blocked on distribution/`workflow`-scope/Cloudflare, " +
        "checked `~/.ssh/` for keys, and re-read it in Cycles #25/#26."
    );
    writeFile(repoDir, "docs/plan.md", "the plan");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).not.toContain("distribution");
    expect(report.danglingReferences).not.toContain("25");
    expect(report.danglingReferences).not.toContain(".ssh");
    expect(report.hasDrift).toBe(false);
  });

  it("does not misread a git ref range as a dangling path (Cycle 47 false positive, found dogfooding Baton against its own real monorepo)", () => {
    // Real bug found running Baton against this very monorepo's own
    // memories/consensus.md: prose instructing "check `git log
    // origin/main..HEAD` before ending each cycle" — a completely ordinary
    // thing for a state file to say — got misread as a path reference.
    // "origin/main..HEAD" satisfies the hasExtension heuristic because
    // ".HEAD" looks exactly like a dot followed by a 1-10 char extension,
    // and it never resolves to a real file, so it was reported as dangling.
    const body = stateFileBody(
      "2024-01-10",
      "Keep pushing to `origin/main`. Check `git log origin/main..HEAD` and " +
        "`git diff main...feature-x` before ending each cycle."
    );
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).not.toContain("origin/main..HEAD");
    expect(report.danglingReferences).not.toContain("main...feature-x");
    expect(report.hasDrift).toBe(false);
  });

  it("does not misread a non-http(s) URL, mailto link, or SCP-style target as a dangling path (Cycle 62 false positive)", () => {
    // Real bug: the URL strip only matched `https?://`, so any other
    // slash-and-dot-shaped URL survived it and got misparsed as a bogus
    // repo-relative path candidate — an `ftp://` link, a `mailto:` link
    // (its address-as-path shape defeats the strip too), and a bare
    // `user@host:path` SCP target (no `//` at all, so it needs its own
    // pattern). None of these name anything that exists in the repo, so
    // each one would have surfaced as a false dangling reference.
    const body = stateFileBody(
      "2024-01-10",
      "Archive at ftp://example.com/path/to/file.txt, or mailto:reports@example.com/inbox.txt, " +
        "or copy via user@host.example.com:backup/data.tar.gz."
    );
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).not.toContain("example.com/path/to/file.txt");
    expect(report.danglingReferences).not.toContain("example.com");
    expect(report.danglingReferences).not.toContain("inbox.txt");
    expect(report.danglingReferences).not.toContain("backup/data.tar.gz");
    expect(report.hasDrift).toBe(false);
  });

  it("does not misread a Docker image reference as a dangling path (Cycle 71 false positive, found dogfooding Baton against a real external repo)", () => {
    // Real bug found running Baton against 0wulf/stridetastic's CLAUDE.md: an
    // embedded docker-compose block said "image: grafana/grafana:latest", and
    // the repo happens to have a real top-level `grafana/` directory (config
    // for that same service) — so "grafana/grafana" rooted to a real entry,
    // qualified as a path candidate, and got reported as dangling because no
    // `grafana/grafana` subdirectory actually exists. A real `path/file.ts:42`
    // "file:line" reference must still resolve normally — the fix only
    // excludes two dot-free segments immediately followed by ":tag".
    const body = stateFileBody(
      "2024-01-10",
      "    image: grafana/grafana:latest\n\nSee `src/drift.ts:42` for the parser."
    );
    writeFile(repoDir, "STATE.md", body);
    mkdirSync(join(repoDir, "grafana"), { recursive: true });
    writeFile(repoDir, "grafana/.gitkeep", "");
    writeFile(repoDir, "src/drift.ts", "// placeholder");
    commit(repoDir, ["STATE.md", "grafana/.gitkeep", "src/drift.ts"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).not.toContain("grafana/grafana");
    expect(report.danglingReferences).not.toContain("src/drift.ts");
    expect(report.hasDrift).toBe(false);
  });

  it("flags a dangling reference for a root-relative single-segment mention like `/transform` (Cycle 35 false negative, found dogfooding against real external AGENTS.md/CLAUDE.md files)", () => {
    // Real bug found by pulling actual AGENTS.md/CLAUDE.md files from GitHub
    // (e.g. datacoves/balboa, Unleash/unleash) rather than only ever testing
    // against our own consensus.md: naming a top-level directory as a bare
    // root-relative mention — "Transform (`/transform`)" — is a common real
    // convention. The old regex required a *second* "/" to anchor its
    // (?:[\w.-]+\/)+ repetition, so a single-segment leading-slash path like
    // `/transform` structurally could never match at all — if the directory
    // was later deleted or renamed, Baton would silently miss the dangling
    // reference entirely, defeating the entire point of the check.
    const body = stateFileBody(
      "2024-01-10",
      "Transform (`/transform`) - dbt project. Load (`/load`) legacy connectors."
    );
    writeFile(repoDir, "STATE.md", body);
    // Neither `/transform` nor `/load` exists in this repo — both dangling.
    commit(repoDir, ["STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).toContain("transform");
    expect(report.danglingReferences).toContain("load");
    expect(report.hasDrift).toBe(true);
  });

  it("does not flag a root-relative mention that still resolves to a real top-level directory", () => {
    mkdirSync(join(repoDir, "src"), { recursive: true });
    writeFile(repoDir, "src/.gitkeep", "");
    const body = stateFileBody("2024-01-10", "Core code lives in (`/src`).");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["STATE.md", "src/.gitkeep"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.danglingReferences).not.toContain("src");
  });

  it("does not split a multi-segment absolute path into fragments (Cycle 35 regression guard)", () => {
    // The fix for the single-segment `/transform` case above adds a second
    // regex alternative gated by a lookbehind. Guard against that
    // alternative firing mid-path and splitting a shell-command-style
    // absolute path like `/app/src` into two weaker fragments ("app" and
    // "src") instead of matching it whole, which would resolve to a
    // different (and wrong) part of the repo tree.
    mkdirSync(join(repoDir, "app", "src"), { recursive: true });
    writeFile(repoDir, "app/src/.gitkeep", "");
    const body = stateFileBody("2024-01-10", "Run `cd /app/src && npm test` before shipping.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["STATE.md", "app/src/.gitkeep"], "initial commit", "2024-01-05T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });

    expect(state.referencedPaths).toContain("app/src");
  });

  it("splits two filenames joined by a bare slash instead of reporting one compound dangling path (Cycle 48/49 false positive, found dogfooding against this repo's own consensus.md)", () => {
    // Real sentence from this repo's own memories/consensus.md: "the external
    // AGENTS.md/CLAUDE.md examples pulled in Cycle #35" — two independent
    // filenames mentioned back-to-back, not a nested path. Both AGENTS.md and
    // CLAUDE.md are real files in this repo root, so neither should ever be
    // reported dangling; the old behavior extracted the whole compound string
    // "AGENTS.md/CLAUDE.md" as a single candidate (hasExtension fired on the
    // trailing ".md") and reported it dangling since that literal path never
    // exists.
    writeFile(repoDir, "AGENTS.md", "agents");
    writeFile(repoDir, "CLAUDE.md", "claude");
    const body = stateFileBody(
      "2024-01-10",
      "See the external AGENTS.md/CLAUDE.md examples pulled in Cycle #35."
    );
    writeFile(repoDir, "STATE.md", body);
    commit(
      repoDir,
      ["STATE.md", "AGENTS.md", "CLAUDE.md"],
      "initial commit",
      "2024-01-05T10:00:00+00:00"
    );

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(state.referencedPaths).toContain("AGENTS.md");
    expect(state.referencedPaths).toContain("CLAUDE.md");
    expect(state.referencedPaths).not.toContain("AGENTS.md/CLAUDE.md");
    expect(report.danglingReferences).not.toContain("AGENTS.md/CLAUDE.md");
    expect(report.hasDrift).toBe(false);
  });

  it("flags an orphaned file: changed in git, in a watched glob, never named in the state file", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    // Body mentions docs/plan.md and a sentence that will match a later commit's
    // message verbatim, so that commit is "documented" at the commit level even
    // though the file it touches is never named anywhere in the body — isolating
    // orphanedFiles from undocumentedCommits.
    const body = stateFileBody(
      "2024-01-10",
      "Tracking `docs/plan.md`. Doing general chores this cycle."
    );
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    writeFile(repoDir, "projects/scratch.md", "untracked scratch work");
    const hash = commit(
      repoDir,
      ["projects/scratch.md"],
      "general chores",
      "2024-01-15T10:00:00+00:00"
    );

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["docs/**", "projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    // The commit message matches body prose, so it's not flagged as undocumented...
    expect(report.undocumentedCommits.map((c) => c.hash)).not.toContain(hash);
    // ...but the file it touched was never named anywhere in the state file.
    expect(report.orphanedFiles).toContain("projects/scratch.md");
    expect(report.hasDrift).toBe(true);
  });

  it("flags an undocumented commit and orphaned file under a directory that was only ever named once, unrelated to the change (Cycle 69 false negative, found dogfooding Baton against a real external repo's consensus-style state file)", () => {
    // Real gap: naming a project's root directory once (e.g. an "Active
    // Projects" bullet like `projects/dashboard/` -- status: live) was
    // silently treated as documenting every file ever committed under that
    // directory afterward, forever -- because isDocumented() did a
    // dirRefs.some(startsWith) prefix check. That's the single most common
    // thing a state file does (name a project's directory once, early), so
    // it blinded Baton to exactly the drift it exists to catch: unrelated,
    // never-mentioned work landing in an already-named project directory.
    // dirRefs' directory-context role in resolveReferences (Cycle 13/48
    // above, for resolving a bare subpath like `src/foo.ts`) is a separate,
    // legitimate use and is intentionally untouched by this fix.
    writeFile(repoDir, "projects/dashboard/src/index.ts", "export {};");
    const body = stateFileBody("2024-01-10", "Active Projects: dashboard: `projects/dashboard/` -- status: live.");
    writeFile(repoDir, "STATE.md", body);
    commit(
      repoDir,
      ["projects/dashboard/src/index.ts", "STATE.md"],
      "initial commit",
      "2024-01-05T10:00:00+00:00"
    );

    writeFile(repoDir, "projects/dashboard/src/unrelated.ts", "export const x = 1;");
    const hash = commit(
      repoDir,
      ["projects/dashboard/src/unrelated.ts"],
      "ship an unrelated feature",
      "2024-01-15T10:00:00+00:00"
    );

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, ["projects/**"]);
    const report = computeDrift(repoDir, state, commits);

    expect(report.undocumentedCommits.map((c) => c.hash)).toContain(hash);
    expect(report.orphanedFiles).toContain("projects/dashboard/src/unrelated.ts");
    expect(report.hasDrift).toBe(true);
  });

  it("flags an empty-message commit as undocumented instead of silently matching everything (QA regression)", () => {
    // Bug found during QA: `state.body.includes(commit.message)` degenerates
    // to always-true when `commit.message` is "" (JS: "".includes("") ===
    // true for any body), so an empty-message commit was silently treated
    // as "documented" no matter what it touched. Use `--allow-empty` too so
    // the commit changes zero files — that isolates the bug from the
    // orphanedFiles safety net (which only catches commits that touch
    // files; an empty commit touches none, so without the fix this commit
    // would vanish from the drift report entirely).
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody("2024-01-10", "Tracking `docs/plan.md`.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-15T10:00:00+00:00",
      GIT_COMMITTER_DATE: "2024-01-15T10:00:00+00:00",
    };
    git(["commit", "--allow-empty", "--allow-empty-message", "-m", ""], repoDir, env);
    const hash = git(["rev-parse", "HEAD"], repoDir).trim();

    // No watchGlobs restriction: `git log -- <pathspec>` excludes commits
    // that touch zero matching files, which would hide this empty commit
    // regardless of the message bug and defeat the isolation this test
    // wants. Watching the whole repo (no pathspec) surfaces it.
    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, []);
    const report = computeDrift(repoDir, state, commits);

    expect(report.undocumentedCommits.map((c) => c.hash)).toContain(hash);
    expect(report.hasDrift).toBe(true);
  });

  it("flags a fileless commit whose short message is a substring of an unrelated word in the body", () => {
    // Same failure class as the empty-message bug above, triggered without
    // an empty message: `state.body.includes(commit.message)` matches "sync"
    // inside the unrelated word "resync". A normal commit (has files) would
    // still be caught by the orphanedFiles safety net, but a fileless commit
    // (--allow-empty, common for CI/chore markers) has no files to fall back
    // on, so the plain substring match made it vanish from the report
    // entirely instead of showing up as undocumented.
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody("2024-01-10", "Tracking `docs/plan.md`. Working on the resync logic.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-15T10:00:00+00:00",
      GIT_COMMITTER_DATE: "2024-01-15T10:00:00+00:00",
    };
    git(["commit", "--allow-empty", "-m", "sync"], repoDir, env);
    const hash = git(["rev-parse", "HEAD"], repoDir).trim();

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, []);
    const report = computeDrift(repoDir, state, commits);

    expect(report.undocumentedCommits.map((c) => c.hash)).toContain(hash);
    expect(report.hasDrift).toBe(true);
  });

  it("flags a changed file whose short path is a substring of an unrelated word in the body", () => {
    // Same failure class as the commit-message substring bugs above, but on
    // the file-path side: `state.body.includes(filePath)` treated a short
    // changed path like "a.ts" as "documented" whenever it was embedded in
    // an unrelated longer word already in the prose ("schema.ts" contains
    // "a.ts"). Real repos routinely have short, common filenames (db.ts,
    // app.py, api.ts) that collide this way with unrelated prose, so this
    // silently hid genuine orphaned-file and undocumented-commit drift.
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody(
      "2024-01-10",
      "Tracking `docs/plan.md`. We updated schema.ts today with new types."
    );
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    writeFile(repoDir, "a.ts", "export const a = 1;");
    const hash = commit(repoDir, ["a.ts"], "add a.ts", "2024-01-15T10:00:00+00:00");

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, []);
    const report = computeDrift(repoDir, state, commits);

    expect(report.undocumentedCommits.map((c) => c.hash)).toContain(hash);
    expect(report.orphanedFiles).toContain("a.ts");
    expect(report.hasDrift).toBe(true);
  });

  it("flags a fileless commit whose short hash is a substring of an unrelated hex string in the body", () => {
    // Same failure class as the message/path substring bugs above, but on
    // the hash side: `state.body.includes(shortHash)` treated a 7-char short
    // hash as "documented" whenever it was embedded inside an unrelated
    // longer hex string already in the prose. Hex has only 16 symbols, so
    // this kind of accidental substring collision is rarer than with English
    // words but still real (e.g. a body that mentions some other hex id).
    // A fileless commit (--allow-empty) isolates this from the orphanedFiles
    // safety net, which only catches commits that touch files.
    writeFile(repoDir, "docs/plan.md", "the plan");
    writeFile(repoDir, "STATE.md", stateFileBody("2024-01-10", "Tracking `docs/plan.md`."));
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: "2024-01-15T10:00:00+00:00",
      GIT_COMMITTER_DATE: "2024-01-15T10:00:00+00:00",
    };
    git(["commit", "--allow-empty", "-m", "chore: bump deps"], repoDir, env);
    const hash = git(["rev-parse", "HEAD"], repoDir).trim();
    const shortHash = hash.slice(0, 7);

    const body = stateFileBody(
      "2024-01-10",
      `Tracking \`docs/plan.md\`. Unrelated blob id: aa${shortHash}ffdead.`
    );
    writeFile(repoDir, "STATE.md", body);

    const state = parseStateFile(join(repoDir, "STATE.md"), { repoRoot: repoDir });
    const commits = getCommitsSince(repoDir, state.lastUpdated!, []);
    const report = computeDrift(repoDir, state, commits);

    expect(report.undocumentedCommits.map((c) => c.hash)).toContain(hash);
    expect(report.hasDrift).toBe(true);
  });
});

describe("baton CLI exit-code contract", () => {
  it("dist/cli.js was built (run `npm run build` before tests)", () => {
    expect(existsSync(distCli)).toBe(true);
  });

  it("exits 0 on a clean repo with --fail-on-drift", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody("2024-01-10", "Tracking `docs/plan.md`.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    writeFile(
      repoDir,
      "baton.config.json",
      JSON.stringify(
        { stateFile: "STATE.md", watchGlobs: ["docs/**", "projects/**"], staleDaysThreshold: 3650 },
        null,
        2
      )
    );

    const result = spawnSync("node", [distCli, "check", "--fail-on-drift"], {
      cwd: repoDir,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(repoDir, ".baton", "report.json"))).toBe(true);
  });

  it("exits 1 with --fail-on-drift when drift is present, 0 without the flag", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody("2024-01-10", "Tracking `docs/plan.md`. Nothing else in flight.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    writeFile(repoDir, "projects/newthing.md", "surprise work");
    commit(repoDir, ["projects/newthing.md"], "ship a surprise feature", "2024-01-15T10:00:00+00:00");

    writeFile(
      repoDir,
      "baton.config.json",
      JSON.stringify(
        { stateFile: "STATE.md", watchGlobs: ["docs/**", "projects/**"], staleDaysThreshold: 3650 },
        null,
        2
      )
    );

    const failing = spawnSync("node", [distCli, "check", "--fail-on-drift"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("DRIFT DETECTED");

    const nonFailing = spawnSync("node", [distCli, "check"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(nonFailing.status).toBe(0);
    expect(nonFailing.stdout).toContain("DRIFT DETECTED");
  });

  it("exits 2 on a missing config file (configuration error, distinct from drift)", () => {
    const result = spawnSync("node", [distCli, "check", "--config", "does-not-exist.json"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
  });

  it("renders a future-dated Last Updated clearly instead of a negative day count", () => {
    // QA regression: staleDays goes negative when the state file's "Last
    // Updated" date is in the future (a plausible real mistake — an
    // agent-authored date with the wrong year). The report used to print
    // "(-26450 days ago)", which reads as broken output rather than the
    // actual, useful signal ("this date is in the future").
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody("2099-01-01", "Tracking `docs/plan.md`.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    writeFile(
      repoDir,
      "baton.config.json",
      JSON.stringify({ stateFile: "STATE.md", watchGlobs: ["docs/**"], staleDaysThreshold: 3 }, null, 2)
    );

    const result = spawnSync("node", [distCli, "check"], { cwd: repoDir, encoding: "utf8" });

    expect(result.stdout).toContain("in the future");
    expect(result.stdout).not.toMatch(/-\d+ days? ago/);
  });

  it("exits 2 (not a silent false-clean) when cwd is not inside a git repository", () => {
    // QA-found bug: findRepoRoot() used to swallow `git rev-parse
    // --show-toplevel` failing and fall back to using cwd as-is. The
    // subsequent `git log` call would then also fail (not a git repo) and
    // getCommitsSince()'s catch swallowed *that* into "0 commits found" too
    // — so running baton outside any git repo produced a report that looked
    // like a verified-clean result instead of a clear error. Deliberately do
    // NOT git-init this directory.
    const dir = mkdtempSync(join(tmpdir(), "baton-nogit-"));
    try {
      writeFile(dir, "STATE.md", stateFileBody("2024-01-10", "Tracking nothing."));
      writeFile(
        dir,
        "baton.config.json",
        JSON.stringify({ stateFile: "STATE.md", staleDaysThreshold: 3650 }, null, 2)
      );

      const result = spawnSync("node", [distCli, "check", "--fail-on-drift"], {
        cwd: dir,
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stdout).not.toContain("Result: CLEAN");
      expect(result.stderr).toContain("Not a git repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a real git repo with zero commits as clean, not an error", () => {
    // Distinguishes the fix above from over-correction: a git repo that
    // genuinely has no commits yet ("does not have any commits yet") is a
    // legitimate empty-history case (zero commits since any date is
    // correct), unlike "not a git repository at all". Both would otherwise
    // look the same (`git log` exiting non-zero) if getCommitsSince() didn't
    // distinguish them by message.
    const dir = mkdtempSync(join(tmpdir(), "baton-emptyrepo-"));
    try {
      git(["init", "-q"], dir);
      git(["config", "user.email", "baton-test@example.com"], dir);
      git(["config", "user.name", "Baton Test"], dir);
      git(["config", "commit.gpgsign", "false"], dir);
      writeFile(dir, "STATE.md", stateFileBody("2024-01-10", "Tracking nothing yet."));
      writeFile(
        dir,
        "baton.config.json",
        JSON.stringify({ stateFile: "STATE.md", staleDaysThreshold: 3650 }, null, 2)
      );

      const result = spawnSync("node", [distCli, "check", "--fail-on-drift"], {
        cwd: dir,
        encoding: "utf8",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Result: CLEAN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("single-file stateFile (string) still writes the original flat report.json shape", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    const body = stateFileBody("2024-01-10", "Tracking `docs/plan.md`.");
    writeFile(repoDir, "STATE.md", body);
    commit(repoDir, ["docs/plan.md", "STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    writeFile(
      repoDir,
      "baton.config.json",
      JSON.stringify(
        { stateFile: "STATE.md", watchGlobs: ["docs/**", "projects/**"], staleDaysThreshold: 3650 },
        null,
        2
      )
    );

    const result = spawnSync("node", [distCli, "check", "--fail-on-drift"], {
      cwd: repoDir,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);

    const reportJson = JSON.parse(readFileSync(join(repoDir, ".baton", "report.json"), "utf8"));
    // Backward-compat contract: a single configured `stateFile` string keeps the
    // original flat shape (a top-level `stateFile` key), not the multi-file
    // `stateFiles`/`results` shape, so existing consumers don't break.
    expect(reportJson.stateFile).toBe("STATE.md");
    expect(reportJson.stateFiles).toBeUndefined();
    expect(reportJson.results).toBeUndefined();
    expect(reportJson.hasDrift).toBe(false);
  });
});

describe("baton CLI multi-file stateFile support", () => {
  it("checks multiple state files in one run and reports clean when all are clean", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    const claudeBody = stateFileBody("2024-01-10", "Tracking `docs/plan.md`.");
    const agentsBody = stateFileBody("2024-01-10", "Tracking `docs/plan.md`.");
    writeFile(repoDir, "CLAUDE.md", claudeBody);
    writeFile(repoDir, "AGENTS.md", agentsBody);
    commit(
      repoDir,
      ["docs/plan.md", "CLAUDE.md", "AGENTS.md"],
      "initial commit",
      "2024-01-05T10:00:00+00:00"
    );

    writeFile(
      repoDir,
      "baton.config.json",
      JSON.stringify(
        {
          stateFile: ["CLAUDE.md", "AGENTS.md"],
          watchGlobs: ["docs/**", "projects/**"],
          staleDaysThreshold: 3650,
        },
        null,
        2
      )
    );

    const result = spawnSync("node", [distCli, "check", "--fail-on-drift"], {
      cwd: repoDir,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("DRIFT DETECTED");
    expect(result.stdout).toContain("CLAUDE.md");
    expect(result.stdout).toContain("AGENTS.md");

    const reportJson = JSON.parse(readFileSync(join(repoDir, ".baton", "report.json"), "utf8"));
    expect(reportJson.stateFiles).toEqual(["CLAUDE.md", "AGENTS.md"]);
    expect(reportJson.results).toHaveLength(2);
    expect(reportJson.results.every((r: { hasDrift: boolean }) => r.hasDrift === false)).toBe(true);
    expect(reportJson.hasDrift).toBe(false);
  });

  it("surfaces which file has drift when only one of several is stale", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    // CLAUDE.md claims to be updated *after* the surprise commit below, so it
    // sees zero commits since its own Last Updated date and stays clean.
    const claudeBody = stateFileBody("2024-01-20", "Tracking `docs/plan.md`.");
    // AGENTS.md's Last Updated predates the surprise commit, so that commit
    // shows up as undocumented/orphaned for AGENTS.md specifically.
    const agentsBody = stateFileBody("2024-01-10", "Tracking `docs/plan.md`. Nothing else in flight.");
    writeFile(repoDir, "CLAUDE.md", claudeBody);
    writeFile(repoDir, "AGENTS.md", agentsBody);
    commit(
      repoDir,
      ["docs/plan.md", "CLAUDE.md", "AGENTS.md"],
      "initial commit",
      "2024-01-05T10:00:00+00:00"
    );

    writeFile(repoDir, "projects/newthing.md", "surprise work");
    commit(repoDir, ["projects/newthing.md"], "ship a surprise feature", "2024-01-15T10:00:00+00:00");

    writeFile(
      repoDir,
      "baton.config.json",
      JSON.stringify(
        {
          stateFile: ["CLAUDE.md", "AGENTS.md"],
          watchGlobs: ["docs/**", "projects/**"],
          staleDaysThreshold: 3650,
        },
        null,
        2
      )
    );

    const result = spawnSync("node", [distCli, "check", "--fail-on-drift"], {
      cwd: repoDir,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    // The report must name AGENTS.md, specifically, as the drifting file —
    // not just say "drift detected" somewhere in a combined run.
    expect(result.stdout).toContain("Result: DRIFT DETECTED (AGENTS.md)");
    expect(result.stdout).toContain("Result: CLEAN (CLAUDE.md)");
    expect(result.stdout).toMatch(/DRIFT DETECTED in 1\/2 state file\(s\): AGENTS\.md/);

    const reportJson = JSON.parse(readFileSync(join(repoDir, ".baton", "report.json"), "utf8"));
    expect(reportJson.hasDrift).toBe(true);
    const agentsResult = reportJson.results.find((r: { stateFile: string }) => r.stateFile === "AGENTS.md");
    const claudeResult = reportJson.results.find((r: { stateFile: string }) => r.stateFile === "CLAUDE.md");
    expect(agentsResult.hasDrift).toBe(true);
    expect(agentsResult.orphanedFiles).toContain("projects/newthing.md");
    expect(claudeResult.hasDrift).toBe(false);
  });

  it("still reports on the other files when one configured file has no Last Updated date, instead of aborting the whole run (dogfooding find: macbre/sql-metadata has a Last-Updated AGENTS.md alongside a plain CLAUDE.md with no such heading)", () => {
    writeFile(repoDir, "docs/plan.md", "the plan");
    const agentsBody = stateFileBody("2024-01-10", "Tracking `docs/plan.md`.");
    // CLAUDE.md is a plain instructions file with no "Last Updated" heading
    // at all — a common real-world shape, not a malformed state file.
    const claudeBody = ["# Project instructions", "", "Some guidance for agents.", ""].join("\n");
    writeFile(repoDir, "AGENTS.md", agentsBody);
    writeFile(repoDir, "CLAUDE.md", claudeBody);
    commit(
      repoDir,
      ["docs/plan.md", "CLAUDE.md", "AGENTS.md"],
      "initial commit",
      "2024-01-05T10:00:00+00:00"
    );

    writeFile(
      repoDir,
      "baton.config.json",
      JSON.stringify(
        {
          stateFile: ["CLAUDE.md", "AGENTS.md"],
          watchGlobs: ["docs/**", "projects/**"],
          staleDaysThreshold: 3650,
        },
        null,
        2
      )
    );

    const result = spawnSync("node", [distCli, "check", "--fail-on-drift"], {
      cwd: repoDir,
      encoding: "utf8",
    });

    // Previously this returned 2 (config error) and printed nothing about
    // AGENTS.md at all, discarding a perfectly checkable report because a
    // sibling file lacked the heading.
    expect(result.stdout).toContain("Result: CLEAN (AGENTS.md)");
    expect(result.stdout).toContain("Result: COULD NOT CHECK (CLAUDE.md)");
    expect(result.stdout).toContain("could not be checked: CLAUDE.md");
    // A file that could not be checked at all must still surface as a
    // reason to fail a CI gate, not silently pass as if everything were clean.
    expect(result.status).toBe(1);

    const reportJson = JSON.parse(readFileSync(join(repoDir, ".baton", "report.json"), "utf8"));
    expect(reportJson.stateFiles).toEqual(["AGENTS.md", "CLAUDE.md"]);
    expect(reportJson.results).toHaveLength(1);
    expect(reportJson.results[0].stateFile).toBe("AGENTS.md");
    expect(reportJson.errors).toHaveLength(1);
    expect(reportJson.errors[0].stateFile).toBe("CLAUDE.md");
    expect(reportJson.errors[0].error).toContain("Could not find a \"Last Updated\" date");
    expect(reportJson.hasDrift).toBe(true);
  });

  it("rejects an empty stateFile array as a config error", () => {
    writeFile(repoDir, "STATE.md", stateFileBody("2024-01-10", "nothing"));
    commit(repoDir, ["STATE.md"], "initial commit", "2024-01-05T10:00:00+00:00");

    writeFile(
      repoDir,
      "baton.config.json",
      JSON.stringify({ stateFile: [], staleDaysThreshold: 3650 }, null, 2)
    );

    const result = spawnSync("node", [distCli, "check"], {
      cwd: repoDir,
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('missing required field "stateFile"');
  });
});
