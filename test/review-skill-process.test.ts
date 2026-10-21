import assert from "node:assert/strict";
import childProcess, { execFileSync, spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAgentWorkerProcess } from "../dist/agent-runner.js";
import {
  reviewSkillProcessEnv,
  runReviewSkillProcess,
  assertSeparateSkillCredential,
} from "../dist/review-skill-process.js";
import { readSkillProviderCatalog } from "../dist/review-skill-provider.js";
import { parseSkillExecutionConfig } from "../dist/review-skill-config.js";

// Real Node processes exercise the shared managed owner used by the SDK worker.
// They are deliberately not inference proof and make no network/model requests.
function processFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "review-skill-process-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pids = join(root, "pids.json");
  const worker = join(root, "worker.mjs");
  writeFileSync(
    worker,
    [
      'import {spawn} from "node:child_process";',
      'import {writeFileSync} from "node:fs";',
      'const child=spawn(process.execPath,["-e",' +
        JSON.stringify('process.on("SIGTERM",()=>{});setInterval(()=>{},1000)') +
        '],{stdio:"ignore"});',
      "writeFileSync(" + JSON.stringify(pids) + ",JSON.stringify([process.pid,child.pid]));",
      'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);',
    ].join("\n"),
  );
  return { root, pids, worker };
}
function live(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "win32") {
      const status = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return !!status && !status.startsWith("Z");
    }
    return true;
  } catch {
    return false;
  }
}
async function noLeaks(pids: number[]) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (pids.every((pid) => !live(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(
    "Managed skill process leaked a live worker/descendant: " + pids.filter(live).join(","),
  );
}

test("skill managed owner hard timeout kills real worker and TERM-ignoring descendant", async (t) => {
  const f = processFixture(t);
  const result = runAgentWorkerProcess({
    workerPath: f.worker,
    workerArgs: [],
    cwd: f.root,
    env: {
      ...reviewSkillProcessEnv(process.env, f.root),
      CODEX_BIN: "must-not-run",
      CLAWSWEEPER_RUNNER: "unknown-must-not-fallback",
    },
    input: "",
    timeoutMs: 1000,
    tailBytes: 1024,
    outputFileBytes: 4096,
  });
  assert.ok(result.error);
  assert.match(result.error.message, /timed out/);
  assert.ok(existsSync(f.pids));
  const pids = JSON.parse(readFileSync(f.pids, "utf8"));
  await noLeaks(pids);
});

test(
  "skill managed supervisor cancellation forwards to entire real process group",
  {
    skip:
      process.platform === "win32"
        ? "POSIX signal forwarding; Windows timeout uses taskkill owner above"
        : false,
  },
  async (t) => {
    const f = processFixture(t);
    const options = join(f.root, "supervisor.json");
    const supervisor = new URL("../dist/codex-process-worker.js", import.meta.url);
    writeFileSync(
      options,
      JSON.stringify({
        command: process.execPath,
        args: [f.worker],
        timeoutMs: 60_000,
        resultPath: join(f.root, "result.json"),
        stdoutPath: join(f.root, "stdout"),
        stderrPath: join(f.root, "stderr"),
        tailBytes: 1024,
        maxOutputFileBytes: 4096,
      }),
    );
    const owner = spawn(process.execPath, [supervisor.pathname, options], {
      cwd: f.root,
      env: reviewSkillProcessEnv(process.env, f.root),
      stdio: ["pipe", "ignore", "ignore"],
    });
    owner.stdin.end();
    t.after(() => {
      if (owner.exitCode === null) owner.kill("SIGKILL");
    });
    for (let attempt = 0; attempt < 100 && !existsSync(f.pids); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(existsSync(f.pids));
    const pids = JSON.parse(readFileSync(f.pids, "utf8"));
    owner.kill("SIGTERM");
    await noLeaks(pids);
  },
);

const config = () =>
  parseSkillExecutionConfig({
    adapter: "copilot",
    provider: { baseUrl: "https://example.invalid/v1", apiKeyEnv: "CLAWSWEEPER_SKILL_API_KEY" },
    reviewers: [
      { model: "a", reasoningEffort: "high", contextTier: "default" },
      { model: "b", reasoningEffort: "high", contextTier: "long_context" },
    ],
    coordinator: { model: "a", reasoningEffort: "high", contextTier: "default" },
    timeoutMs: 1000,
    maxResultBytes: 65536,
  });

test("BYOK catalog validates upstream exact ids/capabilities without sending inference or publication credentials", async (t) => {
  const row = (id: string) => ({
    id,
    name: id,
    context_length: 1_000_000,
    supported_parameters: ["reasoning_effort", "tools", "structured_outputs", "response_format"],
    architecture: { input_modalities: ["text"] },
    top_provider: { max_completion_tokens: 64000 },
  });
  const calls: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, options]);
    return new Response(JSON.stringify({ data: [row("a"), row("b")] }), { status: 200 });
  });
  const result = await readSkillProviderCatalog(config(), Date.now() + 1000);
  assert.deepEqual(
    result.models.map((model) => model.id),
    ["a", "b"],
  );
  assert.equal(result.models[1]!.capabilities.limits.max_context_window_tokens, 1_000_000);
  assert.equal(
    result.models[0]!.supportedReasoningEfforts,
    undefined,
    "catalog does not fabricate effort values; session readback verifies exact effort",
  );
  assert.equal((calls[0] as unknown[])[0], "https://example.invalid/v1/models");
  assert.equal(Object.hasOwn((calls[0] as unknown[])[1] as object, "headers"), false);
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ data: [row("a")] }), { status: 200 }),
  );
  await assert.rejects(readSkillProviderCatalog(config(), Date.now() + 1000), /unavailable/);
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ data: [{ ...row("a"), supported_parameters: [] }, row("b")] }),
        { status: 200 },
      ),
  );
  await assert.rejects(readSkillProviderCatalog(config(), Date.now() + 1000), /capabilities/);
});

