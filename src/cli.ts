import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { computeDrift, getCommitsSince, parseStateFile } from "./drift.js";
import type { CommitInfo, DriftReport } from "./drift.js";

interface BatonConfig {
  /**
   * Path(s) to the shared state file(s) to check for drift, relative to
   * `repoRoot`. A single string checks one file (original behavior,
   * unchanged). An array checks every listed file in one run and aggregates
   * the results into a single text report and a single `.baton/report.json`.
   */
  stateFile: string | string[];
  watchGlobs?: string[];
  staleDaysThreshold?: number;
  lastUpdatedHeading?: string;
  repoRoot?: string;
  /**
   * Regex patterns (as raw strings, matched with `new RegExp(pattern).test(path)`)
   * for paths that should never be reported as a dangling reference or an
   * orphaned file — the escape hatch for a reference or file that is
   * intentionally not documented (a planned-but-not-yet-created path, a
   * generated/vendored file, etc.), mirroring the `ignorePatterns` convention
   * tools like markdown-link-check use for known-fine path/URL exceptions.
   */
  ignorePatterns?: string[];
}

/** Normalize `BatonConfig.stateFile` to an array, regardless of which shape was configured. */
function stateFilesOf(config: BatonConfig): string[] {
  return Array.isArray(config.stateFile) ? config.stateFile : [config.stateFile];
}

const DEFAULT_CONFIG_FILENAME = "baton.config.json";

function usage(): string {
  return [
    "Usage: baton check [--config <path>] [--fail-on-drift]",
    "",
    "Options:",
    "  --config <path>   Path to baton.config.json (default: ./baton.config.json)",
    "  --fail-on-drift   Exit 1 when drift is detected or staleness exceeds threshold",
  ].join("\n");
}

function parseArgs(argv: string[]): {
  command: string | null;
  configPath: string;
  failOnDrift: boolean;
} {
  const [command, ...rest] = argv;
  let configPath = DEFAULT_CONFIG_FILENAME;
  let failOnDrift = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--config") {
      const value = rest[i + 1];
      if (!value) throw new Error("--config requires a path argument");
      configPath = value;
      i++;
    } else if (arg === "--fail-on-drift") {
      failOnDrift = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { command: command ?? null, configPath, failOnDrift };
}

/**
 * Validate the raw `stateFile` field from a parsed config file. Accepts a
 * non-empty string (single file, original shape) or a non-empty array of
 * non-empty strings (multi-file). Anything else is a config error.
 */
function validateStateFileField(value: unknown, absConfigPath: string): string | string[] {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0)) {
    return value as string[];
  }
  throw new Error(
    `Config at ${absConfigPath} is missing required field "stateFile" ` +
      `(a non-empty string, or a non-empty array of non-empty strings)`
  );
}

function loadConfig(configPath: string, cwd: string): BatonConfig {
  const absConfigPath = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
  if (!existsSync(absConfigPath)) {
    throw new Error(
      `Config file not found: ${absConfigPath}\nCreate a baton.config.json like:\n` +
        JSON.stringify(
          { stateFile: ["CLAUDE.md", "AGENTS.md"], watchGlobs: ["src/**", "docs/**"], staleDaysThreshold: 3 },
          null,
          2
        )
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absConfigPath, "utf8"));
  } catch (err) {
    throw new Error(`Failed to parse config at ${absConfigPath}: ${(err as Error).message}`);
  }
  const config = raw as Partial<BatonConfig>;
  return {
    stateFile: validateStateFileField(config.stateFile, absConfigPath),
    watchGlobs: config.watchGlobs ?? [],
    staleDaysThreshold: config.staleDaysThreshold ?? 3,
    lastUpdatedHeading: config.lastUpdatedHeading,
    repoRoot: config.repoRoot,
    ignorePatterns: config.ignorePatterns ?? [],
  };
}

/**
 * Compile the raw `ignorePatterns` config strings into `RegExp` objects up
 * front, so a typo'd pattern surfaces as a clean config error (exit 2)
 * instead of throwing mid-scan.
 */
