import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUpdateManager, loadUpdateConfig } from "../lib/updates.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "wimgpt-update-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const remote = join(base, "remote");
  const root = join(base, "checkout");
  const stateDir = join(base, "state");
  mkdirSync(remote); mkdirSync(stateDir);
  git(remote, "init");
  git(remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git(remote, "config", "user.name", "Updater test");
  git(remote, "config", "user.email", "updater@example.invalid");
  writeFileSync(join(remote, "server.mjs"), "// isolated candidate server\n");
  mkdirSync(join(remote, "lib"));
  writeFileSync(join(remote, "lib", "updates.mjs"), "// isolated candidate updater\n");
  writeFileSync(join(remote, "package.json"), JSON.stringify({ scripts: { test: "node --check server.mjs" } }));
  git(remote, "add", "."); git(remote, "commit", "-m", "Initial version");
  git(base, "clone", remote, root);
  git(root, "config", "user.name", "Updater test"); git(root, "config", "user.email", "updater@example.invalid");
  const config = { repositoryUrl: remote, branch: "main", intervalMs: 900000, timeoutMs: 10000, pm2Name: "isolated" };
  const manager = (overrides = {}) => createUpdateManager({ root, stateDir, config, isIdle: () => true, verifyRestart: async () => true, ...overrides });
  const release = (content = "new release") => {
    writeFileSync(join(remote, "release.txt"), content);
    git(remote, "add", "."); git(remote, "commit", "-m", "New release");
    return git(remote, "rev-parse", "HEAD");
  };
  return { base, root, remote, stateDir, config, manager, release };
}

test("checks do not fetch or restart; apply validates and fast-forwards with a recovery ref", async (t) => {
  const f = fixture(t);
  const updater = f.manager();
  const original = git(f.root, "rev-parse", "HEAD");
  assert.equal((await updater.check()).relation, "current");
  const target = f.release();
  const available = await updater.check();
  assert.equal(available.updateAvailable, true);
  assert.equal(available.relation, "unknown");
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
  assert.equal(existsSync(join(f.root, ".git", "FETCH_HEAD")), false);
  const applied = await updater.apply();
  assert.equal(applied.restarting, true);
  assert.equal(updater.busy, true);
  assert.equal(git(f.root, "rev-parse", "HEAD"), target);
  assert.equal(git(f.root, "rev-parse", applied.lastApplied.backupRef), original);
  assert.equal(JSON.parse(readFileSync(join(f.stateDir, "update-receipt.json"))).version, target);
  assert.equal(f.manager().getStatus().lastApplied.version, target);
});

test("dirty checkouts, active evaluations and unowned PM2 processes cannot update", async (t) => {
  const f = fixture(t);
  f.release();
  const original = git(f.root, "rev-parse", "HEAD");
  await assert.rejects(f.manager({ isIdle: () => false }).apply(), /active evaluation/);
  await assert.rejects(f.manager({ verifyRestart: async () => false }).apply(), /PM2/);
  writeFileSync(join(f.root, "personal.txt"), "preserve me");
  const updater = f.manager();
  await assert.rejects(updater.apply(), /local changes/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
  assert.equal(readFileSync(join(f.root, "personal.txt"), "utf8"), "preserve me");
  assert.equal(updater.busy, false);
});

test("receipt write errors block before merging; promotion errors still request a restart", async (t) => {
  const f = fixture(t);
  const original = git(f.root, "rev-parse", "HEAD");
  const target = f.release();
  rmSync(f.stateDir, { recursive: true });
  writeFileSync(f.stateDir, "not a directory");
  const unwritable = f.manager();
  await assert.rejects(unwritable.apply(), /ENOTDIR/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
  assert.equal(unwritable.busy, false);
  rmSync(f.stateDir);
  mkdirSync(f.stateDir);
  mkdirSync(join(f.stateDir, "update-receipt.json"));
  const updater = f.manager();
  const installed = await updater.apply();
  assert.equal(git(f.root, "rev-parse", "HEAD"), target);
  assert.equal(installed.restarting, true);
  assert.equal(updater.busy, true);
  assert.match(installed.error, /receipt remains/);
  assert.equal(JSON.parse(readFileSync(join(f.stateDir, "update-receipt.json.tmp"))).version, target);
});

test("divergent upstream is reported and local features are preserved", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "feature.txt"), "local feature");
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Local feature");
  const original = git(f.root, "rev-parse", "HEAD");
  const target = f.release();
  git(f.root, "fetch", "origin", "main");
  const updater = f.manager();
  assert.equal((await updater.check()).relation, "diverged");
  await assert.rejects(updater.apply(), /require a merge/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
  assert.notEqual(original, target);
  assert.equal(readFileSync(join(f.root, "feature.txt"), "utf8"), "local feature");
});

test("failed candidate tests never change the running checkout", async (t) => {
  const f = fixture(t);
  const original = git(f.root, "rev-parse", "HEAD");
  writeFileSync(join(f.remote, "server.mjs"), "this is invalid JavaScript !!");
  f.release();
  const updater = f.manager();
  await assert.rejects(updater.apply(), /Command failed/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
  assert.equal(updater.busy, false);
});

test("dependency changes and candidates without the dashboard require manual integration", async (t) => {
  const f = fixture(t);
  const original = git(f.root, "rev-parse", "HEAD");
  writeFileSync(join(f.remote, "package.json"), JSON.stringify({ scripts: { test: "node --check server.mjs" }, dependencies: { example: "1.0.0" } }));
  f.release();
  await assert.rejects(f.manager().apply(), /manual deployment/);
  rmSync(join(f.remote, "server.mjs"));
  f.release("another release");
  await assert.rejects(f.manager().apply(), /does not yet include/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
});

test("upstream already contained in local features does not show a false update", async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, "feature.txt"), "local feature");
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Local feature");
  const status = await f.manager().check();
  assert.equal(status.relation, "ahead");
  assert.equal(status.updateAvailable, false);
});

test("update env inventory is complete, required and validated without code defaults", (t) => {
  const base = mkdtempSync(join(tmpdir(), "wimgpt-env-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const path = join(base, ".env");
  assert.equal(loadUpdateConfig(path), null);
  const template = readFileSync(new URL("../config/updates/.env.example", import.meta.url), "utf8");
  writeFileSync(path, template);
  assert.throws(() => loadUpdateConfig(path), /required/);
  const complete = template.replace("WIMGPT_UPDATE_REPOSITORY_URL=", "WIMGPT_UPDATE_REPOSITORY_URL=https://github.com/example/repo.git").replace("WIMGPT_UPDATE_PM2_NAME=", "WIMGPT_UPDATE_PM2_NAME=isolated");
  writeFileSync(path, complete);
  assert.equal(loadUpdateConfig(path).intervalMs, 900000);
  writeFileSync(path, complete.replace("=900", "="));
  assert.throws(() => loadUpdateConfig(path), /required/);
  writeFileSync(path, complete.replace("=900", "=1"));
  assert.throws(() => loadUpdateConfig(path), /between/);
  writeFileSync(path, `${complete}\nUNDECLARED=value\n`);
  assert.throws(() => loadUpdateConfig(path), /Invalid/);
  writeFileSync(path, `${complete}\nWIMGPT_UPDATE_BRANCH=main\n`);
  assert.throws(() => loadUpdateConfig(path), /duplicate/);
});
