import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execute = promisify(execFile);

export function loadUpdateConfig(path) {
  if (!existsSync(path)) return null;
  const values = {};
  const keys = ["WIMGPT_UPDATE_REPOSITORY_URL", "WIMGPT_UPDATE_BRANCH", "WIMGPT_UPDATE_CHECK_INTERVAL_SECONDS", "WIMGPT_UPDATE_COMMAND_TIMEOUT_SECONDS", "WIMGPT_UPDATE_PM2_NAME"];
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match || !keys.includes(match[1]) || Object.hasOwn(values, match[1])) throw new Error("Invalid or duplicate update configuration variable");
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  for (const key of keys) if (!values[key]) throw new Error(`${key} is required in the update .env file`);
  const repositoryUrl = values.WIMGPT_UPDATE_REPOSITORY_URL;
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repositoryUrl)) throw new Error("Update repository must be a public GitHub HTTPS URL without credentials");
  const integer = (key, min, max) => {
    const value = Number(values[key]);
    if (!/^\d+$/.test(values[key]) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
    return value;
  };
  return {
    repositoryUrl,
    branch: values.WIMGPT_UPDATE_BRANCH,
    intervalMs: integer("WIMGPT_UPDATE_CHECK_INTERVAL_SECONDS", 60, 86400) * 1000,
    timeoutMs: integer("WIMGPT_UPDATE_COMMAND_TIMEOUT_SECONDS", 10, 600) * 1000,
    pm2Name: values.WIMGPT_UPDATE_PM2_NAME,
  };
}

