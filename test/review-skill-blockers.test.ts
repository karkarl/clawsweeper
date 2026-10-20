import assert from "node:assert/strict";
import test from "node:test";
import { combineSkillAssessment, incompleteSkillAssessment } from "../dist/review-skill-combine.js";
import { reviewDecisionParser } from "../dist/clawsweeper-decision-parser.js";
import type { Decision } from "../dist/clawsweeper-types.js";
import { closeDecision, reviewFinding } from "./helpers.ts";

function assessment(overrides: Partial<Decision> = {}): Decision {
  return reviewDecisionParser.parseDecision(
    closeDecision({
      decision: "keep_open",
      closeReason: "none",
      closeComment: "",
      overallCorrectness: "patch is correct",
      reviewFindings: [],
      realBehaviorProof: {
        status: "sufficient",
        summary: "Current behavior was exercised.",
        evidenceKind: "logs",
        needsContributorAction: false,
        dataModelCompatibility: "sufficient",
      },
      productReview: {
        kind: "bug_fix",
        userProblem: "Repair the existing behavior.",
        fixScope: "complete",
        worthIt: "yes",
        reason: "Focused repair.",
      },
      testingReview: { proofPath: "shipped_entry_point", lowValueTests: [], missingE2e: "" },
      prRating: {
        proofTier: "A",
        patchTier: "A",
        overallTier: "A",
        summary: "Current proof is sufficient.",
        nextSteps: [],
      },
      nextStep: { kind: "none", text: "" },
      ...overrides,
    }),
  );
}
const orders = (left: Decision, right: Decision) =>
  [
    [left, right],
    [right, left],
  ] as const;

test("skill reconciliation retains newly introduced proof blockers without code findings in either order", () => {
  const clean = assessment();
  const blocked = assessment({
    realBehaviorProof: {
      status: "missing",
      summary: "The reconnect path has no runtime proof.",
      evidenceKind: "none",
      needsContributorAction: true,
      dataModelCompatibility: "sufficient",
    },
  });
  for (const [left, right] of orders(clean, blocked)) {
    const merged = combineSkillAssessment(left, right);
    assert.equal(merged.realBehaviorProof.status, "missing");
    assert.equal(merged.realBehaviorProof.needsContributorAction, true);
    assert.match(merged.realBehaviorProof.summary, /reconnect path/);
    assert.equal(merged.reviewFindings.length, 0);
  }
});

test("skill reconciliation never replaces a data-model upgrade gap with sufficient runtime proof", () => {
  const clean = assessment();
  const blocked = assessment({
    realBehaviorProof: {
      status: "sufficient",
      summary: "Startup passed but upgrade compatibility is unproven.",
      evidenceKind: "logs",
      needsContributorAction: true,
      dataModelCompatibility: "insufficient",
    },
  });
  for (const [left, right] of orders(clean, blocked)) {
    const merged = combineSkillAssessment(left, right);
    assert.equal(merged.realBehaviorProof.dataModelCompatibility, "insufficient");
    assert.equal(merged.realBehaviorProof.needsContributorAction, true);
    assert.match(merged.realBehaviorProof.summary, /upgrade compatibility/);
  }
});

test("skill reconciliation preserves owner decisions, product blockers and associated options without findings", () => {
  const clean = assessment();
  const blocked = assessment({
    requiresProductDecision: true,
    maintainerDecision: {
      required: true,
      kind: "product_direction",
      question: "Should this change be enabled?",
      rationale: "The paid-service rollout needs owner direction.",
      options: [
        { title: "Keep opt-in", body: "Preserve ordinary availability.", recommended: true },
        {
          title: "Enable separately",
          body: "Approve a bounded rollout first.",
          recommended: false,
        },
      ],
      likelyOwner: { person: "@alice", reason: "Product owner.", confidence: "high" },
    },
    productReview: {
      kind: "feature",
      userProblem: "Additional review coverage.",
      fixScope: "complete",
      worthIt: "needs_maintainer",
      reason: "Owner approval is absent.",
    },
    mergeRiskLabels: ["merge-risk: 🚨 automation"],
    labelJustifications: [
      { label: "P2", reason: "The rollout changes a bounded review integration." },
      {
        label: "merge-risk: 🚨 automation",
        reason: "The paid review rollout requires explicit owner direction.",
      },
    ],
    mergeRiskOptions: [
      {
        title: "Keep opt-in",
        body: "No mandatory rollout before approval.",
        category: "fix_before_merge",
        recommended: true,
      },
    ],
    nextStep: { kind: "required", text: "Obtain explicit rollout approval." },
  });
  for (const [left, right] of orders(clean, blocked)) {
    const merged = combineSkillAssessment(left, right);
    assert.equal(merged.requiresProductDecision, true);
    assert.equal(merged.maintainerDecision.required, true);
    assert.match(merged.maintainerDecision.question, /enabled/);
    assert.equal(merged.maintainerDecision.options.length, 2);
    assert.equal(merged.productReview.worthIt, "needs_maintainer");
    assert.ok(merged.mergeRiskLabels.includes("merge-risk: 🚨 automation"));
    assert.equal(merged.mergeRiskOptions[0]?.title, "Keep opt-in");
    assert.equal(merged.nextStep?.kind, "required");
    assert.match(merged.nextStep?.text ?? "", /rollout approval/);
  }
});