function compileIgnorePatterns(patterns: string[], absConfigPath: string): RegExp[] {
  return patterns.map((pattern) => {
    try {
      return new RegExp(pattern);
    } catch (err) {
      throw new Error(
        `Invalid "ignorePatterns" regex ${JSON.stringify(pattern)} in ${absConfigPath}: ${(err as Error).message}`
      );
    }
  });
}

/**
 * Resolve the repo root via `git rev-parse --show-toplevel`. Deliberately
 * does NOT swallow failure and fall back to `cwd`: Baton's entire premise is
 * diffing a state file against real git history, so running it outside a
 * git repo (or with a broken/missing `git` on PATH) must surface as a clear
 * config/environment error, not silently produce a report as if `cwd` were
 * a verified repo root — `getCommitsSince`'s own git-log call would then
 * also fail and get swallowed into "0 commits found", which reads as a
 * false-clean result instead of "we couldn't check at all".
 */
function findRepoRoot(cwd: string): string {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      // execFileSync inherits the child's stderr by default; git's own
      // "fatal: not a git repository" would otherwise print alongside (and
      // before) our own clean error message below. Pipe it instead so it's
      // just discarded — we throw our own message on failure regardless.
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      `Not a git repository (or any parent directory): ${cwd}\n` +
        `Baton diffs a state file's claims against real git history and requires this path to be ` +
        `inside a git repo, or set "repoRoot" in the config to point at one.`
    );
  }
}

function formatCommit(commit: CommitInfo): string {
  const shortHash = commit.hash.slice(0, 7);
  const dateStr = commit.date.toISOString().slice(0, 10);
  return `  - ${shortHash}  ${dateStr}  ${commit.message}`;
}

function serializeCommit(c: CommitInfo): { hash: string; date: string; message: string; filesChanged: string[] } {
  return { hash: c.hash, date: c.date.toISOString(), message: c.message, filesChanged: c.filesChanged };
}

/**
 * Render the shared "Last updated / Staleness / Undocumented commits /
 * Dangling references / Orphaned files" body for a single file's report.
 * Shared by both the single-file and multi-file (aggregate) text reports so
 * the two stay in lockstep.
 */
function formatDriftBody(report: DriftReport, threshold: number): string[] {
  const lines: string[] = [];
  const staleBreached = report.staleDays > threshold;

  // A future-dated "Last Updated" (a plausible real mistake — e.g. an
  // agent-authored date with the wrong year) makes staleDays negative.
  // "-26450 days ago" reads as broken output; say what actually happened.
  const staleDaysLabel =
    report.staleDays < 0
      ? `${-report.staleDays} day${-report.staleDays === 1 ? "" : "s"} in the future`
      : `${report.staleDays} day${report.staleDays === 1 ? "" : "s"} ago`;

  lines.push(
    `Last updated: ${report.lastUpdated ? report.lastUpdated.toISOString().slice(0, 10) : "unknown"}` +
      ` (${staleDaysLabel})`
  );
  lines.push(`Staleness threshold: ${threshold} day(s) — ${staleBreached ? "EXCEEDED" : "ok"}`);
  lines.push("");

  lines.push(`Undocumented commits (${report.undocumentedCommits.length}):`);
  if (report.undocumentedCommits.length === 0) {
    lines.push("  none");
  } else {
    for (const commit of report.undocumentedCommits) lines.push(formatCommit(commit));
  }
  lines.push("");

  lines.push(`Dangling references (${report.danglingReferences.length}):`);
  if (report.danglingReferences.length === 0) {
    lines.push("  none");
  } else {
    for (const ref of report.danglingReferences) lines.push(`  - ${ref}`);
  }
  lines.push("");

  lines.push(`Orphaned files (${report.orphanedFiles.length}):`);
  if (report.orphanedFiles.length === 0) {
    lines.push("  none");
  } else {
    for (const file of report.orphanedFiles) lines.push(`  - ${file}`);
  }
  lines.push("");

  return lines;
}

