import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { boolArg, itemNumbersArg, type Args } from "./clawsweeper-args.js";
import { UserFacingCommandError } from "./command.js";
import { sha256 } from "./content-hash.js";
import { stableJson } from "./stable-json.js";
import { requireRecord, rejectUnexpectedKeys } from "./value-coerce.js";

export interface SkillModel {
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max";
  contextTier: "default" | "long_context";
}
export interface SkillExecutionConfig {
  adapter: "copilot";
  reviewers: [SkillModel, SkillModel];
  coordinator: SkillModel;
  timeoutMs: number;
  maxResultBytes: number;
  provider?: { baseUrl: string; apiKeyEnv: "OPENROUTER_API_KEY" | "CLAWSWEEPER_SKILL_API_KEY" };
}
export interface ReviewSkillSelection {
  slug: string;
  config: SkillExecutionConfig;
}
// Included only on an explicitly opted-in exact review, never automatic admission.
export const REVIEW_SKILL_RUNNER_VERSION = "target-owned-dual-review-v4-verified-source";
export const REVIEW_SKILL_WIRE_VERSION = "json-string-payload-v1";

function model(value: unknown): SkillModel {
  const row = requireRecord(value, "review skill model");
  rejectUnexpectedKeys(
    row,
    new Set(["model", "reasoningEffort", "contextTier"]),
    "review skill model",
  );
  if (
    typeof row.model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(row.model) ||
    !["low", "medium", "high", "xhigh", "max"].includes(String(row.reasoningEffort)) ||
    !["default", "long_context"].includes(String(row.contextTier))
  )
    throw new UserFacingCommandError(
      "Review skill requires exact model, reasoningEffort and contextTier settings.",
    );
  return row as unknown as SkillModel;
}
export function parseSkillExecutionConfig(value: unknown): SkillExecutionConfig {
  const row = requireRecord(value, "review skill execution config");
  rejectUnexpectedKeys(
    row,
    new Set(["adapter", "reviewers", "coordinator", "timeoutMs", "maxResultBytes", "provider"]),
    "review skill execution config",
  );
  if (row.adapter !== "copilot" || !Array.isArray(row.reviewers) || row.reviewers.length !== 2)
    throw new UserFacingCommandError(
      "Review skill requires the optional copilot adapter and exactly two reviewers.",
    );
  const reviewers = row.reviewers.map(model) as [SkillModel, SkillModel];
  if (reviewers[0].model === reviewers[1].model)
    throw new UserFacingCommandError("Review skill requires two distinct reviewer models.");
  if (
    !Number.isSafeInteger(row.timeoutMs) ||
    Number(row.timeoutMs) < 100 ||
    Number(row.timeoutMs) > 1_800_000 ||
    !Number.isSafeInteger(row.maxResultBytes) ||
    Number(row.maxResultBytes) < 1024 ||
    Number(row.maxResultBytes) > 1024 * 1024
  )
    throw new UserFacingCommandError(
      "Review skill requires bounded timeoutMs (100..1800000) and maxResultBytes (1024..1048576).",
    );
  let provider: SkillExecutionConfig["provider"];
  if (row.provider !== undefined) {
    const value = requireRecord(row.provider, "review skill provider");
    rejectUnexpectedKeys(value, new Set(["baseUrl", "apiKeyEnv"]), "review skill provider");
    const url = new URL(String(value.baseUrl));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["OPENROUTER_API_KEY", "CLAWSWEEPER_SKILL_API_KEY"].includes(String(value.apiKeyEnv))
    )
      throw new UserFacingCommandError(
        "BYOK requires an explicit HTTPS OpenAI-compatible endpoint and a dedicated admitted API-key environment reference.",
      );
    provider = {
      baseUrl: url.href.replace(/\/$/, ""),
      apiKeyEnv: value.apiKeyEnv as "OPENROUTER_API_KEY" | "CLAWSWEEPER_SKILL_API_KEY",
    };
  }
  return {
    adapter: "copilot",
    reviewers,
    coordinator: model(row.coordinator),
    timeoutMs: Number(row.timeoutMs),
    maxResultBytes: Number(row.maxResultBytes),
    ...(provider ? { provider } : {}),
  };
}
export function selectReviewSkill(
  args: Args,
  repo: string,
  env = process.env,
): ReviewSkillSelection | undefined {
  if (args.review_skill === undefined && args.review_skill_config === undefined) return undefined;
  if (
    typeof args.review_skill !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(args.review_skill) ||
    typeof args.review_skill_config !== "string"
  )
    throw new UserFacingCommandError(
      "Use --review-skill <slug> with --review-skill-config <trusted-absolute-json-path>.",
    );
  const numbers = itemNumbersArg(args.item_numbers, args.item_number);
  const automatic =
    boolArg(args.planned_automatic_review) ||
    ["scheduled_hot_intake", "scheduled_normal_backfill"].includes(
      String(args.review_source_action),
    );
  const localRange = boolArg(args.local_range);
  if ((localRange ? numbers.length !== 0 : numbers.length !== 1) || automatic)
    throw new UserFacingCommandError(
      "Review skill execution requires one explicit exact PR; issues and multi-item sweeps are unsupported.",
    );
  if (
    !localRange &&
    !boolArg(args.local_only) &&
    (env.EXACT_REVIEW_ITEM_KIND !== "pull_request" ||
      env.EXACT_REVIEW_ITEM_KEY?.toLowerCase() !== (repo + "#" + numbers[0]).toLowerCase() ||
      !env.EXACT_REVIEW_LEASE_ID)
  )
    throw new UserFacingCommandError(
      "Hosted review skill execution requires matching exact PR queue authority and normal lease guards.",
    );
  const path = args.review_skill_config;
  if (!isAbsolute(path) || !lstatSync(path).isFile() || lstatSync(path).size > 16_384)
    throw new UserFacingCommandError(
      "Review skill config must be a bounded regular absolute host file.",
    );
  return {
    slug: args.review_skill,
    config: parseSkillExecutionConfig(JSON.parse(readFileSync(path, "utf8"))),
  };
}
export function assertSkillConfigOutsideTarget(configPath: string, targetDir: string): void {
  const rel = relative(realpathSync(targetDir), realpathSync(configPath));
  if (!rel || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)))
    throw new UserFacingCommandError(
      "Review skill execution config must be host-owned, outside the target checkout.",
    );
}
export function skillExecutionIdentity(
  selection: ReviewSkillSelection,
  sourceDigest: string,
): string {
  return sha256(
    stableJson({
      runner: REVIEW_SKILL_RUNNER_VERSION,
      wire: REVIEW_SKILL_WIRE_VERSION,
      sdk: "1.0.22",
      selection,
      sourceDigest,
    }),
  );
}

