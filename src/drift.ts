import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** A single git commit, as parsed from `git log`. */
export interface CommitInfo {
  hash: string;
  date: Date;
  message: string;
  /** Repo-relative, forward-slash paths touched by this commit. */
  filesChanged: string[];
}

/** Parsed representation of a shared state/coordination file. */
export interface StateFileData {
  /** Absolute path to the state file that was parsed. */
  path: string;
  /** Repo-relative path to the state file (forward-slash). */
  relativePath: string;
  /** The declared "Last Updated" timestamp, or null if none was found. */
  lastUpdated: Date | null;
  /** File/directory paths the state file's body appears to reference. */
  referencedPaths: string[];
  /** Full raw text of the file. */
  body: string;
}

export interface DriftReport {
  lastUpdated: Date | null;
  staleDays: number;
  undocumentedCommits: CommitInfo[];
  danglingReferences: string[];
  orphanedFiles: string[];
  /** True if any drift category (excluding staleness) is non-empty. */
  hasDrift: boolean;
}

const DEFAULT_LAST_UPDATED_HEADING = "Last Updated";

/** Normalize a filesystem path to forward slashes for cross-platform, git-style comparison. */
function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Extract a date from a line of text. Accepts `YYYY-MM-DD` (optionally
 * followed by a time component) anywhere in the line.
 */
