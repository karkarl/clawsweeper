import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { stageLocalPackage } from "../scripts/stage-local-package.mjs";

const sourceRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));

function tree(root: string): Array<{ path: string; sha256: string }> {
  const result: Array<{ path: string; sha256: string }> = [];
  function visit(dir: string): void {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) visit(path);
      else {
        assert.ok(lstatSync(path).isFile(), `unexpected non-file in artifact: ${path}`);
        result.push({
          path: relative(root, path).replaceAll("\\", "/"),
          sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        });
      }
    }
  }
  visit(root);
  return result;
}

test(
  "packed local reviewer installs and runs outside the source checkout",
  { timeout: 240_000 },
  async (t) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "local-package-install-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const stage = join(root, "stage");
    const prefix = join(root, "install");
    const cwd = join(root, "target with spaces 雪");
    mkdirSync(cwd);
    const emptyConfig = join(root, "empty.npmrc");
    const globalConfig = join(root, "global.npmrc");
    writeFileSync(emptyConfig, "");
    writeFileSync(globalConfig, "");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NPM_CONFIG_USERCONFIG: emptyConfig,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: join(root, "npm-cache"),
    };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    // This is a separate test runner, not an internal Node test worker.
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    const run = (command: string, args: string[], options = {}) => {
      const result = spawnSync(command, args, {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 220_000,
        maxBuffer: 8 * 1024 * 1024,
        ...options,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr + result.stdout);
      return result.stdout;
    };
    const manifest = await stageLocalPackage(stage);
    const staged = tree(stage);
    const sourceBefore = staged.map(({ path }) => {
      const source = join(sourceRoot, path === "README.md" ? "docs/local-package.md" : path);
      return { source, bytes: readFileSync(source) };
    });
    assert.deepEqual(
      staged,
      manifest.map(({ path, sha256 }) => ({ path, sha256 })),
    );
    const metadata = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
    assert.equal(metadata.private, true);
    assert.equal(metadata.scripts, undefined);
    assert.equal(metadata.devDependencies, undefined);
    assert.equal(
      metadata.dependencies,
      undefined,
      "the current local runtime uses only Node builtins",
    );
    assert.equal(metadata.bin["clawsweeper-review"], "dist/clawsweeper-local.js");
    assert.ok(staged.some(({ path }) => path === "dist/repair/contained-command-worker.js"));
    assert.ok(!staged.some(({ path }) => /close-coverage|app-server|action-ledger/.test(path)));

    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const npmOptions = { shell: process.platform === "win32" };
    const [packed] = JSON.parse(
      run(npm, ["pack", stage, "--ignore-scripts", "--json", "--offline"], npmOptions),
    );
    assert.deepEqual(
      packed.files.map(({ path }: { path: string }) => path).sort(),
      staged.map(({ path }) => path),
    );
    const tarball = join(root, packed.filename);
    const tarballHash = createHash("sha256").update(readFileSync(tarball)).digest("hex");
    run(
      npm,
      [
        "install",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--omit=dev",
        "--offline",
        "--no-audit",
        "--no-fund",
        tarball,
      ],
      npmOptions,
    );
    const installed = join(prefix, "node_modules", "@openclaw", "clawsweeper");
    assert.deepEqual(tree(installed), staged);
    assert.deepEqual(
      readdirSync(join(prefix, "node_modules")).filter((name) => !name.startsWith(".")),
      ["@openclaw"],
    );
    const bin = join(
      prefix,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "clawsweeper-review.cmd" : "clawsweeper-review",
    );

    // Only installed processes activate this hook. The parity suite's one
    // explicit test preload is allowed; product imports stay inside the package.
    const guard = join(root, "installed-only.mjs");
    writeFileSync(
      guard,
      `import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
if (process.argv[1] && realpathSync(process.argv[1]).startsWith(${JSON.stringify(installed + sep)})) {
  registerHooks({ resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result.url.startsWith("file:") && result.url !== ${JSON.stringify(new URL("./local-entry-import-guard.mjs", import.meta.url).href)} && !fileURLToPath(result.url).startsWith(${JSON.stringify(installed + sep)})) {
      throw new Error("Installed reviewer imported outside its package");
    }
    return result;
  } });
}
`,
    );
    const installedEnv = { ...env, NODE_OPTIONS: `--import=${pathToFileURL(guard).href}` };
    run("git", ["init", "-q", cwd]);
    const targetBefore = tree(cwd);
    for (const flag of ["--help", "--version"]) {
      const stdout = run(bin, [flag], { cwd, env: installedEnv, ...npmOptions });
      assert.match(
        stdout,
        flag === "--help"
          ? /Local ClawSweeper/
          : new RegExp(`^${metadata.version.replaceAll(".", "\\.")}`),
      );
    }
    for (const args of [["apply-decisions"], ["--diagnostics"]]) {
      const result = spawnSync(bin, args, {
        cwd,
        env: installedEnv,
        encoding: "utf8",
        timeout: 10_000,
        ...npmOptions,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Use --help for usage/);
    }
    assert.deepEqual(tree(cwd), targetBefore);

    const parity = run(
      process.execPath,
      [
        "--test",
        "--test-reporter=tap",
        fileURLToPath(new URL("./local-range-review.test.ts", import.meta.url)),
      ],
      {
        cwd,
        env: {
          ...installedEnv,
          CLAWSWEEPER_TEST_LOCAL_ENTRY_PATH:
            process.platform === "win32" ? join(installed, "dist/clawsweeper-local.js") : bin,
        },
      },
    );
    const skipped = process.platform === "win32" ? 3 : 0;
    for (const [label, expected] of Object.entries({
      tests: 18,
      pass: 18 - skipped,
      fail: 0,
      cancelled: 0,
      skipped,
      todo: 0,
    })) {
      assert.match(parity, new RegExp(`^# ${label} ${expected}$`, "m"));
    }
    assert.deepEqual(tree(installed), staged, "review must not change the installed package");
    assert.deepEqual(tree(stage), staged, "review must not change staged inputs");
    assert.deepEqual(tree(cwd), targetBefore);
    for (const { source, bytes } of sourceBefore)
      assert.deepEqual(readFileSync(source), bytes, "review must not change source inputs");
    t.diagnostic(
      JSON.stringify({
        files: staged.length,
        unpackedBytes: packed.unpackedSize,
        tarballBytes: packed.size,
        tarballSha256: tarballHash,
        parity: parity.match(/# tests \d+/)?.[0],
      }),
    );
  },
);