export const REVIEW_SKILL_SOURCE_TIMEOUT_MS = 10_000;
export const REVIEW_SKILL_WORKER_STOP_MARGIN_MS = 5_000;
// The shared process owner adds ten seconds for supervision; retain an extra
// five seconds before lease expiry for report/failure handoff and caller cleanup.
export const REVIEW_SKILL_SUPERVISOR_RESERVE_MS = 15_000;
export function reviewSkillLeaseTimeout(
  baselineTimeoutMs: number,
  selection?: ReviewSkillSelection,
): number {
  return (
    baselineTimeoutMs +
    (selection
      ? selection.config.timeoutMs +
        REVIEW_SKILL_SOURCE_TIMEOUT_MS +
        REVIEW_SKILL_WORKER_STOP_MARGIN_MS +
        REVIEW_SKILL_SUPERVISOR_RESERVE_MS
      : 0)
  );
}
export function reviewSkillLeaseDeadline(expiresAt: string, now = Date.now()): number {
  const expiry = Date.parse(expiresAt);
  if (
    !Number.isFinite(expiry) ||
    expiry - now <= REVIEW_SKILL_WORKER_STOP_MARGIN_MS + REVIEW_SKILL_SUPERVISOR_RESERVE_MS + 100
  )
    throw new UserFacingCommandError(
      "Explicit review skill cannot start without sufficient remaining owned review lease time.",
    );
  return expiry;
}
export function remainingReviewSkillTimeout(
  requestedMs: number,
  deadlineAt?: number,
  now = Date.now(),
): number {
  if (deadlineAt === undefined) return requestedMs;
  const remaining = Math.min(
    requestedMs,
    deadlineAt - now - REVIEW_SKILL_WORKER_STOP_MARGIN_MS - REVIEW_SKILL_SUPERVISOR_RESERVE_MS,
  );
  if (!Number.isSafeInteger(remaining) || remaining < 100)
    throw new UserFacingCommandError(
      "Explicit review skill incomplete: owned review lease deadline exhausted before execution.",
    );
  return remaining;
}
