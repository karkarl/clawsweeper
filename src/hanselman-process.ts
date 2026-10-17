import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HanselmanInput, executeHanselman } from "./hanselman-review.js";
import { assertReviewStrategyTarget } from "./review-strategy.js";
import { AgentInputScanError } from "./agent-input-scan.js";
import type { AgentInputScanFailureReason } from "./exact-review-failure-reason.js";
import type { HanselmanIncompleteProvenance } from "./hanselman-contract.js";
import type { Decision } from "./clawsweeper-types.js";

export class HanselmanProcessError extends Error {
  constructor(
    message: string,
    readonly provenance: HanselmanIncompleteProvenance,
    readonly baselineAssessment?: Decision,
  ) {
    super(message);
    this.name = "HanselmanProcessError";
  }
}

export function hanselmanProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "APPDATA",
    "PATHEXT",
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}

export function runHanselmanProcess(input: HanselmanInput, cwd: string) {
  assertReviewStrategyTarget("hanselman", input.repo, input.kind);
  const token = process.env.CLAWSWEEPER_HANSELMAN_TOKEN;
  if (!token)
    throw new Error("Hanselman incomplete: CLAWSWEEPER_HANSELMAN_TOKEN is not configured.");
  const stateDir = mkdtempSync(join(tmpdir(), "clawsweeper-hanselman-"));
  const resultPath = join(stateDir, "result.json");
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("./hanselman-process-worker.js", import.meta.url)), stateDir, cwd],
      {
        cwd: stateDir,
        input: JSON.stringify(input),
        env: { ...hanselmanProcessEnv(process.env), CLAWSWEEPER_HANSELMAN_TOKEN: token },
        encoding: "utf8",
        timeout: input.timeoutMs + 30_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error("Hanselman incomplete: isolated hosted runner failed or timed out.");
    }
    if (statSync(resultPath).size > input.maxResultBytes)
      throw new Error("Hanselman result budget exceeded.");
    const output = JSON.parse(readFileSync(resultPath, "utf8")) as
      | Awaited<ReturnType<typeof executeHanselman>>
      | {
          failure: string;
          provenance: HanselmanIncompleteProvenance;
          scanFailureReason?: AgentInputScanFailureReason;
        };
    if ("failure" in output) {
      if (output.scanFailureReason) throw new AgentInputScanError(output.scanFailureReason);
      throw new HanselmanProcessError(output.failure, output.provenance);
    }
    if (
      output.provenance.headSha !== input.headSha ||
      output.provenance.baseSha !== input.baseSha ||
      output.provenance.status !== "complete"
    )
      throw new Error("Hanselman incomplete: stale or incomplete source provenance.");
    return output;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}