export function createUpdateManager({ root, stateDir, configPath, config: suppliedConfig, isIdle, verifyRestart }) {
  let config = suppliedConfig;
  let configError = null;
  if (config === undefined) {
    try { config = loadUpdateConfig(configPath); }
    catch (error) { configError = error.message; config = null; }
  }
  const receiptPath = join(stateDir, "update-receipt.json");
  let lastApplied = null;
  try { lastApplied = JSON.parse(readFileSync(receiptPath, "utf8")); } catch { /* No successful update yet. */ }
  let status = {
    configured: Boolean(config), source: config ? { url: config.repositoryUrl.replace(/\.git$/, ""), branch: config.branch } : null,
    currentVersion: null, remoteVersion: null, lastCheckedAt: null, updateAvailable: false,
    relation: "unchecked", dirty: false, restartSupported: false, error: configError, lastApplied,
  };
  let busy = false;
  let checking = null;
  let timer = null;
  const command = async (file, args, cwd = root) => (await execute(file, args, {
    cwd, timeout: config.timeoutMs, maxBuffer: 2_000_000,
  })).stdout.trim();
  const git = (...args) => command("git", args);
  const isAncestor = async (a, b) => {
    try { await git("merge-base", "--is-ancestor", a, b); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  };
  const relationTo = async (current, target) => {
    if (current === target) return "current";
    try { await git("cat-file", "-e", `${target}^{commit}`); }
    catch (error) { if (error.code === 1 || error.code === 128) return "unknown"; throw error; }
    if (await isAncestor(target, current)) return "ahead";
    if (await isAncestor(current, target)) return "behind";
    return "diverged";
  };
  async function inspect() {
    await git("check-ref-format", "--branch", config.branch);
    const current = await git("rev-parse", "HEAD");
    status.currentVersion = current;
    const remote = await git("ls-remote", "--exit-code", config.repositoryUrl, `refs/heads/${config.branch}`);
    const target = remote.split(/\s+/)[0];
    if (!/^[0-9a-f]{40,64}$/.test(target)) throw new Error("The update branch did not return a valid commit");
    const relation = await relationTo(current, target);
    status = {
      ...status, currentVersion: current, remoteVersion: target, relation,
      updateAvailable: ["behind", "diverged", "unknown"].includes(relation),
      dirty: Boolean(await git("status", "--porcelain")),
      restartSupported: await verifyRestart(config.pm2Name),
      lastCheckedAt: new Date().toISOString(), error: null,
    };
    return status;
  }
  async function check() {
    if (!config || busy) return getStatus();
    if (!checking) {
      checking = inspect().catch((error) => {
        status.error = error.message.slice(0, 800);
        status.lastCheckedAt = new Date().toISOString();
      }).finally(() => { checking = null; });
    }
    await checking;
    return getStatus();
  }
  const blocked = (message) => Object.assign(new Error(message), { statusCode: 409 });
  async function apply() {
    if (!config) throw blocked(status.error || "Updates are not configured for this deployment");
    if (busy) throw blocked("An update is already in progress");
    busy = true;
    let stage;
    try {
      if (checking) await checking;
      const inspected = await inspect();
      if (!isIdle()) throw blocked("Wait for the active evaluation to finish before updating");
      if (inspected.dirty) throw blocked("Commit or move local changes before updating");
      if (!inspected.restartSupported) throw blocked("This server must run under the configured PM2 process with autorestart enabled");
      const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
      if (!branch) throw blocked("Cannot update a detached checkout");
      if (["current", "ahead"].includes(inspected.relation)) throw blocked("The current version already contains this upstream version");
      const original = inspected.currentVersion;
      const target = inspected.remoteVersion;
      await git("fetch", "--no-tags", config.repositoryUrl, `refs/heads/${config.branch}`);
      if (!await isAncestor(original, target)) {
        status.relation = "diverged";
        throw blocked("Upstream and this checkout require a merge; automatic replacement would discard local features");
      }
      stage = mkdtempSync(join(tmpdir(), "wimgpt-update-"));
      const archive = join(stage, "version.tar");
      await git("archive", "--format=tar", "-o", archive, target);
      await command("tar", ["-xf", archive], stage);
      rmSync(archive);
      const oldPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      const newPackage = JSON.parse(readFileSync(join(stage, "package.json"), "utf8"));
      if (!existsSync(join(stage, "server.mjs")) || !existsSync(join(stage, "lib", "updates.mjs")) || !newPackage.scripts?.test) {
        throw blocked("Upstream does not yet include the dashboard and updater; merge these features upstream first");
      }
      for (const key of ["dependencies", "devDependencies", "optionalDependencies", "engines"]) {
        if (JSON.stringify(oldPackage[key]) !== JSON.stringify(newPackage[key]) || (Object.keys(newPackage[key] || {}).length > 0 && key !== "engines")) {
          throw blocked("Dependency or runtime changes require a manual deployment");
        }
      }
      await command(process.execPath, ["--check", "server.mjs"], stage);
      await command("npm", ["test"], stage);
      if (!isIdle() || await git("status", "--porcelain") || await git("rev-parse", "HEAD") !== original || await git("symbolic-ref", "--short", "HEAD") !== branch) {
        throw blocked("Local state changed during validation; update was cancelled");
      }
      if (!await verifyRestart(config.pm2Name)) throw blocked("PM2 ownership changed during validation; update was cancelled");
      const backupRef = `refs/wimgpt-update-backups/${Date.now()}-${original.slice(0, 12)}`;
      await git("update-ref", backupRef, original, "0".repeat(original.length));
      const receipt = { previousVersion: original, version: target, backupRef, appliedAt: new Date().toISOString() };
      const receiptTmp = `${receiptPath}.tmp`;
      // Fail before changing the checkout if the state directory cannot be written.
      writeFileSync(receiptTmp, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
      await git("merge", "--ff-only", "--no-edit", target);
      status = { ...status, currentVersion: target, relation: "current", updateAvailable: false,
        lastApplied: receipt };
      try { renameSync(receiptTmp, receiptPath); }
      catch (error) {
        // Code has already changed: always restart even if promoting the receipt fails.
        status.error = `Version installed; update receipt remains in its temporary file: ${error.code}`;
      }
      // Stay busy until PM2 restarts this process so queued evaluations cannot start in the gap.
      return { ...getStatus(), restarting: true };
    } catch (error) {
      busy = false;
      status.error = error.message.slice(0, 800);
      throw error;
    } finally {
      if (stage) {
        try { rmSync(stage, { recursive: true, force: true }); }
        catch (error) { console.error("Update temporary directory cleanup failed:", error.code); }
      }
    }
  }
  function getStatus() { return { ...status, busy, checking: Boolean(checking) }; }
  return {
    get busy() { return busy; }, getStatus, check, apply,
    start() {
      if (!config || timer) return;
      void check();
      timer = setInterval(() => { void check(); }, config.intervalMs);
      timer.unref();
    },
    stop() { clearInterval(timer); timer = null; },
  };
}
