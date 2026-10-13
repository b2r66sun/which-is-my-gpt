import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("list APIs paginate, sort, omit details, and preserve legacy callers", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "wimgpt-list-test-"));
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const result = { map: { id: "candidate", probability: 0.8 }, entropy: 0.5, models: [{ id: "candidate" }], byCutoff: [] };
  const timestamp = (index) => new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  const runs = Array.from({ length: 45 }, (_, index) => ({
    id: `run-${index}`, createdAt: timestamp(index), finishedAt: timestamp(100 - index), status: "completed",
    result, answer: { large: "x".repeat(10000) }, error: "diagnostic", eventsPath: "/private/events.jsonl",
  }));
  const schedules = Array.from({ length: 21 }, (_, index) => ({ id: `schedule-${index}`, name: `Schedule ${index}`, createdAt: timestamp(index), enabled: false, cron: "0 3 * * *" }));
  // Deliberately use an unsorted persisted array so sorting cannot rely on insertion order.
  runs.push({ id: "undated", createdAt: "invalid", status: "failed" });
  writeFileSync(join(stateDir, "state.json"), JSON.stringify({ runs, schedules }));
  const child = spawn(process.execPath, ["server.mjs", "--host", "127.0.0.1", "--port", String(port), "--state-dir", stateDir, "--updates-config", join(stateDir, "missing.env")], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "exit");
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  t.after(async () => { child.kill("SIGTERM"); await closed; rmSync(stateDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) { ready = true; break; } } catch { /* Starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(ready, output);
  const get = async (path) => {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  await t.test("newest first with complete pagination metadata and bounded payloads", async () => {
    const first = await get("/api/runs?page=1&pageSize=20");
    assert.deepEqual([first.page, first.pageSize, first.total, first.totalPages], [1, 20, 46, 3]);
    assert.equal(first.items[0].id, "run-44");
    assert.equal(first.items.at(-1).id, "run-25");
    const second = await get("/api/runs?page=2&pageSize=20");
    assert.equal(second.items[0].id, "run-24");
    assert.equal(new Set([...first.items, ...second.items].map((run) => run.id)).size, 40);
    assert.ok(JSON.stringify(first).length < 10000);
    for (const run of first.items) {
      for (const field of ["answer", "eventsPath", "error"]) assert.ok(!(field in run));
      assert.ok(!("models" in run.result));
    }
  });
  await t.test("out of range pages clamp to the last page and invalid dates sort last", async () => {
    const last = await get("/api/runs?page=999&pageSize=20");
    assert.equal(last.page, 3);
    assert.equal(last.items.length, 6);
    assert.equal(last.items.at(-1).id, "undated");
  });
  await t.test("unpaged API and detail downloads keep their original shape", async () => {
    const legacy = await get("/api/runs?limit=2");
    assert.ok(Array.isArray(legacy));
    assert.equal(legacy.length, 2);
    assert.equal(legacy[0].answer.large.length, 10000);
    assert.equal((await get("/api/runs?limit=1000")).length, 46);
    assert.equal((await get("/api/runs/run-44")).result.models.length, 1);
    assert.ok(Array.isArray(await get("/api/schedules")));
  });
  await t.test("trend paginates all scored runs by finish time and preserves legacy summaries", async () => {
    const trend = await get("/api/runs/trend?limit=20");
    assert.equal(trend.length, 20);
    assert.equal(trend[0].id, "run-0");
    assert.equal(trend.at(-1).id, "run-19");
    assert.ok(!("answer" in trend[0]));
    const first = await get("/api/runs/trend?page=1&pageSize=20");
    assert.deepEqual([first.page, first.pageSize, first.total, first.totalPages], [1, 20, 45, 3]);
    assert.deepEqual(first.items.map((run) => run.id), trend.map((run) => run.id));
    const second = await get("/api/runs/trend?page=2&pageSize=20");
    assert.equal(second.items[0].id, "run-20");
    assert.equal(second.items.at(-1).id, "run-39");
    assert.equal(new Set([...first.items, ...second.items].map((run) => run.id)).size, 40);
    const last = await get("/api/runs/trend?page=999&pageSize=20");
    assert.equal(last.page, 3);
    assert.equal(last.items.length, 5);
    assert.equal(last.items.at(-1).id, "run-44");
    const small = await get("/api/runs/trend?pageSize=10");
    assert.deepEqual([small.page, small.items.length, small.totalPages], [1, 10, 5]);
    assert.ok(!("answer" in first.items[0]));
    assert.ok(!("models" in first.items[0].result));
  });
  await t.test("schedules paginate by creation time and deleting the last row adjusts the page", async () => {
    const first = await get("/api/schedules?page=1&pageSize=10");
    assert.equal(first.items[0].id, "schedule-20");
    assert.equal(first.totalPages, 3);
    assert.equal((await fetch(`${base}/api/schedules/schedule-0`, { method: "DELETE" })).status, 204);
    const last = await get("/api/schedules?page=3&pageSize=10");
    assert.equal(last.page, 2);
    assert.equal(last.items.length, 10);
  });
  await t.test("invalid pagination is rejected rather than returning excessive data", async () => {
    for (const query of ["page=0", "page=-1", "page=abc", "page=1.5", "page=Infinity", "page=9007199254740992", "pageSize=0", "pageSize=101", "pageSize=", "limit=-1"]) {
      for (const route of ["/api/runs", "/api/runs/trend"]) {
        assert.equal((await fetch(`${base}${route}?${query}`)).status, 400, `${route}?${query}`);
      }
    }
  });
  await t.test("update status is passive and sensitive dotfiles are not served", async () => {
    const status = await get("/api/updates");
    assert.equal(typeof status.configured, "boolean");
    for (const path of ["/.git/config", "/.wimgpt/state.json", "/config/updates/.env", "/config/updates/.env.example"]) {
      assert.equal((await fetch(`${base}${path}`)).status, 403, path);
    }
    assert.equal((await fetch(`${base}/api/updates/apply`, { method: "POST", headers: { origin: "https://example.com", "content-type": "application/json" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${base}/api/updates/apply`, { method: "POST" })).status, 415);
  });
});