function extractDate(line: string): Date | null {
  const match = line.match(/(\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)/);
  if (!match) return null;
  const parsed = new Date(match[1].includes("T") || match[1].includes(" ") ? match[1].replace(" ", "T") : match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Find the "Last Updated" declaration in a state file's body. Looks for a
 * markdown heading matching `headingText` (default "Last Updated"), then
 * scans the following few lines for a date.
 */
function findLastUpdated(body: string, headingText: string): Date | null {
  const lines = body.split("\n");
  const escapedHeading = headingText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingRegex = new RegExp(`^#{1,6}\\s*${escapedHeading}\\s*$`, "i");
  // Allow the label to be wrapped in markdown emphasis markers, e.g.
  // "**Last Updated**: 2026-08-01" — a bold pseudo-heading is as common in
  // the wild as a real markdown heading, and without this the label is
  // invisible to the regex (the "**" sits between the text and the colon).
  const inlineRegex = new RegExp(`[*_]{0,2}${escapedHeading}[*_]{0,2}\\s*[:\\-]\\s*(.+)`, "i");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (headingRegex.test(line.trim())) {
      // Scan the next few non-empty lines for a date.
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const candidate = lines[j].trim();
        if (!candidate) continue;
        const date = extractDate(candidate);
        if (date) return date;
        // Stop at the next heading without finding a date.
        if (/^#{1,6}\s/.test(candidate)) break;
      }
    }
    const inlineMatch = line.match(inlineRegex);
    if (inlineMatch) {
      const date = extractDate(inlineMatch[1]);
      if (date) return date;
    }
  }
  return null;
}

/**
 * Extract candidate file/directory paths referenced in a markdown body.
 * Grounded against the real repo: a candidate is kept if it has a file
 * extension, ends with a trailing slash, or its first path segment matches
 * a real top-level entry in the repo — this avoids false positives like
 * "CI/CD" or "GTM/pricing" showing up as bogus path references.
 */
function extractReferencedPaths(body: string, repoRoot: string): string[] {
  // Strip every URL-shaped token, not just http(s): a bare "ftp://host/a/b.txt"
  // or "mailto:user@host/inbox.txt" is exactly as slash-and-dot-shaped as a
  // real path, and generalizing the scheme match (any "word://" prefix, plus
  // the schemeless "mailto:") catches those without needing an enumerated
  // scheme list. An SCP-style "user@host:path/to/file" has no "//" at all, so
  // it needs its own pattern; the "no space right after the colon" shape is
  // what distinguishes it from ordinary prose like "jane@example.com: thanks"
  // (SCP paths are never written with a space after the colon).
  // Docker Hub image references ("image: grafana/grafana:latest" in an
  // embedded docker-compose block) are exactly as slash-shaped as a real
  // two-segment repo path, and infra-documenting state files routinely name
  // a top-level config directory after the same service ("grafana/",
  // "nginx/", "redis/") — so the image's namespace segment coincidentally
  // roots to a real top-level entry, and "grafana/grafana" gets reported as
  // a dangling path when the image is really "grafana/grafana:latest".
  // Requiring both segments to be dot-free (no [.] in the character class)
  // is what keeps this from also swallowing a real "file:line" reference
  // like "src/foo.ts:42" — that last segment has a dot, so it's untouched.
  const withoutUrls = body
    .replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g, " ")
    .replace(/\bmailto:\S+/g, " ")
    .replace(/\b[\w.-]+@[\w.-]+:[\w./-]+/g, " ")
    .replace(/\b[\w-]+\/[\w-]+:[\w.-]+\b/g, " ");
  // Second alternative: real AGENTS.md/CLAUDE.md files in the wild commonly
  // name a top-level directory as a bare root-relative mention — "(`/src`)",
  // "(`/transform`)" — with no second "/" for the first alternative's
  // (?:[\w.-]+\/)+ to anchor on, so it would otherwise never match at all.
  // The first alternative's own leading "/?" keeps a multi-segment absolute
  // path (`/app/src`) matching greedily as one candidate before the second
  // alternative is ever tried, so the lookbehind on the second alternative
  // only ever fires at a genuine token boundary, never mid-path.
  const candidateRegex = /`?(\/?(?:[\w.-]+\/)+[\w.-]*|(?<![\w.-])\/[\w.-]+)`?/g;
  const found = new Set<string>();

  let topLevelEntries: Set<string>;
  try {
    topLevelEntries = new Set(readdirSync(repoRoot));
  } catch {
    topLevelEntries = new Set();
  }

  let match: RegExpExecArray | null;
  while ((match = candidateRegex.exec(withoutUrls)) !== null) {
    let candidate = match[1];
    // Trim trailing punctuation that isn't part of a real path.
    candidate = candidate.replace(/[.,;:)]+$/, "");

    // A leading "/" in these state files denotes repo-root-relative prose
    // ("/src" meaning the repo's src/ dir), not a filesystem-absolute path —
    // strip it before resolving against repoRoot. resolve() would otherwise
    // treat a leading "/" as absolute and ignore repoRoot entirely.
    const hadLeadingSlash = candidate.startsWith("/");
    if (hadLeadingSlash) candidate = candidate.slice(1);
    if (candidate.length === 0) continue;

    // Real repo-relative path mentions in these state files are always
    // forward references (no parent-directory traversal), so a literal
    // ".." can only mean this candidate isn't a path at all — most commonly
    // a git ref range like `origin/main..HEAD` or `main...feature` mentioned
    // in prose (this very file's own Next Action says "check `git log
    // origin/main..HEAD`"). Without this guard, ".HEAD" satisfies the
    // hasExtension heuristic below (a dot followed by 1-10 alnum chars) and
    // the whole refspec gets reported as a dangling path reference.
    if (candidate.includes("..")) continue;

    // Prose sometimes names two unrelated files back-to-back joined by a
    // bare "/" with no space — "the AGENTS.md/CLAUDE.md examples" — because
    // both filenames are being mentioned together, not because one is nested
    // inside the other. A genuine nested path only ever has an extension on
    // its *last* segment ("src/drift.ts"); when every segment independently
    // ends in something extension-shaped, the "/" is prose punctuation, not
    // a path separator, so split into separate filename candidates instead
    // of reporting one bogus compound path.
    const segments = candidate.split("/");
    if (segments.length > 1 && segments.every((seg) => /\.[A-Za-z0-9]{1,10}$/.test(seg))) {
      for (const seg of segments) found.add(seg);
      continue;
    }

    const hasExtension = /\.[A-Za-z0-9]{1,10}$/.test(candidate);
    const isDirLike = candidate.endsWith("/") || hadLeadingSlash;
    const firstSegment = candidate.split("/")[0];
    const rootsToRealEntry = topLevelEntries.has(firstSegment);

    // A trailing slash (or a leading one denoting root-relative) alone is
    // weak evidence: prose regularly produces slash-adjacent non-path tokens
    // that happen to satisfy isDirLike — "distribution/`workflow`-scope",
    // "Cycles #25/#26", "`~/.ssh/`" (the leading `~` isn't part of the
    // [\w.-]+ class, so the match silently starts after it, stripping the
    // home-dir marker and leaving a bogus repo-relative candidate). Real
    // intentional path mentions in these markdown state files are, by
    // convention (see every fixture above), wrapped in backticks. When
    // isDirLike is the *only* qualifying signal, require that backtick
    // wrapping as corroboration; hasExtension and rootsToRealEntry remain
    // sufficient on their own.
    const isBacktickWrapped = match[0].startsWith("`") && match[0].endsWith("`");
    const qualifies = hasExtension || rootsToRealEntry || (isDirLike && isBacktickWrapped);

    if (qualifies) {
      found.add(candidate.replace(/\/$/, ""));
    }
  }

  return [...found];
}

/**
 * Parse a shared state file: pull out its declared last-updated date and
 * every file/directory path its body appears to reference.
 */
