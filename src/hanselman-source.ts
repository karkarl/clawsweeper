import { readReviewGit } from "./pr-review-evidence.js";
import { scanAgentInput } from "./agent-input-scan.js";
import { hanselmanContract } from "./hanselman-contract.js";
import type { HanselmanInput } from "./hanselman-review.js";

export function hanselmanSource(cwd: string, input: HanselmanInput, scan = scanAgentInput) {
  const deadlineAt = Date.now() + input.timeoutMs;
  const limits = hanselmanContract().limits;
  let bytes = 0;
  let calls = 0;
  const git = (args: string[]): string => {
    const data = readReviewGit(cwd, args, { deadlineAt, maxBytes: limits.maxReadBytesPerSession });
    if (!data) throw new Error("Hanselman pinned source read failed or exceeded its budget.");
    return data.toString("utf8");
  };
  const inventory = (sha: string) =>
    new Set(git(["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean));
  const headPaths = inventory(input.headSha);
  const basePaths = inventory(input.baseSha);
  const cache = new Map<string, string>();
  const pinned = (revision: "head" | "base", path: string) => {
    const paths = revision === "head" ? headPaths : basePaths;
    if (
      !paths.has(path) ||
      path.includes("\0") ||
      path.includes("\\") ||
      path.split("/").includes("..")
    ) {
      throw new Error("Hanselman source path is not in the pinned tree.");
    }
    const key = `${revision}:${path}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const sha = revision === "head" ? input.headSha : input.baseSha;
    const text = git(["show", "--no-textconv", `${sha}:${path}`]);
    bytes += Buffer.byteLength(text);
    if (bytes > limits.maxReadBytesPerSession)
      throw new Error("Hanselman source byte budget exceeded.");
    scan({
      cwd,
      prompt: text,
      source: { kind: "prompt" },
      timeoutMs: deadlineAt - Date.now(),
    });
    cache.set(key, text);
    return text;
  };
  const read = (revision: "head" | "base", path: string) => {
    calls += 1;
    if (calls > limits.maxReadCallsPerSession)
      throw new Error("Hanselman source call budget exceeded.");
    return pinned(revision, path);
  };
  const readHeadLines = (path: string, start: number, end: number) => {
    const lines = pinned("head", path).split(/\r?\n/);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end > lines.length
    ) {
      throw new Error("Hanselman finding references nonexistent head lines.");
    }
    return lines.slice(start - 1, end).join("\n");
  };
  const previousHead = input.previousHeadSha;
  const hasPrevious =
    previousHead &&
    /^[0-9a-f]{40}$/.test(previousHead) &&
    readReviewGit(cwd, ["merge-base", "--is-ancestor", previousHead, input.headSha], {
      deadlineAt,
    }) !== null;
  const scopeBase = hasPrevious ? previousHead : input.baseSha;
  const scope = hasPrevious
    ? `Repeat review: delta ${scopeBase}..${input.headSha}, affected callers/tests and previous unresolved/disputed findings. Do not automatically repeat the full review.`
    : `Full review ${input.baseSha}..${input.headSha}: ${previousHead ? "previous head unavailable or not an ancestor" : "no verified previous head"}.`;
  const changed = git([
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--name-only",
    scopeBase,
    input.headSha,
    "--",
  ])
    .split("\n")
    .filter((path) => headPaths.has(path));
  const stems = changed.map((path) =>
    path
      .split("/")
      .at(-1)!
      .replace(/\.[^.]+$/, ""),
  );
  const related = [...headPaths].filter(
    (path) =>
      /\.(?:[cm]?[jt]sx?|cs|cpp|h|rs)$/.test(path) &&
      stems.some((stem) => stem.length > 2 && path.includes(stem)),
  );
  const initialPaths = [...new Set([...changed, ...related])];
  const callerEvidence = stems.length
    ? readReviewGit(
        cwd,
        ["grep", "-n", "-F", ...stems.flatMap((stem) => ["-e", stem]), input.headSha, "--"],
        { deadlineAt, maxBytes: 256 * 1024 },
      )
    : null;
  return {
    read,
    readHeadLines,
    paths: [...headPaths],
    scope,
    callerEvidence:
      callerEvidence?.toString("utf8") ??
      "Caller lookup has no usable matches (or exceeded the bounded read). Inspect the pinned inventory and relevant source; do not assume callers are absent.",
    get changedFiles() {
      return initialPaths
        .map((path) => `## Head source or affected test: ${path}\n${read("head", path)}`)
        .join("\n\n");
    },
    get instructions() {
      return [...basePaths]
        .filter((path) => /(?:^|\/)AGENTS\.md$|^\.github\/copilot-instructions\.md$/.test(path))
        .map((path) => `## Base instructions: ${path}\n${read("base", path)}`)
        .join("\n\n");
    },
  };
}
