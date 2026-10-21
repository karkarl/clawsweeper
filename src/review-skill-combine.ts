import { MAX_LOW_VALUE_TESTS, MAX_PROVENANCE_ENTRIES } from "./clawsweeper-policy.js";
import { reviewDecisionParser } from "./clawsweeper-decision-parser.js";
import type {
  LabelJustification,
  Decision,
  PrRatingTier,
  MergeRiskOption,
} from "./clawsweeper-types.js";
import { stableJson } from "./stable-json.js";

const unique = <T>(values: T[]): T[] => [
  ...new Map(values.map((value) => [stableJson(value), value])).values(),
];
const join = (...values: string[]) => [...new Set(values.filter(Boolean))].join("\n\n");
function worst<T extends string>(left: T, right: T, order: readonly T[]): T {
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}
function workAssessment(decision: Decision) {
  return {
    workCandidate: decision.workCandidate,
    workConfidence: decision.workConfidence,
    workPriority: decision.workPriority,
    workReason: decision.workReason,
    workPrompt: decision.workPrompt,
    workClusterRefs: decision.workClusterRefs,
    workValidation: decision.workValidation,
    workLikelyFiles: decision.workLikelyFiles,
    autoImplementationCandidate: decision.autoImplementationCandidate,
    implementationComplexity: decision.implementationComplexity,
    reproductionStatus: decision.reproductionStatus,
    reproductionConfidence: decision.reproductionConfidence,
  };
}
// At most one option per canonical category keeps the bounded structured view
// complete. Explicit fix-before-merge obligations cannot be waived by another
// pass; accepting risk or recommending closure requires agreement from both.
function combinedMergeRiskOptions(baseline: Decision, companion: Decision): MergeRiskOption[] {
  const left = baseline.mergeRiskOptions.find((option) => option.recommended)?.category;
  const right = companion.mergeRiskOptions.find((option) => option.recommended)?.category;
  const recommended =
    left === "fix_before_merge" || right === "fix_before_merge"
      ? "fix_before_merge"
      : left === right
        ? left
        : undefined;
  const groups = new Map<MergeRiskOption["category"], MergeRiskOption[]>();
  for (const option of [...baseline.mergeRiskOptions, ...companion.mergeRiskOptions]) {
    groups.set(option.category, [...(groups.get(option.category) ?? []), option]);
  }
  return [...groups].map(([category, options]) => ({
    category,
    title: [...new Set(options.map((option) => option.title))].join("; "),
    body: join(...options.map((option) => option.body)),
    recommended: category === recommended,
  }));
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
  const assessments = [baseline.regressionAssessment, companion.regressionAssessment].filter(
    (value) => value != null,
  );
  const regressionEvidence = unique(assessments.flatMap((value) => value.supportingEvidence));
  const regressionConflict = Boolean(
    baseline.regressionProvenance &&
    companion.regressionProvenance &&
    stableJson(baseline.regressionProvenance) !== stableJson(companion.regressionProvenance),
  );
  const policyFound = baseline.agentsPolicyStatus.found || companion.agentsPolicyStatus.found;
  const policyReadFully =
    policyFound && baseline.agentsPolicyStatus.readFully && companion.agentsPolicyStatus.readFully;
  const policyStatuses = [baseline.agentsPolicyStatus.status, companion.agentsPolicyStatus.status];
  const policyFailure = policyStatuses.includes("conflict_not_applied")
    ? "conflict_not_applied"
    : policyStatuses.includes("unreadable_or_unclear")
      ? "unreadable_or_unclear"
      : undefined;
  const policyApplied =
    !policyFailure &&
    policyReadFully &&
    baseline.agentsPolicyStatus.applied &&
    companion.agentsPolicyStatus.applied;
  const policyStatus =
    policyFailure ??
    (!policyFound
      ? "not_found"
      : !policyReadFully
        ? "unreadable_or_unclear"
        : policyApplied
          ? "found_applied"
          : policyStatuses.every((status) => status === "found_not_applicable")
            ? "found_not_applicable"
            : "unreadable_or_unclear");
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
  // Exact model decisions form a deny-wins work lattice; no prose-based intent
  // classifier or new queue policy. Typed owner/product/security blockers use
  // the same no-new-fix boundary as existing advisory/report consumers.
  const workVeto = baseline.workCandidate === "none" || companion.workCandidate === "none";
  const ownerOrSecurityBlock =
    baseline.maintainerDecision.required ||
    companion.maintainerDecision.required ||
    baseline.requiresProductDecision ||
    companion.requiresProductDecision ||
    productWorth === "no" ||
    productWorth === "needs_maintainer" ||
    baseline.securityReview.status === "needs_attention" ||
    companion.securityReview.status === "needs_attention" ||
    baseline.itemCategory === "security" ||
    companion.itemCategory === "security";
  const workCandidate = workVeto
    ? "none"
    : ownerOrSecurityBlock ||
        baseline.workCandidate === "manual_review" ||
        companion.workCandidate === "manual_review"
      ? "manual_review"
      : "queue_fix_pr";
  const queueable = workCandidate === "queue_fix_pr";
  const reproductionStatus =
    baseline.reproductionStatus === companion.reproductionStatus
      ? baseline.reproductionStatus
      : "unclear";
  const reproductionConfidence = worst(
    baseline.reproductionConfidence,
    companion.reproductionConfidence,
    ["high", "medium", "low"],
  );
  const implementationComplexity = worst(
    baseline.implementationComplexity,
    companion.implementationComplexity,
    ["small", "medium", "large", "unclear", "not_applicable"],
  );
  const autoImplementationCandidate =
    queueable &&
    baseline.autoImplementationCandidate === "strict_bug" &&
    companion.autoImplementationCandidate === "strict_bug" &&
    !baseline.requiresNewFeature &&
    !companion.requiresNewFeature &&
    !baseline.requiresNewConfigOption &&
    !companion.requiresNewConfigOption &&
    reproductionStatus === "reproduced" &&
    reproductionConfidence === "high" &&
    implementationComplexity === "small"
      ? "strict_bug"
      : "none";
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
    itemCategory:
      baseline.itemCategory === "security" || companion.itemCategory === "security"
        ? "security"
        : baseline.itemCategory === "regression" || companion.itemCategory === "regression"
          ? "regression"
          : baseline.itemCategory,
    ...(assessments.length
      ? {
          regressionAssessment: {
            confidence: assessments.some((value) => value.confidence === "probable")
              ? "probable"
              : "suspected",
            supportingEvidence: regressionEvidence.slice(0, 3),
          },
        }
      : {}),
    ...(baseline.regressionProvenance || companion.regressionProvenance
      ? {
          // Candidate pointers still require the existing host verifier after this
          // merge. Conflicting pointers cannot become arbitrary public attribution.
          regressionProvenance: regressionConflict
            ? null
            : (baseline.regressionProvenance ?? companion.regressionProvenance),
        }
      : {}),
    risks: unique([...baseline.risks, ...companion.risks]),
    evidence: unique([...baseline.evidence, ...companion.evidence]),
    likelyOwners: ownerProjection,
    provenance: provenance.slice(0, MAX_PROVENANCE_ENTRIES),
    reviewMetrics: unique([...baseline.reviewMetrics, ...companion.reviewMetrics]),
    impactLabels,
    mergeRiskLabels,
    maturityLabels,
    labelJustifications,
    mergeRiskOptions: combinedMergeRiskOptions(baseline, companion),
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
    reproductionStatus,
    reproductionConfidence,
    reproductionAssessment: join(baseline.reproductionAssessment, companion.reproductionAssessment),
    implementationComplexity,
    autoImplementationCandidate,
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
      found: policyFound,
      readFully: policyReadFully,
      applied: policyApplied,
      status: policyStatus,
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
      ...(assessments.length
        ? ["All non-attributing regression evidence: " + stableJson(regressionEvidence)]
        : []),
      ...(regressionConflict
        ? [
            "Conflicting unverified regression provenance pointers; no predecessor attribution selected.",
          ]
        : []),
      "Independent work and automation assessments: " +
        stableJson([workAssessment(baseline), workAssessment(companion)]),
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
    workCandidate,
    workConfidence: worst(baseline.workConfidence, companion.workConfidence, [
      "high",
      "medium",
      "low",
    ]),
    workPriority: worst(baseline.workPriority, companion.workPriority, ["low", "medium", "high"]),
    workReason: join(
      baseline.workReason,
      companion.workReason,
      ...(!queueable
        ? [
            "Automatic work plan withheld: an independent assessment vetoed queued work or requires owner/product/security review.",
          ]
        : []),
    ),
    workValidation: queueable
      ? unique([...baseline.workValidation, ...companion.workValidation])
      : [],
    workLikelyFiles: queueable
      ? unique([...baseline.workLikelyFiles, ...companion.workLikelyFiles])
      : [],
    workClusterRefs: queueable
      ? unique([...baseline.workClusterRefs, ...companion.workClusterRefs])
      : [],
    workPrompt: queueable ? join(baseline.workPrompt, companion.workPrompt) : "",
  };
}
export function incompleteSkillAssessment(baseline: Decision, detail: string): Decision {
  return {
    ...baseline,
    decision: "keep_open",
    closeReason: "none",
    closeComment: "",
    codexTerminalFailure: true,
    workCandidate: baseline.workCandidate === "none" ? "none" : "manual_review",
    autoImplementationCandidate: "none",
    workPrompt: "",
    workValidation: [],
    workLikelyFiles: [],
    workClusterRefs: [],
    workReason: join(
      baseline.workReason,
      "Explicit companion review is incomplete; no automatic work plan is authorized.",
    ),
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
      "Retained baseline work and automation assessment: " + stableJson(workAssessment(baseline)),
      "Review skill incomplete: " +
        detail +
        ". No dual-model consensus was produced; baseline assessment retained.",
    ),
  };
}
