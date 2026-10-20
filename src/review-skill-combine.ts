import { MAX_LOW_VALUE_TESTS, MAX_PROVENANCE_ENTRIES } from "./clawsweeper-policy.js";
import { reviewDecisionParser } from "./clawsweeper-decision-parser.js";
import type { LabelJustification, Decision, PrRatingTier } from "./clawsweeper-types.js";
import { stableJson } from "./stable-json.js";

const unique = <T>(values: T[]): T[] => [
  ...new Map(values.map((value) => [stableJson(value), value])).values(),
];
const join = (...values: string[]) => [...new Set(values.filter(Boolean))].join("\n\n");
function worst<T extends string>(left: T, right: T, order: readonly T[]): T {
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}
// Structured obligations are not code findings. Preserve them even when both
// reviewers return zero findings; the coordinator cannot waive another pass.
export function combineSkillAssessment(baseline: Decision, companion: Decision): Decision {
  const findings = unique([...baseline.reviewFindings, ...companion.reviewFindings]);
  const provenance = unique([...baseline.provenance, ...companion.provenance]);
  const lowValueTests = unique([
    ...baseline.testingReview.lowValueTests,
    ...companion.testingReview.lowValueTests,
  ]);
  const proof = baseline.realBehaviorProof;
  const otherProof = companion.realBehaviorProof;
  const proofStatus = worst(proof.status, otherProof.status, [
    "not_applicable",
    "override",
    "sufficient",
    "mock_only",
    "missing",
    "insufficient",
  ]);
  const selectedProof = proof.status === proofStatus ? proof : otherProof;
  const likelyOwners = unique([...baseline.likelyOwners, ...companion.likelyOwners]);
  const maintainer = baseline.maintainerDecision.required
    ? baseline.maintainerDecision
    : companion.maintainerDecision;
  const requiredOwner = maintainer.required
    ? likelyOwners.find((owner) => owner.person === maintainer.likelyOwner.person)
    : undefined;
  // The canonical schema admits five owners. Keep the required decision owner
  // in that projection even when it came from the second independent pass.
  const ownerProjection =
    likelyOwners.length > 5 && requiredOwner
      ? [requiredOwner, ...likelyOwners.filter((owner) => owner !== requiredOwner)].slice(0, 5)
      : likelyOwners.slice(0, 5);
  const productWorth = worst(baseline.productReview.worthIt, companion.productReview.worthIt, [
    "not_applicable",
    "yes",
    "needs_maintainer",
    "no",
  ]);
  const product =
    baseline.productReview.worthIt === productWorth
      ? baseline.productReview
      : companion.productReview;
  const tiers: PrRatingTier[] = ["NA", "S", "A", "B", "C", "D", "F"];
  const baselineNext = baseline.nextStep?.kind === "required" ? baseline.nextStep.text : "";
  const companionNext = companion.nextStep?.kind === "required" ? companion.nextStep.text : "";
  const bothRequired =
    baseline.maintainerDecision.required && companion.maintainerDecision.required;
  const triagePriority = worst(baseline.triagePriority, companion.triagePriority, [
    "none",
    "P3",
    "P2",
    "P1",
    "P0",
  ]);
  const impactLabels = unique([...baseline.impactLabels, ...companion.impactLabels]).slice(0, 3);
  const mergeRiskLabels = unique([...baseline.mergeRiskLabels, ...companion.mergeRiskLabels]).slice(
    0,
    3,
  );
  const maturityLabels = unique([...baseline.maturityLabels, ...companion.maturityLabels]).slice(
    0,
    1,
  );
  const selected = new Set<string>(
    reviewDecisionParser.selectedReviewLabels({
      triagePriority,
      impactLabels,
      mergeRiskLabels,
      maturityLabels,
    }),
  );
  const justifications = new Map<string, LabelJustification>();
  for (const entry of [...baseline.labelJustifications, ...companion.labelJustifications]) {
    const prior = justifications.get(entry.label);
    justifications.set(entry.label, {
      label: entry.label,
      reason: join(prior?.reason ?? "", entry.reason),
    });
  }
  // Identity is the label, not the model's prose. Keep overflow/unselected
  // rationales visibly below without violating canonical selected-label bounds.
  const labelJustifications = [...justifications.values()].filter((entry) =>
    selected.has(entry.label),
  );
  return {
    ...baseline,
    decision: "keep_open",
    closeReason: "none",
    closeComment: "",
    reviewFindings: findings,
    // Proof/owner/product blockers are retained separately; only accepted
    // P0-P2 code findings establish an incorrect-patch verdict.
    overallCorrectness: findings.some((f) => f.priority <= 2)
      ? "patch is incorrect"
      : "patch is correct",
    overallConfidenceScore: Math.min(
      baseline.overallConfidenceScore,
      companion.overallConfidenceScore,
    ),
    confidence: worst(baseline.confidence, companion.confidence, ["high", "medium", "low"]),
    triagePriority,
    risks: unique([...baseline.risks, ...companion.risks]),
    evidence: unique([...baseline.evidence, ...companion.evidence]),
    likelyOwners: ownerProjection,
    provenance: provenance.slice(0, MAX_PROVENANCE_ENTRIES),
    reviewMetrics: unique([...baseline.reviewMetrics, ...companion.reviewMetrics]),
    impactLabels,
    mergeRiskLabels,
    maturityLabels,
    labelJustifications,
    mergeRiskOptions: baseline.mergeRiskOptions.length
      ? baseline.mergeRiskOptions
      : companion.mergeRiskOptions,
    maintainerDecision: {
      ...maintainer,
      question: bothRequired
        ? join(baseline.maintainerDecision.question, companion.maintainerDecision.question)
        : maintainer.question,
      rationale: bothRequired
        ? join(
            baseline.maintainerDecision.rationale,
            companion.maintainerDecision.rationale,
            "All required owner decisions and options: " +
              stableJson([baseline.maintainerDecision, companion.maintainerDecision]),
          )
        : maintainer.rationale,
      // The persisted packet supports three options; preserve any overflow in
      // rationale as well, rather than silently dropping the second decision.
      options: maintainer.options,
    },
    requiresProductDecision: baseline.requiresProductDecision || companion.requiresProductDecision,
    requiresNewFeature: baseline.requiresNewFeature || companion.requiresNewFeature,
    requiresNewConfigOption: baseline.requiresNewConfigOption || companion.requiresNewConfigOption,
    productReview: {
      ...product,
      fixScope: worst(baseline.productReview.fixScope, companion.productReview.fixScope, [
        "not_applicable",
        "complete",
        "partial",
      ]),
      reason: join(baseline.productReview.reason, companion.productReview.reason)
        .replace(/\s+/g, " ")
        .trim(),
    },
    realBehaviorProof: {
      ...selectedProof,
      summary: join(proof.summary, otherProof.summary),
      needsContributorAction: proof.needsContributorAction || otherProof.needsContributorAction,
      ...(proof.dataModelCompatibility !== undefined ||
      otherProof.dataModelCompatibility !== undefined
        ? {
            dataModelCompatibility: worst(
              proof.dataModelCompatibility ?? "not_applicable",
              otherProof.dataModelCompatibility ?? "not_applicable",
              ["not_applicable", "sufficient", "insufficient"],
            ),
          }
        : {}),
    },
    agentsPolicyStatus: {
      found: baseline.agentsPolicyStatus.found || companion.agentsPolicyStatus.found,
      readFully: baseline.agentsPolicyStatus.readFully && companion.agentsPolicyStatus.readFully,
      applied: baseline.agentsPolicyStatus.applied && companion.agentsPolicyStatus.applied,
      status: worst(baseline.agentsPolicyStatus.status, companion.agentsPolicyStatus.status, [
        "not_found",
        "found_not_applicable",
        "found_applied",
        "unreadable_or_unclear",
        "conflict_not_applied",
      ]),
      summary: join(baseline.agentsPolicyStatus.summary, companion.agentsPolicyStatus.summary),
    },
    testingReview: {
      proofPath: worst(baseline.testingReview.proofPath, companion.testingReview.proofPath, [
        "not_applicable",
        "shipped_entry_point",
        "in_process_harness",
        "unit_only",
        "none",
      ]),
      lowValueTests: lowValueTests.slice(0, MAX_LOW_VALUE_TESTS),
      missingE2e: join(baseline.testingReview.missingE2e, companion.testingReview.missingE2e)
        .replace(/\s+/g, " ")
        .trim(),
    },
    securityReview: {
      status: worst(baseline.securityReview.status, companion.securityReview.status, [
        "not_applicable",
        "cleared",
        "needs_attention",
      ]),
      summary: join(baseline.securityReview.summary, companion.securityReview.summary),
      concerns: unique([...baseline.securityReview.concerns, ...companion.securityReview.concerns]),
    },
    prRating: {
      proofTier: worst(baseline.prRating.proofTier, companion.prRating.proofTier, tiers),
      patchTier: worst(baseline.prRating.patchTier, companion.prRating.patchTier, tiers),
      overallTier: worst(baseline.prRating.overallTier, companion.prRating.overallTier, tiers),
      summary: join(baseline.prRating.summary, companion.prRating.summary),
      nextSteps: unique([...baseline.prRating.nextSteps, ...companion.prRating.nextSteps]).slice(
        0,
        3,
      ),
    },
    ...(baselineNext || companionNext
      ? { nextStep: { kind: "required", text: join(baselineNext, companionNext) } }
      : {}),
    solutionAssessment: join(
      baseline.solutionAssessment,
      "Companion assessment: " + companion.solutionAssessment,
      "All merge-risk options: " +
        stableJson(unique([...baseline.mergeRiskOptions, ...companion.mergeRiskOptions])),
      "Combined label recommendations: " +
        stableJson({
          impact: unique([...baseline.impactLabels, ...companion.impactLabels]),
          mergeRisk: unique([...baseline.mergeRiskLabels, ...companion.mergeRiskLabels]),
          maturity: unique([...baseline.maturityLabels, ...companion.maturityLabels]),
        }),
      "All label rationales: " + stableJson([...justifications.values()]),
      ...(likelyOwners.length > 5 ? ["All owner assessments: " + stableJson(likelyOwners)] : []),
      ...(provenance.length > MAX_PROVENANCE_ENTRIES
        ? ["All provenance assessments: " + stableJson(provenance)]
        : []),
      ...(lowValueTests.length > MAX_LOW_VALUE_TESTS
        ? ["All low-value test assessments: " + stableJson(lowValueTests)]
        : []),
      "All rank-up moves: " +
        unique([...baseline.prRating.nextSteps, ...companion.prRating.nextSteps]).join("; "),
    ),
    bestSolution: join(baseline.bestSolution, companion.bestSolution),
    workValidation: unique([...baseline.workValidation, ...companion.workValidation]),
    workLikelyFiles: unique([...baseline.workLikelyFiles, ...companion.workLikelyFiles]),
    workPrompt: join(baseline.workPrompt, companion.workPrompt),
  };
}
export function incompleteSkillAssessment(baseline: Decision, detail: string): Decision {
  return {
    ...baseline,
    decision: "keep_open",
    closeReason: "none",
    closeComment: "",
    codexTerminalFailure: true,
    summary:
      "Review incomplete: explicitly requested review skill did not finish. Baseline assessment: " +
      baseline.summary,
    nextStep: {
      kind: "required",
      text: join(
        baseline.nextStep?.text ?? "",
        "Host operator: complete the explicitly requested review-skill run before treating this review as complete.",
      ),
    },
    solutionAssessment: join(
      baseline.solutionAssessment,
      "Review skill incomplete: " +
        detail +
        ". No dual-model consensus was produced; baseline assessment retained.",
    ),
  };
}