/** Text report for the single-file case. Output is byte-identical to pre-multi-file Baton. */
function formatReport(report: DriftReport, config: BatonConfig, stateFileRel: string): string {
  const threshold = config.staleDaysThreshold ?? 3;
  const lines: string[] = [];
  lines.push("Baton drift report");
  lines.push("===================");
  lines.push(`State file: ${stateFileRel}`);
  lines.push(...formatDriftBody(report, threshold));

  const overallDrift = report.hasDrift || report.staleDays > threshold;
  lines.push(overallDrift ? "Result: DRIFT DETECTED" : "Result: CLEAN");

  return lines.join("\n");
}

/** Text report for the multi-file case: one section per file plus an aggregate result line. */
function formatAggregateReport(
  results: Array<{ relativePath: string; report: DriftReport }>,
  config: BatonConfig,
  errors: Array<{ relativePath: string; message: string }> = []
): string {
  const threshold = config.staleDaysThreshold ?? 3;
  const lines: string[] = [];
  lines.push("Baton drift report");
  lines.push("===================");
  lines.push(`State files (${results.length + errors.length}):`);
  for (const { relativePath } of results) lines.push(`  - ${relativePath}`);
  for (const { relativePath } of errors) lines.push(`  - ${relativePath} (could not be checked)`);
  lines.push("");

  const driftingFiles: string[] = [];

  for (const { relativePath, message } of errors) {
    lines.push(`--- ${relativePath} ---`);
    lines.push(message);
    lines.push(`Result: COULD NOT CHECK (${relativePath})`);
    lines.push("");
  }

  for (const { relativePath, report } of results) {
    lines.push(`--- ${relativePath} ---`);
    lines.push(...formatDriftBody(report, threshold));

    const fileDrift = report.hasDrift || report.staleDays > threshold;
    lines.push(fileDrift ? `Result: DRIFT DETECTED (${relativePath})` : `Result: CLEAN (${relativePath})`);
    lines.push("");
    if (fileDrift) driftingFiles.push(relativePath);
  }

  lines.push("===================");
  const erroredSuffix =
    errors.length > 0
      ? ` (${errors.length} file${errors.length === 1 ? "" : "s"} could not be checked: ${errors
          .map((e) => e.relativePath)
          .join(", ")})`
      : "";
  if (driftingFiles.length > 0) {
    lines.push(
      `Result: DRIFT DETECTED in ${driftingFiles.length}/${results.length} state file(s): ${driftingFiles.join(", ")}${erroredSuffix}`
    );
  } else if (errors.length > 0) {
    lines.push(`Result: INCOMPLETE (${results.length} state file${results.length === 1 ? "" : "s"} checked, clean)${erroredSuffix}`);
  } else {
    lines.push(`Result: CLEAN (${results.length} state file${results.length === 1 ? "" : "s"} checked)`);
  }

  return lines.join("\n");
}