export function parseStateFile(
  path: string,
  options: { repoRoot?: string; lastUpdatedHeading?: string } = {}
): StateFileData {
  const absPath = isAbsolute(path) ? path : resolve(path);
  const repoRoot = options.repoRoot ?? resolve(absPath, "..");
  const heading = options.lastUpdatedHeading ?? DEFAULT_LAST_UPDATED_HEADING;

  const body = readFileSync(absPath, "utf8");
  const lastUpdated = findLastUpdated(body, heading);
  const referencedPaths = extractReferencedPaths(body, repoRoot);

  return {
    path: absPath,
    relativePath: toPosix(relative(repoRoot, absPath)),
    lastUpdated,
    referencedPaths,
    body,
  };
}

/**
 * Shell out to real `git log` to list commits since `since`, restricted to
 * `watchGlobs` pathspecs (if provided). No mocking — this runs actual git.
 */
export function getCommitsSince(
  repoPath: string,
  since: Date,
  watchGlobs: string[] = []
): CommitInfo[] {
  const RS = "\x1e"; // record separator between commits
  const US = "\x1f"; // unit separator between fields

  const args = [
    "-C",
    repoPath,
    "log",
    `--since=${since.toISOString()}`,
    "--date=iso-strict",
    "--name-only",
    `--pretty=format:${RS}%H${US}%ad${US}%s`,
  ];
  if (watchGlobs.length > 0) {
    args.push("--", ...watchGlobs);
  }

  let stdout: string;
  try {
    stdout = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    // A genuinely empty, historyless repo ("does not have any commits yet")
    // legitimately has zero commits since any date — treat that specific
    // failure as an empty result, matching `git log`'s own zero-commits
    // behavior. Any other git failure (not a git repository, a misconfigured
    // `repoRoot`, git missing from PATH, ...) must NOT be swallowed the same
    // way — that would be indistinguishable from a genuinely clean result
    // and defeats the entire point of a drift checker. Let those propagate.
    if (typeof e.stdout === "string" && /does not have any commits yet/.test(e.stderr ?? "")) {
      stdout = e.stdout;
    } else {
      throw err;
    }
  }

  const blocks = stdout.split(RS).filter((b) => b.trim().length > 0);
  const commits: CommitInfo[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    const header = lines[0];
    const [hash, dateStr, ...messageParts] = header.split(US);
    const message = messageParts.join(US);
    const filesChanged = lines
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map(toPosix);

    commits.push({
      hash,
      date: new Date(dateStr),
      message,
      filesChanged,
    });
  }

  return commits;
}

/**
 * Check whether `token` appears in `body` as a standalone match rather than
 * embedded inside a larger word. A plain `body.includes(token)` treats a
 * short commit message like "fix" or "sync" as "documented" whenever it's a
 * substring of an unrelated word already in the prose ("prefix", "resync") —
 * for a commit that touches no files (nothing for the orphanedFiles safety
 * net to catch), that made the commit's drift vanish from the report
 * entirely, same failure class as the empty-message bug below.
 */
function containsWholeMatch(body: string, token: string): boolean {
  if (token.length === 0) return false;
  const startsWord = /\w/.test(token[0]);
  const endsWord = /\w/.test(token[token.length - 1]);
  let fromIndex = 0;
  while (true) {
    const idx = body.indexOf(token, fromIndex);
    if (idx === -1) return false;
    const before = idx > 0 ? body[idx - 1] : "";
    const after = idx + token.length < body.length ? body[idx + token.length] : "";
    const leftOk = !startsWord || !/\w/.test(before);
    const rightOk = !endsWord || !/\w/.test(after);
    if (leftOk && rightOk) return true;
    fromIndex = idx + 1;
  }
}

interface ResolvedRef {
  original: string;
  relPath: string;
  isDirectory: boolean;
}

function resolveReferences(repoRoot: string, referencedPaths: string[]): {
  resolved: ResolvedRef[];
  dangling: string[];
} {
  const resolved: ResolvedRef[] = [];
  const pending: string[] = [];

  for (const ref of referencedPaths) {
    const directAbs = resolve(repoRoot, ref);
    if (existsSync(directAbs)) {
      resolved.push({
        original: ref,
        relPath: toPosix(relative(repoRoot, directAbs)),
        isDirectory: statSync(directAbs).isDirectory(),
      });
    } else {
      pending.push(ref);
    }
  }

  // Directory context for resolving bare paths mentioned without their
  // subdirectory prefix (e.g. `src/drift.ts` meaning `projects/baton/src/
  // drift.ts`) comes from two sources: bare directory mentions resolved
  // directly above (`projects/baton`), and — since real prose typically
  // states a nested path in full once (`projects/baton/src/cli.ts`) and only
  // its trailing segments thereafter, never repeating the containing
  // directory as its own standalone mention — the ancestor directories of
  // every directly-resolved *file* path too.
  const dirContexts = new Set<string>();
  for (const ref of resolved) {
    if (ref.isDirectory) {
      dirContexts.add(ref.relPath);
      continue;
    }
    const segments = ref.relPath.split("/");
    for (let i = 1; i < segments.length; i++) {
      dirContexts.add(segments.slice(0, i).join("/"));
    }
  }

  const dangling: string[] = [];
  for (const ref of pending) {
    const contextAbs = [...dirContexts].map((dir) => resolve(repoRoot, dir, ref)).find(existsSync);
    if (contextAbs) {
      resolved.push({
        original: ref,
        relPath: toPosix(relative(repoRoot, contextAbs)),
        isDirectory: statSync(contextAbs).isDirectory(),
      });
      continue;
    }

    dangling.push(ref);
  }

  return { resolved, dangling };
}

