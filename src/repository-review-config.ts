import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, posix } from "node:path";
import MarkdownIt from "markdown-it/browser";
import { parse } from "yaml";
import { readReviewGit } from "./pr-review-evidence.js";
import { fetchReviewBlobs } from "./clawsweeper-review-blobs.js";
import { sha256 } from "./content-hash.js";
import { stableJson } from "./stable-json.js";

const CONFIG_PATH = ".clawsweeper/review.json";
const MAX_BYTES = 256 * 1024;
const MAX_FILES = 64;
const markdown = new MarkdownIt();
export interface RepositoryReviewConfig {
  revision: string;
  digest: string;
  additionalPrompt: string;
  skills: Array<{ name: string; directory: string }>;
  files: Array<{ path: string; text: string }>;
  configText: string;
}

// The caller supplies its verified target-branch revision, never the PR head.
export function loadRepositoryReviewConfig(
  cwd: string,
  revision: string,
  options: { allowFetch?: boolean } = {},
): RepositoryReviewConfig | undefined {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Invalid target review configuration revision.");
  const deadlineAt = Date.now() + 10_000;
  const read = (args: string[], maxBytes = MAX_BYTES): string => {
    if (maxBytes <= 0) throw new Error("Native skill bundle exceeds text budget.");
    const bytes = readReviewGit(cwd, args, {
      maxBytes,
      deadlineAt,
      lazyFetch: options.allowFetch === true && args[0] === "ls-tree",
    });
    if (!bytes) throw new Error("Cannot read pinned repository review configuration.");
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes))
      throw new Error("Review configuration must be UTF-8 text.");
    return text;
  };
  const entries = (path: string) =>
    read(["ls-tree", "-r", "-z", revision, "--", path])
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(entry);
        if (!match) throw new Error("Review configuration cannot contain symlinks or submodules.");
        return { oid: match[2]!, path: match[3]! };
      });
  const configEntries = entries(CONFIG_PATH);
  if (!configEntries.length) return undefined;
  if (configEntries.length !== 1 || configEntries[0]!.path !== CONFIG_PATH)
    throw new Error("Repository review configuration must be a regular file.");
  const prefetch = (objectIds: string[]) => {
    if (options.allowFetch && objectIds.length && !fetchReviewBlobs(cwd, objectIds, deadlineAt))
      throw new Error("Cannot fetch pinned repository review configuration.");
  };
  prefetch([configEntries[0]!.oid]);
  const configText = read(["cat-file", "blob", configEntries[0]!.oid], 16 * 1024);
  const config: unknown = JSON.parse(configText);
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("Repository review configuration must be an object.");
  const value = config as Record<string, unknown>;
  if (
    value.version !== 1 ||
    Object.keys(value).some((key) => !["version", "skills", "additionalPrompt"].includes(key))
  )
    throw new Error("Unsupported repository review configuration.");
  const selected = value.skills === undefined ? [] : value.skills;
  const additionalPrompt = value.additionalPrompt === undefined ? "" : value.additionalPrompt;
  if (
    !Array.isArray(selected) ||
    selected.length > 8 ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => typeof name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) ||
    typeof additionalPrompt !== "string" ||
    additionalPrompt.length > 5_000
  )
    throw new Error("Invalid repository review skills or additionalPrompt.");
  if (!selected.length && !additionalPrompt.trim()) return undefined;
  const files: RepositoryReviewConfig["files"] = [];
  const skills: RepositoryReviewConfig["skills"] = [];
  let size = Buffer.byteLength(configText);
  const bundles = (selected as string[]).map((directory) => ({
    directory,
    bundle: entries(".agents/skills/" + directory),
  }));
  if (bundles.reduce((count, entry) => count + entry.bundle.length, 0) > MAX_FILES)
    throw new Error("Native skill bundle exceeds file limit.");
  // One host-owned fetch for all selected blobs, not one network request per
  // cat-file on blob:none checkouts. Reads remain local and share the deadline.
  prefetch([...new Set(bundles.flatMap(({ bundle }) => bundle.map((file) => file.oid)))]);
  for (const { directory, bundle } of bundles) {
    const prefix = ".agents/skills/" + directory + "/";
    for (const file of bundle) {
      if (
        !file.path.startsWith(prefix) ||
        file.path
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              part.includes("\\") ||
              part.split("").some((character) => character.charCodeAt(0) < 32),
          )
      )
        throw new Error("Unsafe native skill bundle path.");
      if (file.path.endsWith("/SKILL.md") && file.path !== prefix + "SKILL.md")
        throw new Error("Nested native skills are not selected by this configuration.");
      const text = read(["cat-file", "blob", file.oid], MAX_BYTES - size);
      size += Buffer.byteLength(text);
      if (text.includes("\0") || size > MAX_BYTES)
        throw new Error("Native skill bundle exceeds text budget.");
      // Native integration sidecars can provision tools; this lane grants no such authority.
      if (file.path === prefix + "agents/openai.yaml") {
        const sidecar = parse(text) as Record<string, unknown> | null;
        if (sidecar?.dependencies)
          throw new Error("Native skill tool dependencies are unsupported in review.");
      }
      files.push({ path: file.path, text });
    }
    const skill = files.find((file) => file.path === prefix + "SKILL.md");
    const frontmatter = skill?.text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    const metadata = frontmatter ? (parse(frontmatter) as Record<string, unknown>) : null;
    if (
      metadata?.name !== directory ||
      typeof metadata.description !== "string" ||
      !metadata.description.trim()
    )
      throw new Error("Selected native skill needs matching name and description frontmatter.");
    skills.push({ name: directory, directory });
    for (const file of files.filter(
      (entry) => entry.path.startsWith(prefix) && entry.path.endsWith(".md"),
    )) {
      for (const token of markdown.parse(file.text, {}).flatMap((token) => token.children ?? [])) {
        const href = token.attrGet("href") ?? token.attrGet("src");
        if (typeof href !== "string" || !href || href.startsWith("#") || /^https?:/i.test(href))
          continue;
        const reference = decodeURIComponent(href.split(/[?#]/)[0]!);
        const path = posix.normalize(posix.join(posix.dirname(file.path), reference));
        if (
          /^[a-z][a-z0-9+.-]*:/i.test(reference) ||
          reference.startsWith("/") ||
          reference.includes("\\") ||
          !path.startsWith(prefix) ||
          !files.some((entry) => entry.path === path || entry.path.startsWith(path + "/"))
        )
          throw new Error("Native skill reference is unavailable or escapes its selected bundle.");
      }
    }
  }
  const digest = sha256(stableJson({ configText, files }));
  return { revision, digest, additionalPrompt, skills, files, configText };
}

export function repositoryReviewContentDigest(
  base: string,
  config?: RepositoryReviewConfig,
): string {
  return config ? sha256(base + ":" + config.digest) : base;
}

export function loadLocalRepositoryReviewConfig(
  cwd: string,
  baseRef: string,
): RepositoryReviewConfig | undefined {
  // The offline operator owns --base (default origin/main). Resolve that ref
  // itself: the diff merge-base and PR HEAD are not configuration authority.
  const revision = baseRef.trim()
    ? readReviewGit(cwd, ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`])
        ?.toString("utf8")
        .trim()
    : undefined;
  if (!revision)
    throw new Error(
      "Offline repository review configuration requires a valid trusted --base snapshot.",
    );
  return loadRepositoryReviewConfig(cwd, revision);
}

export function materializeNativeReviewSkills(
  config: RepositoryReviewConfig,
  sourceDir: string,
  ownedWorkspace?: string,
  preparedCodexSource?: string,
) {
  // OpenClaw keeps workspaceOnly enabled: reuse the already-owned review-tree
  // parent with the reviewed checkout and a verified host-prepared source sibling.
  // Never move a user checkout or expose another item through a broader workspace.
  if (ownedWorkspace) {
    const root = realpathSync(ownedWorkspace);
    const source = realpathSync(sourceDir);
    const entries = readdirSync(root).filter((entry) => {
      const path = join(root, entry);
      return !(
        entry === "codex" &&
        preparedCodexSource &&
        lstatSync(path).isSymbolicLink() &&
        realpathSync(path) === realpathSync(preparedCodexSource)
      );
    });
    if (dirname(source) !== root || entries.length !== 1 || join(root, entries[0]!) !== source)
      throw new Error("Native OpenClaw skills require an isolated owned review-tree parent.");
  }
  const cwd = ownedWorkspace
    ? realpathSync(ownedWorkspace)
    : mkdtempSync(join(tmpdir(), "clawsweeper-native-skills-"));
  const cleanup = () =>
    rmSync(ownedWorkspace ? join(cwd, ".agents") : cwd, { recursive: true, force: true });
  try {
    for (const file of config.files) {
      const path = join(cwd, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.text, { flag: "wx", mode: 0o400 });
    }
    const invocation = config.skills.map(
      (skill) =>
        "[$" + skill.name + "](" + join(cwd, ".agents/skills", skill.directory, "SKILL.md") + ")",
    );
    const prompt = [
      "## Explicit repository review configuration",
      "Trusted target revision: " + config.revision + "; bundle digest: " + config.digest + ".",
      "Review source checkout: " +
        JSON.stringify(resolve(sourceDir)) +
        ". Use absolute paths or git -C for source inspection; this native skill workspace is not the reviewed source.",
      "Use only the explicitly selected native skills below. Their guidance is subordinate to the host review contract: no bundled helpers, installation, writes, model changes or other reviewers. Do not activate source-checkout skill changes.",
      ...invocation,
    ]
      .filter(Boolean)
      .join("\n");
    return { cwd, prompt, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