test("skill worker keeps the admitted scanner cache without restoring credential homes", () => {
  const cache = join(tmpdir(), "admitted-skill-scanner-cache");
  const state = join(tmpdir(), "isolated-skill-worker");
  const env = reviewSkillProcessEnv(
    {
      PATH: process.env.PATH,
      HOME: join(tmpdir(), "operator-home"),
      CLAWSWEEPER_REVIEW_TOOLS_DIR: cache,
      GH_TOKEN: "publication-only",
      OPENROUTER_API_KEY: "provider-only",
    },
    state,
    "OPENROUTER_API_KEY",
  );
  assert.equal(env.CLAWSWEEPER_REVIEW_TOOLS_DIR, cache);
  assert.equal(env.HOME, state);
  assert.equal(env.USERPROFILE, state);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.OPENROUTER_API_KEY, "provider-only");
});

test("agent worker owner rejects command/relative paths instead of selecting an ambient runner", (t) => {
  const f = processFixture(t);
  const options = {
    workerArgs: [],
    cwd: f.root,
    env: { ...reviewSkillProcessEnv(process.env, f.root), CODEX_BIN: "untrusted-command" },
    input: "",
    timeoutMs: 1000,
  };
  assert.throws(
    () => runAgentWorkerProcess({ ...options, workerPath: "relative.js" }),
    /trusted absolute/,
  );
  assert.throws(
    () => runAgentWorkerProcess({ ...options, workerPath: process.execPath }),
    /trusted absolute/,
  );
});

test("BYOK strict response schema requires both advertised structured-output controls", async (t) => {
  for (const omitted of ["structured_outputs", "response_format"]) {
    const parameters = [
      "reasoning_effort",
      "tools",
      "structured_outputs",
      "response_format",
    ].filter((parameter) => parameter !== omitted);
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            data: ["a", "b"].map((id) => ({
              id,
              name: id,
              context_length: 1_000_000,
              supported_parameters: parameters,
            })),
          }),
          { status: 200 },
        ),
    );
    await assert.rejects(readSkillProviderCatalog(config(), Date.now() + 1000), /capabilities/);
  }
});

test("inference aliases of publication credentials fail before worker launch without leaking values", (t) => {
  const oldEnv = process.env;
  const root = mkdtempSync(join(tmpdir(), "skill-credential-boundary-"));
  t.after(() => {
    process.env = oldEnv;
    rmSync(root, { recursive: true, force: true });
  });
  let launches = 0;
  t.mock.method(childProcess, "spawnSync", () => {
    launches++;
    throw new Error("Unexpected process launch");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const publicationNames = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "REPO_TOKEN",
    "COMMIT_SWEEPER_TARGET_GH_TOKEN",
    "CLAWSWEEPER_PUBLIC_GH_TOKEN",
    "CLAWSWEEPER_TARGET_GH_TOKEN",
    "CLAWSWEEPER_PROOF_INSPECTION_TOKEN",
    "CLAWSWEEPER_STATE_REPO_TOKEN",
    "BOOTSTRAP_GITHUB_TOKEN",
    "ANOTHER_TARGET_GH_TOKEN",
    "BOOTSTRAP_GITHUB_ENTERPRISE_TOKEN",
    "CLAWSWEEPER_DISPATCH_TOKEN",
    "CLAWSWEEPER_HOSTED_TARGET_METADATA_TOKEN",
    "CLAWSWEEPER_INVENTORY_TOKEN",
    "CLAWSWEEPER_INVENTORY_TOKEN_NEW_ORG",
    "FUTURE_OPERATOR_BINDING",
  ];
  for (const selected of [
    "CLAWSWEEPER_SKILL_TOKEN",
    "CLAWSWEEPER_SKILL_API_KEY",
    "OPENROUTER_API_KEY",
  ] as const) {
    for (const publicationName of publicationNames) {
      process.env = {
        PATH: oldEnv.PATH,
        SystemRoot: oldEnv.SystemRoot,
        [selected]: "fixture-secret-value",
        [publicationName]: " fixture-secret-value ",
      };
      const selectedConfig = config();
      if (selected === "CLAWSWEEPER_SKILL_TOKEN") delete selectedConfig.provider;
      else selectedConfig.provider = { baseUrl: "https://example.invalid/v1", apiKeyEnv: selected };
      assert.throws(
        () =>
          runReviewSkillProcess(
            { selection: { slug: "fixture", config: selectedConfig } } as Parameters<
              typeof runReviewSkillProcess
            >[0],
            root,
          ),
        (error: Error) => {
          assert.equal(
            error.message,
            "Review skill incomplete: inference requires a separate credential from publication.",
          );
          return true;
        },
      );
    }
    assert.doesNotThrow(() =>
      assertSeparateSkillCredential(
        { [selected]: "distinct-inference", GH_TOKEN: "distinct-publication" },
        selected,
      ),
    );
    assert.throws(
      () => assertSeparateSkillCredential({ [selected]: " " }, selected),
      /not configured/,
    );
  }
  assert.equal(launches, 0);
});