test("a stronger product rejection is not weakened by another request for owner judgement", () => {
  const rejected = assessment({
    productReview: {
      kind: "feature",
      userProblem: "A proposal.",
      fixScope: "complete",
      worthIt: "no",
      reason: "This duplicates an existing owned capability.",
    },
  });
  const needsOwner = assessment({
    productReview: {
      kind: "feature",
      userProblem: "A proposal.",
      fixScope: "complete",
      worthIt: "needs_maintainer",
      reason: "Owner direction is needed.",
    },
  });
  for (const [left, right] of orders(rejected, needsOwner)) {
    const merged = combineSkillAssessment(left, right);
    assert.equal(merged.productReview.worthIt, "no");
    assert.match(merged.productReview.reason, /duplicates/);
    assert.match(merged.productReview.reason, /Owner direction/);
  }
});

test("skill reconciliation retains security and test blockers independently of code verdicts", () => {
  const clean = assessment();
  const blocked = assessment({
    securityReview: {
      status: "needs_attention",
      summary: "Token scope needs security review.",
      concerns: [
        {
          title: "Credential boundary",
          body: "The integration changes token custody.",
          severity: "high",
          confidenceScore: 0.95,
          file: "src/auth.ts",
          line: 1,
        },
      ],
    },
    testingReview: {
      proofPath: "unit_only",
      lowValueTests: [],
      missingE2e: "No real cancellation cleanup was exercised.",
    },
    nextStep: {
      kind: "required",
      text: "Resolve token custody and demonstrate cancellation cleanup.",
    },
  });
  for (const [left, right] of orders(clean, blocked)) {
    const merged = combineSkillAssessment(left, right);
    assert.equal(merged.securityReview.status, "needs_attention");
    assert.equal(merged.securityReview.concerns.length, 1);
    assert.match(merged.testingReview.missingE2e, /cancellation cleanup/);
    assert.equal(merged.testingReview.proofPath, "unit_only");
    assert.equal(merged.nextStep?.kind, "required");
  }
});

test("P3-only skill findings do not change the correct-patch verdict", () => {
  const clean = assessment();
  const low = assessment({
    reviewFindings: [reviewFinding({ priority: 3, title: "Low-impact edge case" })],
  });
  for (const [left, right] of orders(clean, low)) {
    const merged = combineSkillAssessment(left, right);
    assert.equal(merged.reviewFindings.length, 1);
    assert.equal(merged.reviewFindings[0]?.priority, 3);
    assert.equal(merged.overallCorrectness, "patch is correct");
  }
});

for (const priority of [0, 1, 2] as const) {
  test(
    "accepted blocking skill priority " + priority + " retains an incorrect-patch verdict",
    () => {
      const clean = assessment();
      const defect = assessment({
        overallCorrectness: "patch is incorrect",
        reviewFindings: [reviewFinding({ priority, title: "Reachable blocking defect" })],
      });
      for (const [left, right] of orders(clean, defect)) {
        assert.equal(combineSkillAssessment(left, right).overallCorrectness, "patch is incorrect");
      }
    },
  );
}

test("an incomplete skill run retains baseline blockers and cannot look complete", () => {
  const baseline = assessment({
    nextStep: { kind: "required", text: "Supply current-head reconnect proof." },
    realBehaviorProof: {
      status: "missing",
      summary: "Reconnect proof is missing.",
      evidenceKind: "none",
      needsContributorAction: true,
      dataModelCompatibility: "insufficient",
    },
  });
  const incomplete = incompleteSkillAssessment(baseline, "one reviewer did not finish");
  assert.equal(incomplete.codexTerminalFailure, true);
  assert.equal(incomplete.decision, "keep_open");
  assert.equal(incomplete.realBehaviorProof.status, "missing");
  assert.equal(incomplete.realBehaviorProof.dataModelCompatibility, "insufficient");
  assert.equal(incomplete.nextStep?.kind, "required");
  assert.match(incomplete.nextStep?.text ?? "", /reconnect proof/);
  assert.match(incomplete.solutionAssessment, /No dual-model consensus was produced/);
});