/**
 * Compute drift between a parsed state file and the commits that landed
 * since its last-updated timestamp.
 */
export function computeDrift(
  repoRoot: string,
  state: StateFileData,
  commits: CommitInfo[],
  options: { ignorePatterns?: RegExp[] } = {}
): DriftReport {
  const ignorePatterns = options.ignorePatterns ?? [];
  const isIgnored = (path: string): boolean => ignorePatterns.some((re) => re.test(path));

  const { resolved, dangling: allDangling } = resolveReferences(repoRoot, state.referencedPaths);
  const dangling = allDangling.filter((ref) => !isIgnored(ref));
  const fileRefs = new Set(resolved.filter((r) => !r.isDirectory).map((r) => r.relPath));

  const isDocumented = (filePath: string): boolean => {
    if (filePath === state.relativePath) return true;
    if (fileRefs.has(filePath)) return true;
    // Deliberately NOT a directory-prefix match: a bare directory mention
    // (e.g. `projects/dashboard/` in an "Active Projects" line) is real
    // evidence for resolveReferences' bare-subpath context (Cycle 13/48
    // above) but must not blanket-immunize every file ever committed under
    // that directory from undocumented-commit/orphaned-file detection.
    // Naming a project's root directory once is the single most common
    // thing a state file does, and it happens on cycle 1 for the life of
    // the project — treating it as "documents everything below forever"
    // would silently blind Baton to exactly the drift it exists to catch
    // (Cycle 69: found dogfooding against a real external repo's
    // consensus-style state file, where a project directory named once in
    // an early cycle made every later, unrelated commit under that
    // directory permanently invisible).
    // Same false-negative class as the commit-message check below: a plain
    // `.includes(filePath)` treats a short path like "a.ts" as "documented"
    // whenever it's embedded in an unrelated longer word already in the
    // prose ("schema.ts") — silently hiding real orphaned-file/undocumented-
    // commit drift for exactly the short, common filenames real repos have.
    if (containsWholeMatch(state.body, filePath)) return true;
    return false;
  };

  const undocumentedCommits = commits.filter((commit) => {
    const shortHash = commit.hash.slice(0, 7);
    // Same false-negative class as the file-path check above: a plain
    // `.includes()` treats a short hash as "documented" whenever it's
    // embedded inside an unrelated longer hex string already in the prose
    // (hex has only 16 symbols, so this happens by chance more often than
    // English-word substrings would). containsWholeMatch is safe for the
    // full hash too — a real reference to it is never itself embedded
    // inside a longer hex run in practice.
    if (containsWholeMatch(state.body, commit.hash) || containsWholeMatch(state.body, shortHash))
      return false;
    // Guard against `commit.message` being empty (`git commit
    // --allow-empty-message`): `"".includes("")` — and therefore
    // `body.includes("")` — is always true, which would silently mark any
    // empty-message commit as "documented" regardless of what it touched.
    if (commit.message.length > 0 && containsWholeMatch(state.body, commit.message)) return false;
    if (commit.filesChanged.some((f) => isDocumented(f))) return false;
    return true;
  });

  const changedFiles = new Set<string>();
  for (const commit of commits) {
    for (const f of commit.filesChanged) changedFiles.add(f);
  }

  const orphanedFiles = [...changedFiles]
    .filter((f) => f !== state.relativePath)
    .filter((f) => !isDocumented(f))
    .filter((f) => !isIgnored(f))
    .sort();

  const staleDays = state.lastUpdated
    ? Math.floor((Date.now() - state.lastUpdated.getTime()) / (1000 * 60 * 60 * 24))
    : 0;

  const hasDrift =
    undocumentedCommits.length > 0 || dangling.length > 0 || orphanedFiles.length > 0;

  return {
    lastUpdated: state.lastUpdated,
    staleDays,
    undocumentedCommits,
    danglingReferences: dangling,
    orphanedFiles,
    hasDrift,
  };
}
