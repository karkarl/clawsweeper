import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  executeHanselman,
  combineHanselmanAssessment,
  complementaryHanselmanEvidence,
  parseHanselmanReview,
  reconcileHanselman,
  type HanselmanInput,
  type HanselmanTransport,
} from "../dist/hanselman-review.js";
import {
  hanselmanContract,
  hanselmanPolicyHash,
  incompleteHanselmanProvenance,
  isHanselmanProvenance,
  type HanselmanFinding,
} from "../dist/hanselman-contract.js";
import { hanselmanSource } from "../dist/hanselman-source.js";
import { AgentInputScanError } from "../dist/agent-input-scan.js";
import { markdownFor, reviewStatusForDecision } from "../dist/clawsweeper-report-document.js";
import { parseDecision } from "../dist/clawsweeper.js";
import { requireReviewRecord } from "../dist/review-record.js";
import { closeDecision, item as fixtureItem } from "./helpers.ts";
import { codexEnv } from "../dist/codex-env.js";
import { parseArgs } from "../dist/clawsweeper-args.js";
import { prepareReviewCommand } from "../dist/clawsweeper-review-preparation.js";
import { repositoryProfileFor } from "../dist/repository-profiles.js";
import {
  assertReviewStrategyTarget,
  hanselmanCommand,
  reviewStrategy,
  effectiveReviewStrategy,
} from "../dist/review-strategy.js";
import {
  HanselmanProcessError,
  hanselmanProcessEnv,
  runHanselmanProcess,
} from "../dist/hanselman-process.js";
import { createReviewCoreRuntime } from "../dist/clawsweeper-review-core.js";
import {
  isAuthorReadOnlyCommandAllowed,
  parseCommand,
} from "../dist/repair/comment-router/admission.js";
import {
  exactReviewDecisionFrom,
  exactReviewPublicationFrom,
  mergePendingExactReviewDecision,
  exactReviewDecisionWithoutCommand,
} from "../dashboard/exact-review-decision.ts";
import type { ModelInfo } from "@github/copilot-sdk";

const input: HanselmanInput = {
  repo: "openclaw/openclaw-windows-node",
  kind: "pull_request",
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  prompt: "Exact diff, callers, tests, repository instructions and unresolved findings.",
  schema: "{}",
  timeoutMs: 30_000,
  maxResultBytes: 100_000,
};
const finding: HanselmanFinding = {
  title: "Missing guard",
  body: "The caller passes null and the path crashes.",
  severity: "HIGH",
  file: "src/example.ts",
  lineStart: 2,
  lineEnd: 3,
  suggestedFix: "Guard null before access.",
};
const review = (findings: HanselmanFinding[]) => ({
  scope: "delta and unresolved findings",
  findings,
});
const adjudication = (opus: number | null, astra: number | null) => ({
  opus,
  astra,
  disposition: "accepted",
  disputed: false,
  evidence: "Caller and test establish null input.",
  suggestedFix: "Guard null before access.",
  fixConfidence: 95,
  findingConfidence: 0.82,
});
function fakeTransport(
  options: {
    fail?: string;
    wrongSettings?: string;
    reject?: boolean;
    oneModel?: boolean;
    omit?: boolean;
    models?: ModelInfo[];
  } = {},
) {
  const calls: { role: string; prompt: string; started: number; finished: number }[] = [];
  const closed: string[] = [];
  const reads: string[] = [];
  const scanned: string[] = [];
  const models: ModelInfo[] = hanselmanContract().reviewers.map((model) => ({
    id: model.model,
    name: model.model,
    capabilities: {
      supports: { vision: false, reasoningEffort: true },
      limits: { max_context_window_tokens: 1000 },
    },
    supportedReasoningEfforts: ["high"],
  }));
  const transport: HanselmanTransport = {
    models: async () => options.models ?? models,
    scan: (text) => {
      scanned.push(text);
    },
    create: async (model, role) => ({
      id: `${role}-independent`,
      current: async () => ({
        modelId: model.model,
        reasoningEffort: model.reasoningEffort,
        contextTier: options.wrongSettings === role ? "default" : model.contextTier,
      }),
      send: async (prompt) => {
        const call = { role, prompt, started: Date.now(), finished: 0 };
        calls.push(call);
        await delay(15);
        call.finished = Date.now();
        if (options.fail === role) throw new Error("synthetic failure");
        if (role !== "coordinator")
          return JSON.stringify(review(options.oneModel && role === "astra" ? [] : [finding]));
        return JSON.stringify({
          decision: { summary: "Verified result" },
          adjudications: options.omit
            ? []
            : [
                {
                  ...adjudication(0, options.oneModel ? null : 0),
                  ...(options.reject ? { disposition: "rejected", disputed: true } : {}),
                },
              ],
        });
      },
      close: async () => {
        closed.push(role);
      },
      readHeadLines: (path, start, end) => {
        reads.push(`${path}:${start}-${end}`);
        return "pinned source";
      },
    }),
  };
  return { transport, calls, closed, reads, scanned };
}

