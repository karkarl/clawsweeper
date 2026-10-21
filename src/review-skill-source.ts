import { trustedReviewGitExecutable } from "./agent-input-scan.js";
import { posix } from "node:path";
import type { ReviewFinding } from "./clawsweeper-types.js";
import type { ReviewSkillSelection } from "./review-skill-config.js";
import { readReviewGit, reviewMergeBase } from "./pr-review-evidence.js";
import { sha256 } from "./content-hash.js";
import { stableJson } from "./stable-json.js";

export interface PinnedReviewSkill {
  slug: string;
  revision: string;
  digest: string;
  files: { path: string; sha256: string; content: string }[];
}
export type PreparedReviewSkill = { selection: ReviewSkillSelection; gitExecutable?: string } & (
  | { skill: PinnedReviewSkill; sourceFailure?: never }
  | { skill?: never; sourceFailure: { kind: "pinned_skill_source_unavailable"; revision: string } }
);
export function preparePinnedReviewSkill(
  cwd: string,
  revision: string,
  selection: ReviewSkillSelection,
): PreparedReviewSkill {
  try {
    const gitExecutable = trustedReviewGitExecutable(cwd);
    return {
      selection,
      gitExecutable,
      skill: loadPinnedReviewSkill(
        cwd,
        revision,
        selection.slug,
        Date.now() + 10_000,
        gitExecutable,
      ),
    };
  } catch {
    return { selection, sourceFailure: { kind: "pinned_skill_source_unavailable", revision } };
  }
}
export function preparedSkillSourceDigest(prepared: PreparedReviewSkill): string {
  return prepared.skill ? prepared.skill.digest : "unavailable:" + prepared.sourceFailure.revision;
}
export function skillPatchBase(
  cwd: string,
  baseTip: string,
  headSha: string,
  localRange: boolean,
  deadlineAt: number,
  executable?: string,
): string {
  const gitExecutable = trustedReviewGitExecutable(cwd, executable);
  assertSkillRevision(baseTip);
  assertSkillRevision(headSha);
  if (localRange) return baseTip;
  const base = reviewMergeBase(cwd, baseTip, headSha, { deadlineAt, executable: gitExecutable });
  if (base.status !== "verified")
    throw new Error("Review skill introduced patch merge base unavailable or ambiguous.");
  return base.sha;
}
const FILE_BYTES = 128 * 1024;
const SKILL_BYTES = 512 * 1024;
export function assertSkillRevision(sha: string): void {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha))
    throw new Error("Review skill requires exact pinned Git revisions.");
}
export function assertSkillSourcePath(path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((p) => !p || p === "." || p === "..") ||
    path.split("").some((character) => character.charCodeAt(0) < 32 || character === ":")
  )
    throw new Error("Review skill refused unsafe source path.");
}
// Tool-visible path inventories are untrusted source too, including unchanged
// names that were absent from the initial changed-file evidence.
export function scanSkillSourceListing(raw: Buffer, scan: (text: string) => void): string {
  const listing = decodeSkillUtf8(raw)
    .split("\0")
    .filter(Boolean)
    .map((path) => JSON.stringify(path))
    .join("\n");
  scan(listing);
  return listing;
}

