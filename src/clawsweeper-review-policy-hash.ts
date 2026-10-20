import { sha256 } from "./content-hash.js";
import { stableJson } from "./stable-json.js";
import { REVIEW_POLICY_VERSION, FRESH_DAYS } from "./clawsweeper-policy.js";
import { targetRepo, targetProfile } from "./repository-profiles.js";
import type { createReviewCoreRuntime } from "./clawsweeper-review-core.js";

export function reviewPolicyHash(
  options: { model?: string; sandboxMode?: string },
  {
    reviewPromptTemplates,
    reviewDecisionSchemaText,
  }: Pick<
    ReturnType<typeof createReviewCoreRuntime>,
    "reviewPromptTemplates" | "reviewDecisionSchemaText"
  >,
): string {
  const policyTargetRepo = targetRepo();
  return sha256(
    stableJson({
      version: REVIEW_POLICY_VERSION,
      freshDays: FRESH_DAYS,
      // Model changes roll through normal review cadence. Keep this sentinel
      // stable; bump REVIEW_POLICY_VERSION to invalidate stored reviews.
      model: "model-excluded-2026-07",
      reasoningEffort: "per-item-author-profile-v1",
      itemExecutionProfile: "maintainer-high-fast-otherwise-medium-standard-v1",
      sandboxMode: options.sandboxMode ?? "read-only",
      // Keep the historical hash value so service tier changes do not invalidate reviews.
      serviceTier: "",
      targetRepo: policyTargetRepo,
      ...(policyTargetRepo.toLowerCase() === "openclaw/openclaw"
        ? { openclawCodexSourceProvisioning: "v1" }
        : {}),
      repositoryProfile: targetProfile(),
      prompts: reviewPromptTemplates(),
      schema: reviewDecisionSchemaText(),
    }),
  ).slice(0, 16);
}

// The existing review_model field is the execution/cache identity. Cadence keeps
// review_policy stable: an explicit paid companion cannot buy automatic admission.
export function reviewExecutionModel(baselineModel: string, skillIdentity?: string): string {
  return skillIdentity ? baselineModel + " [review-skill:" + skillIdentity + "]" : baselineModel;
}
export function reviewExecutionCacheCompatible(
  priorModel: string | undefined,
  currentModel: string,
  baselineModel: string,
): boolean {
  // Ordinary content caching historically excludes model selection and accepts
  // old missing-model records. Preserve that default; only an opted-in skill
  // identity on either side introduces this extra compatibility boundary.
  if (currentModel === baselineModel && !priorModel?.includes(" [review-skill:")) return true;
  return priorModel === currentModel;
}