test("Hanselman complements every admitted Windows Node PR, never other targets or issues", () => {
  assert.equal(reviewStrategy(undefined), "single");
  assert.equal(effectiveReviewStrategy(input.repo, "pull_request"), "hanselman");
  assert.equal(
    effectiveReviewStrategy(input.repo.toUpperCase(), "pull_request", "single"),
    "hanselman",
  );
  assert.equal(effectiveReviewStrategy(input.repo, "issue"), "single");
  assert.equal(effectiveReviewStrategy("openclaw/openclaw", "pull_request"), "single");
  assert.equal(reviewStrategy("hanselman"), "hanselman");
  assert.throws(() => reviewStrategy("auto"), /Unsupported/);
  assertReviewStrategyTarget("hanselman", input.repo, "pull_request");
  assertReviewStrategyTarget("single", "openclaw/openclaw", "issue");
  for (const repo of [
    "openclaw/openclaw",
    "openclaw/openclaw-windows-node-fork",
    "other/openclaw-windows-node",
  ]) {
    assert.throws(() => assertReviewStrategyTarget("hanselman", repo, "pull_request"), /only/);
  }
  assert.throws(() => assertReviewStrategyTarget("hanselman", input.repo, "issue"), /only/);
  assert.equal(hanselmanCommand("review hanselman focus"), true);
  assert.equal(hanselmanCommand("review focus on hanselman"), false);
  assert.equal(parseCommand("/review")?.freeform_prompt, undefined);
  assert.equal(parseCommand("/review hanselman")?.command, "review hanselman");
  assert.equal(
    isAuthorReadOnlyCommandAllowed({
      command: { intent: "re_review", command: "review hanselman", author: "author" },
      target: { author: "author" },
    }),
    false,
  );
});

test("normal requested actions and proof gaps reach both independent reviewers and bind the evidence digest", async () => {
  const baseline = parseDecision({
    ...closeDecision(),
    solutionAssessment: "Add a null guard; provide current-head Windows and Gateway proof.",
    overallConfidenceScore: 0.61,
  });
  const shared = complementaryHanselmanEvidence(input.prompt, baseline);
  const fake = fakeTransport();
  const result = await executeHanselman({ ...input, prompt: shared }, fake.transport);
  assert.equal(fake.calls[0]!.prompt, fake.calls[1]!.prompt);
  for (const call of fake.calls) {
    assert.match(call.prompt, /current-head Windows and Gateway proof/);
    assert.match(call.prompt, /"overallConfidenceScore":0.61/);
    assert.match(call.prompt, /untrusted evidence/);
  }
  const changed = await executeHanselman(
    {
      ...input,
      prompt: complementaryHanselmanEvidence(input.prompt, {
        ...baseline,
        solutionAssessment: "A different requested action.",
      }),
    },
    fakeTransport().transport,
  );
  assert.notEqual(result.provenance.evidenceDigest, changed.provenance.evidenceDigest);
});

test("combined result retains baseline blockers and findings without raising confidence or readiness", () => {
  const baseline = parseDecision({
    ...closeDecision(),
    confidence: "medium",
    solutionAssessment: "Add current-head Windows proof.",
    realBehaviorProof: {
      status: "insufficient",
      summary: "Windows proof is missing.",
      evidenceKind: "none",
      needsContributorAction: true,
    },
    prRating: {
      proofTier: "F",
      patchTier: "C",
      overallTier: "F",
      summary: "Proof missing.",
      nextSteps: ["Provide Windows proof."],
    },
    reviewFindings: [
      {
        title: "Existing requested fix",
        body: "Keep this blocker.",
        priority: 1,
        confidenceScore: 0.8,
        file: "src/example.ts",
        lineStart: 1,
        lineEnd: 1,
      },
    ],
    overallConfidenceScore: 0.6,
  });
  const clean = parseDecision({
    ...closeDecision(),
    decision: "keep_open",
    closeReason: "none",
    overallCorrectness: "patch is correct",
    overallConfidenceScore: 0.99,
    reviewFindings: [],
    prRating: {
      proofTier: "S",
      patchTier: "S",
      overallTier: "S",
      summary: "Model agreement.",
      nextSteps: [],
    },
  });
  const combined = combineHanselmanAssessment(baseline, clean);
  assert.equal(combined.decision, "keep_open");
  assert.equal(combined.closeReason, "none");
  assert.deepEqual(combined.reviewFindings, baseline.reviewFindings);
  assert.deepEqual(combined.realBehaviorProof, baseline.realBehaviorProof);
  assert.equal(combined.prRating.proofTier, "F");
  assert.equal(combined.prRating.overallTier, "F");
  assert.deepEqual(combined.prRating.nextSteps, baseline.prRating.nextSteps);
  assert.equal(combined.overallConfidenceScore, 0.6);
  assert.equal(combined.confidence, "medium");
  assert.equal(combined.overallCorrectness, "patch is incorrect");
  assert.match(combined.solutionAssessment, /Add current-head Windows proof/);
  const withNewFinding = combineHanselmanAssessment(clean, {
    ...clean,
    reviewFindings: baseline.reviewFindings,
    overallConfidenceScore: 0.5,
    prRating: { ...clean.prRating, nextSteps: ["Guard null input."] },
  });
  assert.equal(withNewFinding.reviewFindings.length, 1);
  assert.equal(withNewFinding.prRating.patchTier, "C");
  assert.equal(withNewFinding.prRating.overallTier, "C");
  assert.equal(withNewFinding.overallConfidenceScore, 0.5);
  assert.deepEqual(withNewFinding.prRating.nextSteps, ["Guard null input."]);
  assert.deepEqual(parseDecision(combined).reviewFindings, combined.reviewFindings);
});