export function runCheck(argv: string[], cwd: string): number {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage());
    return 2;
  }

  if (parsed.command !== "check") {
    console.error(usage());
    return parsed.command === null ? 2 : 2;
  }

  let config: BatonConfig;
  let ignorePatterns: RegExp[];
  try {
    config = loadConfig(parsed.configPath, cwd);
    const absConfigPath = isAbsolute(parsed.configPath) ? parsed.configPath : resolve(cwd, parsed.configPath);
    ignorePatterns = compileIgnorePatterns(config.ignorePatterns ?? [], absConfigPath);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  let repoRoot: string;
  try {
    repoRoot = config.repoRoot ? resolve(cwd, config.repoRoot) : findRepoRoot(cwd);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  const threshold = config.staleDaysThreshold ?? 3;

  // A single configured `stateFile: string` (the original shape) always goes
  // through the single-file text/JSON format below, unchanged. Only an
  // explicit array opts into the multi-file aggregate format.
  const isMultiFile = Array.isArray(config.stateFile);
  const stateFiles = stateFilesOf(config);

  const results: Array<{ relativePath: string; report: DriftReport }> = [];
  // Only used in multi-file mode: a file with no "Last Updated" date is a
  // per-file problem, not a reason to discard every other file's already-
  // computed report. In single-file mode this case still returns 2 directly
  // below, unchanged from the original behavior.
  const errors: Array<{ relativePath: string; message: string }> = [];

  try {
    for (const sf of stateFiles) {
      const stateFilePath = resolve(repoRoot, sf);

      if (!existsSync(stateFilePath)) {
        console.error(`State file not found: ${stateFilePath}`);
        return 2;
      }

      const state = parseStateFile(stateFilePath, {
        repoRoot,
        lastUpdatedHeading: config.lastUpdatedHeading,
      });

      if (!state.lastUpdated) {
        const message =
          `Could not find a "Last Updated" date in ${state.relativePath}. ` +
          `Add a heading like "## Last Updated" followed by a YYYY-MM-DD date.`;
        if (!isMultiFile) {
          console.error(message);
          return 2;
        }
        errors.push({ relativePath: state.relativePath, message });
        continue;
      }

      const commits = getCommitsSince(repoRoot, state.lastUpdated, config.watchGlobs ?? []);
      const report = computeDrift(repoRoot, state, commits, { ignorePatterns });
      results.push({ relativePath: state.relativePath, report });
    }
  } catch (err) {
    // getCommitsSince throws for real git failures (e.g. a misconfigured
    // `repoRoot` that isn't a git repository) rather than silently
    // reporting zero commits — see drift.ts. Surface it the same clean way
    // as the other config/environment errors above.
    console.error((err as Error).message);
    return 2;
  }

  if (results.length === 0) {
    // Multi-file mode where every configured file lacked a "Last Updated"
    // date: nothing was checkable, so this is the same class of config
    // error as the single-file case, just reported per-file.
    for (const { message } of errors) console.error(message);
    return 2;
  }

  const reportText = isMultiFile
    ? formatAggregateReport(results, config, errors)
    : formatReport(results[0].report, config, results[0].relativePath);
  console.log(reportText);

  const batonDir = resolve(repoRoot, ".baton");
  mkdirSync(batonDir, { recursive: true });

  // A file that could not be checked at all is at least as bad as drift for
  // `--fail-on-drift` purposes — a CI gate that only reads the exit code
  // must not see a silent "0/passed" while one configured file was never
  // actually verified.
  const overallDrift = results.some(({ report }) => report.hasDrift || report.staleDays > threshold) || errors.length > 0;

  const jsonReport = isMultiFile
    ? {
        generatedAt: new Date().toISOString(),
        stateFiles: [...results.map((r) => r.relativePath), ...errors.map((e) => e.relativePath)],
        config: {
          watchGlobs: config.watchGlobs ?? [],
          staleDaysThreshold: threshold,
          ignorePatterns: config.ignorePatterns ?? [],
        },
        results: results.map(({ relativePath, report }) => ({
          stateFile: relativePath,
          lastUpdated: report.lastUpdated ? report.lastUpdated.toISOString() : null,
          staleDays: report.staleDays,
          undocumentedCommits: report.undocumentedCommits.map(serializeCommit),
          danglingReferences: report.danglingReferences,
          orphanedFiles: report.orphanedFiles,
          hasDrift: report.hasDrift || report.staleDays > threshold,
        })),
        errors: errors.map(({ relativePath, message }) => ({ stateFile: relativePath, error: message })),
        hasDrift: overallDrift,
      }
    : {
        generatedAt: new Date().toISOString(),
        stateFile: results[0].relativePath,
        config: {
          watchGlobs: config.watchGlobs ?? [],
          staleDaysThreshold: threshold,
          ignorePatterns: config.ignorePatterns ?? [],
        },
        lastUpdated: results[0].report.lastUpdated ? results[0].report.lastUpdated.toISOString() : null,
        staleDays: results[0].report.staleDays,
        undocumentedCommits: results[0].report.undocumentedCommits.map(serializeCommit),
        danglingReferences: results[0].report.danglingReferences,
        orphanedFiles: results[0].report.orphanedFiles,
        hasDrift: overallDrift,
      };
  writeFileSync(resolve(batonDir, "report.json"), `${JSON.stringify(jsonReport, null, 2)}\n`);

  if (parsed.failOnDrift && overallDrift) {
    return 1;
  }
  return 0;
}

function main(): void {
  const exitCode = runCheck(process.argv.slice(2), process.cwd());
  process.exit(exitCode);
}

main();