// Shared lossless decoder for raw Git text and NUL-delimited path inventories.
// Replacement characters introduced by decoding are never an exact source pin.
export function decodeSkillUtf8(raw: Buffer): string {
  const text = raw.toString("utf8");
  if (!Buffer.from(text).equals(raw))
    throw new Error("Review skill Git source/path inventory must be lossless UTF-8.");
  return text;
}
export function readSkillBlob(
  cwd: string,
  revision: string,
  path: string,
  deadlineAt: number,
  executable?: string,
): string {
  const gitExecutable = trustedReviewGitExecutable(cwd, executable);
  assertSkillRevision(revision);
  assertSkillSourcePath(path);
  const entry = readReviewGit(cwd, ["ls-tree", "-z", revision, "--", path], {
    deadlineAt,
    maxBytes: 4096,
    executable: gitExecutable,
  })?.toString("utf8");
  if (
    !entry ||
    !/^100(?:644|755) blob [0-9a-f]+\t/.test(entry) ||
    entry.split("\t")[1] !== path + "\0"
  )
    throw new Error("Review skill source must be a regular pinned Git blob.");
  const raw = readReviewGit(cwd, ["cat-file", "blob", revision + ":" + path], {
    deadlineAt,
    maxBytes: FILE_BYTES + 1,
    executable: gitExecutable,
  });
  if (!raw || raw.length > FILE_BYTES || raw.includes(0))
    throw new Error("Review skill source unavailable, binary or over byte budget.");
  return decodeSkillUtf8(raw);
}
// Read every local Markdown destination and explicit backtick references/ path,
// recursively. Files are text only: loading a reference never executes it.
function referencePaths(content: string): string[] {
  const paths = [
    ...content.matchAll(
      /\[[^\]\n]*\]\([ \t]*(?:<([^>\r\n]*)>|([^\s)<>]+))(?:[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*'))?[ \t]*\)/g,
    ),
  ].map((match) => match[1] ?? match[2]!);
  paths.push(
    ...[...content.matchAll(/^[ \t]*\[[^\]\n]+\]:[ \t]*(?:<([^>\r\n]*)>|([^\s<>]+))/gm)].map(
      (match) => match[1] ?? match[2]!,
    ),
  );
  paths.push(
    ...[...content.matchAll(/\x60((?:\.\.?\/|references\/)[^\x60\s]+)\x60/g)].map((m) => m[1]!),
  );
  return paths.filter((path) => !path.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(path));
}
export function loadPinnedReviewSkill(
  cwd: string,
  revision: string,
  slug: string,
  deadlineAt = Date.now() + 10_000,
  executable?: string,
): PinnedReviewSkill {
  const gitExecutable = trustedReviewGitExecutable(cwd, executable);
  assertSkillRevision(revision);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) throw new Error("Invalid review skill slug.");
  const root = ".agents/skills/" + slug;
  const queue = [root + "/SKILL.md"];
  const files: PinnedReviewSkill["files"] = [];
  const seen = new Set<string>();
  let bytes = 0;
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    if (seen.size > 24) throw new Error("Review skill reference count exceeded.");
    const content = readSkillBlob(cwd, revision, path, deadlineAt, gitExecutable);
    bytes += Buffer.byteLength(content);
    if (bytes > SKILL_BYTES) throw new Error("Review skill transitive byte budget exceeded.");
    files.push({ path, content, sha256: sha256(content) });
    for (const raw of referencePaths(content)) {
      const ref = decodeURIComponent(raw.split("#")[0]!);
      if (!ref) continue;
      if (ref.includes("?") || ref.startsWith("/") || ref.includes("\\"))
        throw new Error("Review skill reference path escape.");
      const dest = posix.normalize(posix.join(posix.dirname(path), ref));
      if (!dest.startsWith(root + "/")) throw new Error("Review skill reference path escape.");
      assertSkillSourcePath(dest);
      queue.push(dest);
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { slug, revision, files, digest: sha256(stableJson({ revision, files })) };
}
export function pinnedSkillEvidence(
  cwd: string,
  headSha: string,
  baseSha: string,
  deadlineAt: number,
  executable?: string,
): string {
  const gitExecutable = trustedReviewGitExecutable(cwd, executable);
  assertSkillRevision(headSha);
  assertSkillRevision(baseSha);
  const paths = readReviewGit(
    cwd,
    ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", baseSha, headSha, "--"],
    { deadlineAt, maxBytes: 64 * 1024, executable: gitExecutable },
  );
  if (!paths) throw new Error("Review skill changed-source inventory unavailable.");
  const files = decodeSkillUtf8(paths).split("\0").filter(Boolean);
  if (files.length > 80) throw new Error("Review skill changed-source count exceeded.");
  let bytes = 0;
  return files
    .map((path) => {
      assertSkillSourcePath(path);
      // Deletions have no head blob; the base remains available through read_source.
      const present = readReviewGit(cwd, ["ls-tree", "-z", headSha, "--", path], {
        deadlineAt,
        maxBytes: 4096,
        executable: gitExecutable,
      });
      if (present === null) throw new Error("Review skill head-path lookup unavailable.");
      const content = present.length
        ? readSkillBlob(cwd, headSha, path, deadlineAt, gitExecutable)
        : "[deleted at head; inspect base with read_source]";
      bytes += Buffer.byteLength(content);
      if (bytes > 2 * 1024 * 1024)
        throw new Error("Review skill changed-source byte budget exceeded.");
      return "Pinned head source: " + path + "\n" + content;
    })
    .join("\n\n");
}

// A base read never substitutes for current head source. Only a successful raw
// tree lookup proving absence at head admits a deletion finding at base.
export function verifyPinnedSkillFinding(
  cwd: string,
  headSha: string,
  baseSha: string,
  finding: ReviewFinding,
  inspected: ReadonlySet<string>,
  deadlineAt: number,
  executable?: string,
): "head" | "base" {
  const gitExecutable = trustedReviewGitExecutable(cwd, executable);
  assertSkillRevision(headSha);
  assertSkillRevision(baseSha);
  assertSkillSourcePath(finding.file);
  const headEntry = readReviewGit(cwd, ["ls-tree", "-z", headSha, "--", finding.file], {
    deadlineAt,
    maxBytes: 4096,
    executable: gitExecutable,
  });
  if (!headEntry) throw new Error("Review skill head-path verification unavailable.");
  const revision = headEntry.length ? "head" : "base";
  if (!inspected.has(revision + ":" + finding.file))
    throw new Error("Review skill coordinator did not inspect finding revision/file.");
  const content = readSkillBlob(
    cwd,
    revision === "head" ? headSha : baseSha,
    finding.file,
    deadlineAt,
    gitExecutable,
  );
  const lines = content.split("\n");
  if (
    finding.lineStart < 1 ||
    finding.lineEnd < finding.lineStart ||
    finding.lineEnd > lines.length ||
    finding.lineEnd - finding.lineStart > 20
  )
    throw new Error("Review skill finding source lines invalid.");
  return revision;
}