test("runtime runs the normal assessment before Hanselman, keeps one combined result and preserves partial failures", async (t) => {
  const dual = await executeHanselman(input, fakeTransport().transport);
  const baseline = parseDecision({
    ...closeDecision(),
    solutionAssessment: "Run current-head Windows proof before readiness.",
    overallConfidenceScore: 0.65,
  });
  for (const scenario of ["complete", "dual-failed", "normal-failed", "ordinary"] as const) {
    await t.test(scenario, (t) => {
      const root = mkdtempSync(join(tmpdir(), "clawsweeper-complementary-runtime-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const calls: string[] = [];
      const core = createReviewCoreRuntime({
        reviewItemPromptPaths: { core: "", issue: "", pull_request: "", closeReasons: "" },
        decisionSchemaPath: join(process.cwd(), "schema", "clawsweeper-decision.schema.json"),
        prCloseCoverageProofPromptPath: "",
        run: () => "",
        untrustedCodexEnv: () => ({}),
        defaultRootCauseCluster: () => baseline.rootCauseCluster,
        parseDecision,
        ensureDir: (path) => {
          mkdirSync(path, { recursive: true });
        },
        inspectReviewCheckout: () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
        runReviewProcess: (options) => {
          calls.push("normal");
          assert.equal(options.prompt, input.prompt);
          if (scenario !== "ordinary") assert.ok(options.timeoutMs <= 3_000);
          if (scenario === "normal-failed")
            return {
              status: 1,
              signal: null,
              stdout: "",
              stderr: "",
              error: new Error("normal model failed"),
            };
          const outputIndex = options.codexExtraArgs!.indexOf("--output-last-message");
          assert.ok(outputIndex >= 0);
          writeFileSync(options.codexExtraArgs![outputIndex + 1]!, JSON.stringify(baseline));
          return { status: 0, signal: null, stdout: "", stderr: "" };
        },
        runHanselman: (options) => {
          calls.push("hanselman");
          assert.deepEqual(calls, ["normal", "hanselman"]);
          assert.match(options.prompt, /Run current-head Windows proof before readiness/);
          assert.equal(options.headSha, input.headSha);
          assert.equal(options.baseSha, input.baseSha);
          assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 9_000);
          if (scenario === "dual-failed")
            throw new Error("Hanselman incomplete: model unavailable.");
          return {
            ...dual,
            decision: { ...baseline, solutionAssessment: "Guard the newly found null path." },
          };
        },
      });
      const run = () =>
        core.runCodex({
          item: fixtureItem({
            repo: scenario === "ordinary" ? "owner/repo" : input.repo,
            kind: "pull_request",
          }),
          context: {
            issue: {},
            comments: [],
            timeline: [],
            pullRequest: { head: { sha: input.headSha }, base: { sha: input.baseSha } },
          },
          git: { mainSha: input.baseSha, latestRelease: null },
          strategy: scenario === "ordinary" ? "single" : "hanselman",
          model: "normal-model",
          reasoningEffort: "high",
          sandboxMode: "read-only",
          serviceTier: "",
          openclawDir: root,
          workDir: root,
          timeoutMs: 9_000,
          resultFileBytes: 1_000_000,
          prompt: input.prompt,
          reviewEnv: {},
        });
      if (scenario === "dual-failed") {
        assert.throws(run, (error: unknown) => {
          assert.ok(error instanceof HanselmanProcessError);
          assert.equal(error.provenance.status, "incomplete");
          assert.equal(error.baselineAssessment?.solutionAssessment, baseline.solutionAssessment);
          assert.equal(error.baselineAssessment?.overallConfidenceScore, 0.65);
          return true;
        });
      } else if (scenario === "normal-failed") {
        assert.throws(run, /normal model failed/);
        assert.deepEqual(calls, ["normal"]);
      } else {
        const result = run();
        assert.match(result.solutionAssessment, /Run current-head Windows proof before readiness/);
        assert.equal(result.overallConfidenceScore, 0.65);
        if (scenario === "complete") {
          assert.equal(result.hanselmanReview?.status, "complete");
          assert.equal(result.reviewFindings.length, 1);
          assert.equal(result.decision, "keep_open");
          assert.match(result.solutionAssessment, /Hanselman dual-model review/);
          const stored = requireReviewRecord(
            markdownFor({
              item: fixtureItem({ repo: input.repo, kind: "pull_request" }),
              decision: result,
              context: { issue: {}, comments: [], timeline: [] },
              git: { mainSha: input.baseSha, latestRelease: null, releaseStateComplete: true },
              action: { actionTaken: "kept_open" },
              reviewMode: "propose",
              snapshotHash: "snapshot",
              contentDigest: "content",
              reviewPolicy: hanselmanPolicyHash("policy"),
              runtime: {
                model: "normal-model + claude-opus-5.5 + gpt-6-astra",
                reasoningEffort: "high",
                strategy: "hanselman",
                hanselman: result.hanselmanReview,
              },
            }),
          ).decision;
          assert.deepEqual(stored.hanselmanReview, result.hanselmanReview);
          assert.deepEqual(stored.prRating, result.prRating);
          assert.equal(stored.overallConfidenceScore, 0.65);
          assert.match(
            stored.solutionAssessment,
            /Run current-head Windows proof before readiness/,
          );
        } else {
          assert.deepEqual(calls, ["normal"]);
          assert.equal(result.hanselmanReview, undefined);
        }
      }
    });
  }
});

test("parallel reviews get identical evidence and only the coordinator sees their union", async () => {
  const fake = fakeTransport();
  const result = await executeHanselman(input, fake.transport);
  assert.equal(fake.calls.length, 3);
  assert.equal(fake.calls[0]!.prompt, fake.calls[1]!.prompt);
  assert.ok(fake.calls[1]!.started < fake.calls[0]!.finished);
  assert.ok(fake.calls[2]!.started >= fake.calls[1]!.finished);
  assert.match(fake.calls[2]!.prompt, /Independent reviews/);
  assert.doesNotMatch(fake.calls[0]!.prompt, /Independent reviews/);
  assert.equal(new Set(result.provenance.models.map((model) => model.sessionId)).size, 3);
  assert.equal(result.provenance.models[1]?.contextTier, "long_context");
  assert.equal(result.provenance.headSha, input.headSha);
  assert.equal(result.provenance.baseSha, input.baseSha);
  assert.equal(result.provenance.skillRevision, hanselmanContract().revision);
  assert.ok(isHanselmanProvenance(result.provenance));
  assert.match(result.findings[0]!.body, /Consensus: HIGH/);
  assert.equal(result.findings[0]!.priority, 1);
  assert.equal(result.findings[0]!.confidenceScore, 0.82);
  assert.equal(fake.reads.length, 2);
  assert.deepEqual(fake.closed.sort(), ["astra", "coordinator", "opus"]);
});

test("one-model findings remain LOW consensus, and rejected disputes remain in provenance", async () => {
  const low = await executeHanselman(input, fakeTransport({ oneModel: true }).transport);
  assert.match(low.findings[0]!.body, /Consensus: LOW.*Astra: not flagged/s);
  const disputed = await executeHanselman(input, fakeTransport({ reject: true }).transport);
  assert.equal(disputed.findings.length, 0);
  assert.equal(disputed.provenance.adjudications[0]!.disputed, true);
  assert.equal(disputed.provenance.adjudications[0]!.disposition, "rejected");
  assert.ok(disputed.provenance.reviews[0]!.findings.length);
});

test("complete and incomplete provenance survives canonical record serialization", async () => {
  const result = await executeHanselman(input, fakeTransport().transport);
  const target = fixtureItem({ repo: input.repo, kind: "pull_request", number: 12 });
  const decision = parseDecision(
    closeDecision({ decision: "keep_open", closeReason: "none" }),
    target,
  );
  for (const provenance of [
    result.provenance,
    incompleteHanselmanProvenance(input.headSha, input.baseSha),
  ]) {
    const markdown = markdownFor({
      item: target,
      decision: { ...decision, localCheckoutAccess: "verified", hanselmanReview: provenance },
      context: { issue: {}, comments: [], timeline: [] },
      git: { mainSha: input.baseSha, latestRelease: null, releaseStateComplete: true },
      action: { actionTaken: "kept_open" },
      reviewMode: "propose",
      snapshotHash: "snapshot",
      contentDigest: "content",
      reviewPolicy: hanselmanPolicyHash("policy"),
      runtime: {
        model: "claude-opus-5.5 + gpt-6-astra",
        reasoningEffort: "high",
        strategy: "hanselman",
        hanselman: provenance,
      },
    });
    assert.deepEqual(requireReviewRecord(markdown).decision.hanselmanReview, provenance);
    assert.match(markdown, /^review_strategy: hanselman$/m);
    assert.match(
      markdown,
      provenance.status === "complete" ? /^review_status: complete$/m : /^review_status: failed$/m,
    );
  }
  assert.equal(isHanselmanProvenance({ ...result.provenance, skillRevision: "unpinned" }), false);
  assert.equal(isHanselmanProvenance({ ...result.provenance, models: [] }), false);
});

test("missing, failed or unsupported reviewers cannot produce consensus", async () => {
  for (const options of [{ fail: "opus" }, { fail: "astra" }, { wrongSettings: "astra" }]) {
    const fake = fakeTransport(options);
    await assert.rejects(executeHanselman(input, fake.transport), /incomplete/);
    assert.ok(!fake.calls.some((call) => call.role === "coordinator"));
    assert.equal(fake.closed.length, 2);
  }
  const missing = fakeTransport({ models: [] });
  await assert.rejects(executeHanselman(input, missing.transport), /unavailable model\/settings/);
  assert.equal(missing.calls.length, 0);
  const noEffort = fakeTransport();
  const models = await noEffort.transport.models();
  models[0]!.supportedReasoningEfforts = ["low"];
  await assert.rejects(executeHanselman(input, fakeTransport({ models }).transport), /unavailable/);
});

test("applied settings are checked after inference and absent default tiers are not invented", async () => {
  const unreported = fakeTransport();
  const createUnreported = unreported.transport.create;
  unreported.transport.create = async (...args) => {
    const session = await createUnreported(...args);
    if (args[1] === "opus")
      session.current = async () => ({
        modelId: args[0].model,
        reasoningEffort: args[0].reasoningEffort,
      });
    return session;
  };
  const result = await executeHanselman(input, unreported.transport);
  assert.equal(
    result.provenance.models.find((model) => model.role === "opus")?.contextTier,
    "unreported",
  );
  assert.ok(isHanselmanProvenance(result.provenance));
  const changed = fakeTransport();
  const createChanged = changed.transport.create;
  changed.transport.create = async (...args) => {
    const session = await createChanged(...args);
    const current = session.current;
    let reads = 0;
    session.current = async () => {
      const settings = await current();
      reads += 1;
      return reads > 1 && args[1] === "astra" ? { ...settings, reasoningEffort: "low" } : settings;
    };
    return session;
  };
  await assert.rejects(executeHanselman(input, changed.transport), /incomplete/);
  assert.ok(!changed.calls.some((call) => call.role === "coordinator"));
});

test("reconciliation must cover every finding once and cite actual head lines", async () => {
  await assert.rejects(executeHanselman(input, fakeTransport({ omit: true }).transport), /omitted/);
  const reviews = [review([finding]), review([finding])] as const;
  assert.throws(
    () =>
      reconcileHanselman(
        JSON.stringify({
          decision: {},
          adjudications: [adjudication(0, 0), adjudication(0, null)],
        }),
        reviews,
        () => "",
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      reconcileHanselman(
        JSON.stringify({
          decision: {},
          adjudications: [adjudication(0, 0)],
        }),
        reviews,
        () => {
          throw new Error("nonexistent head lines");
        },
      ),
    /nonexistent/,
  );
  for (const severity of ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as const) {
    const single = [review([{ ...finding, severity }]), review([])] as const;
    const result = reconcileHanselman(
      JSON.stringify({
        decision: {},
        adjudications: [adjudication(0, null)],
      }),
      single,
      () => "",
    );
    assert.equal(result.findings[0]!.priority, hanselmanContract().severityPriority[severity]);
  }
});

test("invalid source, output, coordinator and scanner failures remain explicit failures", async () => {
  await assert.rejects(
    executeHanselman({ ...input, headSha: "moving-main" }, fakeTransport().transport),
    /exact head/,
  );
  await assert.rejects(
    executeHanselman({ ...input, maxResultBytes: 1 }, fakeTransport().transport),
    /incomplete/,
  );
  await assert.rejects(
    executeHanselman(input, fakeTransport({ fail: "coordinator" }).transport),
    /synthetic failure/,
  );
  const fake = fakeTransport();
  fake.transport.scan = () => {
    throw new Error("scan refused");
  };
  await assert.rejects(executeHanselman(input, fake.transport), /scan refused/);
  assert.equal(fake.calls.length, 0);
  assert.throws(
    () =>
      parseHanselmanReview(
        JSON.stringify({ scope: "x", findings: [{ ...finding, severity: "P1" }] }),
      ),
    /severity/,
  );
  assert.throws(() => parseHanselmanReview('{"scope":"x","findings":null}'), /findings/);
  const refused = fakeTransport();
  const create = refused.transport.create;
  refused.transport.create = async (...args) => {
    const session = await create(...args);
    if (args[1] === "opus")
      session.send = async () => {
        throw new AgentInputScanError("findings");
      };
    return session;
  };
  await assert.rejects(
    executeHanselman(input, refused.transport),
    (error) => error instanceof AgentInputScanError,
  );
  const incomplete = incompleteHanselmanProvenance(input.headSha, input.baseSha);
  assert.equal(incomplete.skillRevision, hanselmanContract().revision);
  assert.equal(incomplete.requestedModels.length, 3);
  assert.deepEqual(incomplete.observedModels, []);
  assert.ok(isHanselmanProvenance(incomplete));
  assert.equal(
    reviewStatusForDecision({
      localCheckoutAccess: "verified",
      summary: "Hanselman review incomplete.",
      hanselmanReview: incomplete,
    }),
    "failed",
  );
});

test("CLI strategy restrictions reject sweeps and missing authority before checkout", (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-hanselman-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let checkouts = 0;
  const deps = (repo: string) => ({
    DEFAULT_PLAN_BATCH_SIZE: 3,
    repoFromArgs: () => repositoryProfileFor(repo),
    targetRepo: () => repo,
    localExactReviewItem: () => false,
    defaultReviewArtifactDir: () => root,
    defaultItemsDir: () => root,
    defaultLocalRangeArtifactDir: () => root,
    defaultLocalRangeHistoryPath: () => join(root, "history.md"),
    buildLocalRangeReview: () => {
      throw new Error("unexpected range preparation");
    },
    ensureDir: () => {},
    suppliedReviewStartLeaseFromArgs: () => null,
    reviewCodexForcedLoginMethod: () => "",
    reviewPolicyHash: () => "fixture-policy",
    codexReviewFailureRetryable: () => false,
    resolveReviewCheckout: () => {
      checkouts += 1;
      throw new Error("unexpected checkout");
    },
  });
  for (const scenario of [
    { repo: "openclaw/openclaw", args: ["--local-only", "--item-number", "12"], message: /only/ },
    { repo: input.repo, args: ["--local-only"], message: /one exact PR/ },
    {
      repo: input.repo,
      args: ["--local-only", "--item-numbers", "12,13"],
      message: /one exact PR/,
    },
    { repo: input.repo, args: ["--local-range"], message: /one exact PR/ },
    { repo: input.repo, args: ["--item-number", "12"], message: /exact-review queue lease/ },
  ]) {
    assert.throws(
      () =>
        prepareReviewCommand(
          parseArgs(["--review-strategy", "hanselman", "--artifact-dir", root, ...scenario.args]),
          deps(scenario.repo),
        ),
      scenario.message,
    );
  }
  assert.equal(checkouts, 0);
});

test("hosted singleton forms share lease validation and local item kind is not guessed", (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-hanselman-singleton-"));
  const previousEnv = process.env;
  t.after(() => {
    process.env = previousEnv;
    rmSync(root, { recursive: true, force: true });
  });
  let checkouts = 0;
  const dependencies = {
    DEFAULT_PLAN_BATCH_SIZE: 3,
    repoFromArgs: () => repositoryProfileFor(input.repo),
    targetRepo: () => input.repo,
    localExactReviewItem: () => false,
    defaultReviewArtifactDir: () => root,
    defaultItemsDir: () => root,
    defaultLocalRangeArtifactDir: () => root,
    defaultLocalRangeHistoryPath: () => join(root, "history.md"),
    buildLocalRangeReview: () => {
      throw new Error("unexpected range preparation");
    },
    ensureDir: (path: string) => {
      mkdirSync(path, { recursive: true });
    },
    suppliedReviewStartLeaseFromArgs: () => null,
    reviewCodexForcedLoginMethod: () => "",
    reviewPolicyHash: () => "fixture-policy",
    codexReviewFailureRetryable: () => false,
    gitInfo: () => ({ mainSha: input.baseSha, latestRelease: null }),
    resolveReviewCheckout: () => {
      checkouts += 1;
      return { openclawDir: root };
    },
  };
  for (const selection of [
    ["--item-number", "12"],
    ["--item-numbers", "12"],
  ]) {
    process.env = {
      ...previousEnv,
      CLAWSWEEPER_REVIEW_STRATEGY: "hanselman",
      EXACT_REVIEW_ITEM_KEY: `${input.repo}#12`,
      EXACT_REVIEW_ITEM_KIND: "pull_request",
      EXACT_REVIEW_LEASE_ID: "fixture-queue-lease",
    };
    const args = parseArgs([
      ...selection,
      "--output-retention",
      "debug",
      "--artifact-dir",
      join(root, "output"),
    ]);
    const prepared = prepareReviewCommand(args, dependencies);
    try {
      assert.equal(prepared.strategy, "hanselman");
      assert.equal(prepared.itemNumber ?? prepared.itemNumbers?.[0], 12);
    } finally {
      prepared.cleanupReviewOutput();
    }
    const beforeMismatch = checkouts;
    process.env.EXACT_REVIEW_ITEM_KEY = `${input.repo}#13`;
    assert.throws(() => prepareReviewCommand(args, dependencies), /exact-review queue lease/);
    assert.equal(checkouts, beforeMismatch);
    process.env.EXACT_REVIEW_ITEM_KEY = `${input.repo}#12`;
    delete process.env.EXACT_REVIEW_LEASE_ID;
    assert.throws(() => prepareReviewCommand(args, dependencies), /exact-review queue lease/);
    assert.equal(checkouts, beforeMismatch);
  }
  process.env.EXACT_REVIEW_ITEM_KEY = `${input.repo}#12`;
  for (const selection of [
    ["--item-numbers", "12,13"],
    ["--item-number", "12", "--item-numbers", "12"],
  ]) {
    const beforeInvalid = checkouts;
    assert.throws(
      () =>
        prepareReviewCommand(
          parseArgs([
            ...selection,
            "--output-retention",
            "debug",
            "--artifact-dir",
            join(root, "output"),
          ]),
          dependencies,
        ),
      /one exact PR/,
    );
    assert.equal(checkouts, beforeInvalid);
  }
  process.env = {
    ...previousEnv,
    CLAWSWEEPER_REVIEW_STRATEGY: "single",
    EXACT_REVIEW_ITEM_KIND: "pull_request",
  };
  const local = prepareReviewCommand(
    parseArgs(["--local-only", "--item-number", "12", "--output-retention", "none"]),
    dependencies,
  );
  try {
    assert.equal(
      local.strategy,
      "single",
      "local selection must wait for the hydrated item kind, even with stale hosted environment",
    );
    assert.equal(effectiveReviewStrategy(input.repo, "issue", local.strategy), "single");
    assert.equal(effectiveReviewStrategy(input.repo, "pull_request", local.strategy), "hanselman");
  } finally {
    local.cleanupReviewOutput();
  }
});

test("dedicated inference auth does not borrow workflow or user credentials", () => {
  assert.deepEqual(
    hanselmanProcessEnv({
      PATH: "tools",
      GH_TOKEN: "workflow",
      GITHUB_TOKEN: "workflow",
      OPENAI_API_KEY: "provider",
      COPILOT_HOME: "shared",
      CLAWSWEEPER_WEBHOOK_SECRET: "secret",
      NODE_OPTIONS: "--require evil",
    }),
    { PATH: "tools" },
  );
  const previous = process.env.CLAWSWEEPER_HANSELMAN_TOKEN;
  process.env.CLAWSWEEPER_HANSELMAN_TOKEN = "dedicated-inference-fixture";
  assert.equal(codexEnv().CLAWSWEEPER_HANSELMAN_TOKEN, undefined);
  delete process.env.CLAWSWEEPER_HANSELMAN_TOKEN;
  try {
    assert.throws(() => runHanselmanProcess(input, process.cwd()), /not configured/);
  } finally {
    if (previous !== undefined) process.env.CLAWSWEEPER_HANSELMAN_TOKEN = previous;
  }
});

test("queue policy automatically selects Hanselman and survives replacement or removal of a command", () => {
  const base = {
    targetRepo: input.repo,
    targetBranch: "main",
    itemNumber: 12,
    itemKind: "pull_request" as const,
    sourceEvent: "pull_request" as const,
    sourceAction: "re_review",
    supersedesInProgress: false,
    commandStatusMarker: "<!-- clawsweeper-command-status:12:re_review:first -->",
    sourceCommentId: 3,
    sourceCommentUpdatedAt: "2026-10-16T14:00:00Z",
    commandBodyDigest: "c".repeat(64),
    commandOrigin: "comment_router" as const,
    sourceCommentVerified: true,
    reviewStrategy: "hanselman" as const,
  };
  assert.ok(exactReviewDecisionFrom(base));
  assert.equal(exactReviewDecisionFrom({ ...base, targetRepo: "openclaw/openclaw" }), null);
  assert.equal(
    exactReviewDecisionFrom({ ...base, sourceCommentVerified: false })?.reviewStrategy,
    "hanselman",
  );
  assert.equal(exactReviewDecisionFrom({ ...base, reviewStrategy: "unknown" }), null);
  const { reviewStrategy: _strategy, ...ordinary } = base;
  const merged = mergePendingExactReviewDecision(base, {
    ...ordinary,
    commandStatusMarker: "<!-- clawsweeper-command-status:12:re_review:next -->",
  });
  assert.equal(merged.reviewStrategy, "hanselman");
  assert.equal(exactReviewDecisionWithoutCommand(base).reviewStrategy, "hanselman");
  const automatic = exactReviewDecisionWithoutCommand(base);
  assert.equal(automatic.sourceCommentId, undefined);
  for (const sourceAction of ["opened", "scheduled", "re_review", "synchronize"]) {
    const decision = exactReviewDecisionFrom({
      ...automatic,
      sourceAction,
      reviewStrategy: "single",
    });
    assert.equal(decision?.reviewStrategy, "hanselman");
  }
  assert.equal(
    exactReviewDecisionFrom({
      ...automatic,
      targetRepo: "openclaw/openclaw",
      reviewStrategy: "single",
    })?.reviewStrategy,
    undefined,
  );
  const { reviewStrategy: _automaticStrategy, ...legacyProducer } = automatic;
  const historical = exactReviewPublicationFrom({
    artifactName: "exact-review-123-1",
    producerRunId: "123",
    producerRunAttempt: 1,
    sourceSha: input.headSha,
    itemKey: `${input.repo}#12`,
    protocolVersion: 1,
    leaseRevision: null,
    claimGeneration: null,
    producerDecision: { ...legacyProducer, sourceAction: "opened" },
    liveProceeded: true,
    liveTerminalNoop: false,
    liveTerminalMissing: false,
    liveGuardedOpen: false,
  });
  assert.ok(historical);
  assert.equal(
    historical.producerDecision.reviewStrategy,
    undefined,
    "historical single-model artifacts must not be relabeled as dual-model",
  );
  assert.equal(
    exactReviewDecisionFrom({
      ...automatic,
      itemKind: "issue",
      sourceEvent: "issues",
      reviewStrategy: "single",
    })?.reviewStrategy,
    undefined,
  );
  const hash = hanselmanPolicyHash("single-policy");
  assert.notEqual(hash, "single-policy");
  assert.notEqual(hash, hanselmanPolicyHash("changed-policy"));
  assert.equal(hash, hanselmanPolicyHash("single-policy"));
});

test("pinned source uses base instructions, repeat deltas, bounded reads and source scans", (t) => {
  const root = mkdtempSync(join(tmpdir(), "clawsweeper-hanselman-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${join(root, "empty-hooks")}`,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  mkdirSync(join(root, "empty-hooks"));
  git("init", "--initial-branch=main");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "AGENTS.md"), "Trusted base repository instructions.\n");
  writeFileSync(join(root, "src", "example.ts"), "export const example = 1;\n");
  writeFileSync(
    join(root, "test", "example.test.ts"),
    "import { example } from '../src/example.js';\n",
  );
  git("add", ".");
  git("commit", "-m", "Base source fixture");
  const baseSha = git("rev-parse", "HEAD");
  writeFileSync(join(root, "AGENTS.md"), "Malicious replacement instructions in PR head.\n");
  writeFileSync(join(root, "src", "example.ts"), "export const example = 2;\n");
  git("add", ".");
  git("commit", "-m", "Previous reviewed fixture");
  const previousHeadSha = git("rev-parse", "HEAD");
  writeFileSync(join(root, "src", "example.ts"), "export const example = 3;\n");
  git("add", ".");
  git("commit", "-m", "Current head fixture");
  const headSha = git("rev-parse", "HEAD");
  const scanned: string[] = [];
  const source = hanselmanSource(
    root,
    { ...input, headSha, baseSha, previousHeadSha },
    ({ prompt }) => {
      scanned.push(prompt);
    },
  );
  assert.match(source.scope, /Repeat review: delta/);
  assert.match(source.instructions, /Trusted base repository instructions/);
  assert.doesNotMatch(source.instructions, /Malicious replacement/);
  assert.match(source.changedFiles, /export const example = 3/);
  assert.match(source.changedFiles, /example.test.ts/);
  assert.match(source.callerEvidence, /example.test.ts/);
  assert.ok(scanned.some((text) => text.includes("example = 3")));
  assert.throws(() => source.read("head", "../AGENTS.md"), /pinned tree/);
  assert.throws(() => source.readHeadLines("src/example.ts", 100, 101), /nonexistent/);
  assert.match(source.read("base", "src/example.ts"), /example = 1/);
  const fallback = hanselmanSource(
    root,
    { ...input, headSha, baseSha, previousHeadSha: "e".repeat(40) },
    () => {},
  );
  assert.match(fallback.scope, /Full review.*previous head unavailable/);
  const bounded = hanselmanSource(root, { ...input, headSha, baseSha }, () => {});
  for (let index = 0; index < hanselmanContract().limits.maxReadCallsPerSession; index += 1) {
    bounded.read("head", "src/example.ts");
  }
  assert.throws(() => bounded.read("head", "src/example.ts"), /call budget/);
  for (let index = 0; index < 100; index += 1) {
    assert.equal(bounded.readHeadLines("src/example.ts", 1, 1), "export const example = 3;");
  }
  const refused = hanselmanSource(root, { ...input, headSha, baseSha }, () => {
    throw new AgentInputScanError("findings");
  });
  assert.throws(() => refused.read("head", "src/example.ts"), AgentInputScanError);
});
