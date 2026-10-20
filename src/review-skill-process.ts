import { REVIEW_SKILL_WORKER_STOP_MARGIN_MS } from "./review-skill-config.js";
import { publicSkillProvenance } from "./review-skill-provider.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentWorkerProcess } from "./agent-runner.js";
import { AgentInputScanError } from "./agent-input-scan.js";
import { agentInputScanFailureReason } from "./exact-review-failure-reason.js";
import { parseSkillDecision } from "./review-skill-runtime.js";
import { ReviewSkillProcessError, type SkillRunDiagnostic } from "./review-skill-diagnostics.js";
import { neutralizeOwnedSectionSpoofing } from "./clawsweeper-report-helpers.js";
import { reviewToolCacheRoot } from "./review-tool-bootstrap.js";
import type { SkillInput, SkillReceipt } from "./review-skill-runtime.js";
import type { Decision } from "./clawsweeper-types.js";

export function reviewSkillProcessEnv(
  env: NodeJS.ProcessEnv,
  stateDir: string,
  apiKeyEnv?: string,
): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "PATHEXT",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
    "NODE_EXTRA_CA_CERTS",
  ];
  if (apiKeyEnv === "OPENROUTER_API_KEY" || apiKeyEnv === "CLAWSWEEPER_SKILL_API_KEY")
    names.push(apiKeyEnv);
  else names.push("CLAWSWEEPER_SKILL_TOKEN");
  return {
    ...Object.fromEntries(
      names.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
    ),
    // Keep the host-selected, checksum-verified scanner cache while isolating
    // credential/config homes. The scanner revalidates this location against
    // both checkout roots; never silently bootstrap under a new temporary HOME.
    CLAWSWEEPER_REVIEW_TOOLS_DIR: reviewToolCacheRoot(env),
    HOME: stateDir,
    USERPROFILE: stateDir,
    LOCALAPPDATA: stateDir,
    APPDATA: stateDir,
    XDG_CONFIG_HOME: stateDir,
    XDG_CACHE_HOME: stateDir,
    CODEX_BIN: process.execPath,
  };
}
export function runReviewSkillProcess(
  input: SkillInput,
  cwd: string,
): { decision: Decision; receipt: SkillReceipt } {
  const key = input.selection.config.provider?.apiKeyEnv ?? "CLAWSWEEPER_SKILL_TOKEN";
  if (!process.env[key])
    throw new Error("Review skill incomplete: dedicated inference credential is not configured.");
  const stateDir = mkdtempSync(join(tmpdir(), "clawsweeper-skill-"));
  const resultPath = join(stateDir, "result.json");
  try {
    // Reuse the managed supervisor, process-group cancellation and bounded
    // streams. This is a Node SDK worker, not a Codex model invocation.
    const processResult = runAgentWorkerProcess({
      workerPath: fileURLToPath(new URL("./review-skill-worker.js", import.meta.url)),
      workerArgs: [stateDir, cwd],
      cwd: stateDir,
      env: reviewSkillProcessEnv(process.env, stateDir, input.selection.config.provider?.apiKeyEnv),
      input: JSON.stringify(input),
      timeoutMs: input.selection.config.timeoutMs + REVIEW_SKILL_WORKER_STOP_MARGIN_MS,
      tailBytes: 1024,
      outputFileBytes: 4096,
    });
    if (
      !existsSync(resultPath) ||
      statSync(resultPath).size > input.selection.config.maxResultBytes
    )
      throw new ReviewSkillProcessError({ phase: "result", sessions: [] }, input.selection.config);
    let output: {
      decision?: unknown;
      receipt?: SkillReceipt;
      failure?: string;
      diagnostic?: unknown;
      scanFailureReason?: unknown;
    };
    try {
      output = JSON.parse(readFileSync(resultPath, "utf8"));
    } catch (error) {
      throw new ReviewSkillProcessError(
        { phase: "result", validationField: "json", sessions: [] },
        input.selection.config,
        { cause: error },
      );
    }
    if (output.scanFailureReason)
      throw new AgentInputScanError(
        agentInputScanFailureReason(output.scanFailureReason) ?? "scanner_failed",
      );
    if (
      processResult.error ||
      processResult.status !== 0 ||
      output.failure ||
      !output.receipt ||
      output.receipt.status !== "complete" ||
      output.receipt.headSha !== input.headSha ||
      output.receipt.baseSha !== input.baseSha ||
      output.receipt.skill.digest !== input.skill.digest
    )
      throw new ReviewSkillProcessError(output.diagnostic, input.selection.config);
    const diagnostic: SkillRunDiagnostic = { phase: "result", sessions: [] };
    try {
      return { decision: parseSkillDecision(output.decision, diagnostic), receipt: output.receipt };
    } catch (error) {
      throw new ReviewSkillProcessError(diagnostic, input.selection.config, { cause: error });
    }
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}
function safeCell(value: unknown): string {
  return neutralizeOwnedSectionSpoofing(String(value))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "\\|")
    .replace(/\r?\n/g, "<br>");
}
export function renderSkillReceipt(receipt: SkillReceipt): string {
  const groups = new Map<string, typeof receipt.adjudications>();
  for (const row of receipt.adjudications)
    groups.set(row.groupId, [...(groups.get(row.groupId) ?? []), row]);
  const models = [0, 1].map(
    (i) =>
      receipt.sessions.find((session) => session.role === "reviewer-" + i)?.requested.model ??
      "unreported",
  );
  return [
    "Host-supervised review skill: complete (not merge/publication authority).",
    "Adapter provenance: " + safeCell(JSON.stringify(publicSkillProvenance(receipt.runtime))),
    "Verified session/runtime cleanup: " +
      safeCell(JSON.stringify(receipt.cleanup ?? "unreported")),
    "Skill: " +
      safeCell(receipt.skill.slug) +
      " @ " +
      safeCell(receipt.skill.revision) +
      "; digest=" +
      safeCell(receipt.skill.digest),
    ...receipt.skill.files.map(
      (file) => "Reference: " + safeCell(file.path) + "; sha256=" + safeCell(file.sha256),
    ),
    "Repository: " +
      safeCell(receipt.repo) +
      "; head=" +
      safeCell(receipt.headSha) +
      "; base=" +
      safeCell(receipt.baseSha),
    "Identical evidence sha256=" +
      safeCell(receipt.evidenceDigest) +
      "; independent prompt sha256=" +
      safeCell(receipt.reviewerPromptDigest),
    ...receipt.sessions.map(
      (session) =>
        safeCell(session.role) +
        " session=" +
        safeCell(session.sessionId) +
        "; requested=" +
        safeCell(JSON.stringify(session.requested)) +
        "; applied=" +
        safeCell(JSON.stringify(session.applied)) +
        "; usageModels=" +
        safeCell(JSON.stringify(session.usageModels)) +
        "; actualUsageReasoningEfforts=" +
        safeCell(JSON.stringify(session.usageReasoningEfforts)),
    ),
    ...receipt.scopes.map(
      (scope, i) => "Reviewer " + i + " inspected scope/limits: " + safeCell(scope),
    ),
    "",
    "Consensus severity table (P0 critical, P1 high, P2 medium, P3 low):",
    "",
    "| Finding | " +
      safeCell(models[0]) +
      " | " +
      safeCell(models[1]) +
      " | Consensus | Disposition | Suggested fix | Fix confidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...[...groups.values()].map(
      (group) =>
        "| " +
        safeCell(group[0]!.title) +
        " | " +
        [0, 1]
          .map((i) => {
            const row = group.find((entry) => entry.reviewer === i);
            return row ? "P" + row.priority : "not flagged";
          })
          .join(" | ") +
        " | " +
        (group.length === 2 && !group[0]!.disputed ? "HIGH" : "LOW") +
        (group[0]!.disputed ? " (disputed)" : "") +
        " | " +
        group[0]!.disposition +
        " | " +
        safeCell([...new Set(group.map((row) => row.suggestedFix))].join("; ")) +
        " | " +
        Math.min(...group.map((row) => row.fixConfidence)) +
        "% |",
    ),
    "",
    "Complete finding-union dispositions: " + safeCell(JSON.stringify(receipt.adjudications)),
  ].join("\n");
}
