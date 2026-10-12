#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const { infer, parseReply } = require(join(ROOT, "app.js"));

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_STATE_DIR = join(ROOT, ".wimgpt");
const MAX_RUNS = 200;
const TICK_MS = 15_000;
const MODEL_CACHE_MS = 5 * 60_000;

const options = parseArgs(process.argv.slice(2));
const stateDir = resolve(options.stateDir);
const runsDir = join(stateDir, "runs");
const statePath = join(stateDir, "state.json");
mkdirSync(runsDir, { recursive: true });

const questionsPath = join(ROOT, "questions.json");
const modelsPath = join(ROOT, "models.json");
const schemaPath = join(ROOT, "codex-answer.schema.json");

let questionBank = loadQuestionBank();
let state = loadState();
const active = new Map();
const queue = [];
let modelCache = { fetchedAt: null, models: [], error: null };

for (const run of state.runs) {
  if (run.status === "running") {
    run.status = "interrupted";
    run.finishedAt = new Date().toISOString();
    run.error = "Server restarted while this run was active";
  }
  if (run.status === "queued") queue.push(run.id);
}
saveState();

function usage() {
  return `Usage: node server.mjs [options]

Options:
  --host HOST          Listen address (default: ${DEFAULT_HOST})
  --port PORT          Listen port (default: ${DEFAULT_PORT})
  --state-dir PATH     Persistent state directory (default: ./.wimgpt)
  --codex-bin PATH     Codex executable (default: codex)
  --help               Show this help
`;
}

function parseArgs(argv) {
  const result = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    stateDir: DEFAULT_STATE_DIR,
    codexBin: "codex",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (arg === "--host") result.host = next;
    else if (arg === "--port") result.port = Number(next);
    else if (arg === "--state-dir") result.stateDir = next;
    else if (arg === "--codex-bin") result.codexBin = next;
    else throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    i += 1;
  }
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return result;
}

function loadQuestionBank() {
  const bank = JSON.parse(readFileSync(questionsPath, "utf8"));
  const modelsFile = JSON.parse(readFileSync(modelsPath, "utf8"));
  if (!Array.isArray(bank.questions) || !Array.isArray(modelsFile.models)) {
    throw new Error("questions.json and models.json must contain arrays");
  }
  return {
    questions: bank.questions.map((q) => ({
      id: q.id,
      date: q.date,
      question: q.question,
      keywords: q.keywords || [],
      canary: Boolean(q.canary),
      p: q.p || 0.9,
      eps: q.eps || 0.05,
      truth: q.truth || "",
    })),
    models: modelsFile.models.map((m) => ({
      id: m.id,
      cutoff: m.cutoff,
      prior: m.prior || 0,
    })),
    version: createHash("sha256")
      .update(readFileSync(questionsPath))
      .update(readFileSync(modelsPath))
      .digest("hex")
      .slice(0, 12),
  };
}

function loadState() {
  if (!existsSync(statePath)) return { schedules: [], runs: [], wecom: defaultWecomConfig() };
  try {
    const loaded = JSON.parse(readFileSync(statePath, "utf8"));
    return {
      schedules: (Array.isArray(loaded.schedules) ? loaded.schedules : []).map((schedule) => ({
        ...schedule,
        models: Array.isArray(schedule.models)
          ? schedule.models
          : (schedule.model ? [schedule.model] : []),
      })),
      runs: (Array.isArray(loaded.runs) ? loaded.runs : []).map((run) => ({
        ...run,
        models: Array.isArray(run.models) ? run.models : (run.model ? [run.model] : []),
      })),
      wecom: { ...defaultWecomConfig(), ...(loaded.wecom || {}) },
    };
  } catch (error) {
    throw new Error(`Cannot read ${statePath}: ${error.message}`);
  }
}

function defaultWecomConfig() {
  return {
    enabled: false,
    webhookUrl: "",
    events: { completed: true, failed: true, cancelled: true },
    mentionAll: false,
    updatedAt: null,
    lastSentAt: null,
    lastError: null,
  };
}

function saveState() {
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${statePath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  chmodSync(tmp, 0o600);
  renameSync(tmp, statePath);
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, status, value, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(value),
  });
  res.end(value);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("Request body too large");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body must be JSON");
  }
}

function nowIso() {
  return new Date().toISOString();
}

function cronFieldMatches(value, field, min, max) {
  return field.split(",").some((part) => {
    const [base, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let start = min;
    let end = max;
    if (base !== "*") {
      if (base.includes("-")) {
        const [a, b] = base.split("-").map(Number);
        if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
        start = a;
        end = b;
      } else {
        start = Number(base);
        end = start;
      }
    }
    if (start < min || end > max || start > end) return false;
    return value >= start && value <= end && (value - start) % step === 0;
  });
}

function cronMatches(date, expression) {
  const fields = String(expression || "").trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, weekday] = fields;
  const dayMatches = cronFieldMatches(date.getDate(), day, 1, 31);
  const weekdayMatches = cronFieldMatches(date.getDay(), weekday, 0, 6);
  const dayOfMonthWildcard = day === "*";
  const weekdayWildcard = weekday === "*";
  const calendarDayMatches = dayOfMonthWildcard && weekdayWildcard
    ? true
    : dayOfMonthWildcard
      ? weekdayMatches
      : weekdayWildcard
        ? dayMatches
        : dayMatches || weekdayMatches;
  return cronFieldMatches(date.getMinutes(), minute, 0, 59)
    && cronFieldMatches(date.getHours(), hour, 0, 23)
    && cronFieldMatches(date.getMonth() + 1, month, 1, 12)
    && calendarDayMatches;
}

function normalizeCodexModels(data) {
  return (Array.isArray(data) ? data : []).map((model) => ({
    id: model.id || model.model,
    model: model.model || model.id,
    displayName: model.displayName || model.id || model.model,
    description: model.description || "",
    hidden: Boolean(model.hidden),
    isDefault: Boolean(model.isDefault),
    supportedReasoningEfforts: model.supportedReasoningEfforts || [],
    defaultReasoningEffort: model.defaultReasoningEffort || null,
  })).filter((model) => model.id);
}

function fetchCodexModels(force = false) {
  if (!force && modelCache.fetchedAt && Date.now() - modelCache.fetchedAt < MODEL_CACHE_MS) {
    return Promise.resolve(modelCache);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(options.codexBin, ["app-server", "--listen", "stdio://"], {
      cwd: ROOT,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    let stderr = "";
    const timer = setTimeout(() => finish(new Error("Codex model discovery timed out")), 15_000);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const finish = (error, models = []) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGTERM");
      if (error) {
        modelCache = { fetchedAt: Date.now(), models: [], error: error.message };
        reject(error);
      } else {
        modelCache = { fetchedAt: Date.now(), models, error: null };
        resolve(modelCache);
      }
    };
    const handle = (message) => {
      if (message.id === 1 && message.error) {
        finish(new Error(message.error.message || "Codex initialization failed"));
      } else if (message.id === 1) {
        send({ method: "initialized", params: {} });
        send({ id: 2, method: "model/list", params: { cursor: null, includeHidden: false, limit: 100 } });
      } else if (message.id === 2) {
        finish(null, normalizeCodexModels(message.result?.data));
      }
    };
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { handle(JSON.parse(line)); } catch { /* Ignore non-JSON diagnostics. */ }
      }
    });
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex app-server exited with status ${code}`));
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "wimgpt-dashboard", title: "wimgpt dashboard", version: "0.1.0" },
        capabilities: {},
      },
    });
  });
}

function publicWecomConfig() {
  const config = state.wecom || defaultWecomConfig();
  const masked = config.webhookUrl
    ? config.webhookUrl.replace(/(key=)[^&]+/i, "$1***")
    : "";
  return {
    enabled: Boolean(config.enabled),
    configured: Boolean(config.webhookUrl),
    webhookUrlMasked: masked,
    events: config.events,
    mentionAll: Boolean(config.mentionAll),
    updatedAt: config.updatedAt || null,
    lastSentAt: config.lastSentAt || null,
    lastError: config.lastError || null,
  };
}

function validateWebhookUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("WeCom callback URL must use http or https");
  return parsed.toString();
}

async function postWecom(content, mentionAll = false) {
  const config = state.wecom || defaultWecomConfig();
  if (!config.webhookUrl) throw new Error("WeCom callback URL is not configured");
  const response = await fetch(config.webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msgtype: "markdown",
      markdown: { content, mentioned_list: mentionAll ? ["@all"] : [] },
    }),
  });
  const body = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* keep text for diagnostics */ }
  if (!response.ok) throw new Error(`WeCom HTTP ${response.status}: ${body.slice(0, 500)}`);
  if (parsed && parsed.errcode && parsed.errcode !== 0) {
    throw new Error(`WeCom ${parsed.errcode}: ${parsed.errmsg || body.slice(0, 500)}`);
  }
  return parsed || body;
}

async function notifyWecom(run) {
  const config = state.wecom || defaultWecomConfig();
  if (!config.enabled || !config.webhookUrl || !config.events?.[run.status]) return;
  const result = run.result;
  const lines = [
    `### wimgpt Codex 测试${run.status === "completed" ? "完成" : run.status === "failed" ? "失败" : "已取消"}`,
    `- 运行：${run.id.slice(0, 8)}`,
    `- 模型：${run.model || "Codex 默认模型"}`,
    `- 状态：${run.status}`,
  ];
  if (result) {
    lines.push(`- MAP：${result.map.id} (${(result.map.probability * 100).toFixed(1)}%)`);
    lines.push(`- Entropy：${result.entropy.toFixed(3)}`);
    lines.push(`- Canary：${result.canaryHits}/${result.canaryTotal}`);
    lines.push(`- 未回答：${result.unanswered}`);
  }
  if (run.error) lines.push(`- 错误：${run.error.slice(0, 800)}`);
  try {
    await postWecom(lines.join("\n"), config.mentionAll);
    config.lastSentAt = nowIso();
    config.lastError = null;
  } catch (error) {
    config.lastError = error.message;
  }
  state.wecom = config;
  saveState();
}

function validateCron(expression) {
  const fields = String(expression || "").trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron must have five fields: minute hour day month weekday");
  if (!fields.every((field) => /^[0-9*,/\-]+$/.test(field))) {
    throw new Error("Cron contains unsupported characters");
  }
  return fields.join(" ");
}

function publicRun(run) {
  return {
    ...run,
    answer: run.answer || undefined,
    eventsPath: run.eventsPath ? relative(ROOT, run.eventsPath) : undefined,
  };
}

function findRun(id) {
  return state.runs.find((run) => run.id === id);
}

function findSchedule(id) {
  return state.schedules.find((schedule) => schedule.id === id);
}

function scoreAnswer(answer) {
  questionBank = loadQuestionBank();
  const parsed = parseReply(JSON.stringify(answer)).parsed;
  const answers = questionBank.questions.map((question, index) => {
    const parsedAnswer = parsed[index + 1];
    if (!parsedAnswer) return null;
    return parsedAnswer.knows === 0 || parsedAnswer.knows === 1 ? parsedAnswer.knows : null;
  });
  const result = infer(questionBank.models, questionBank.questions, answers);
  return {
    map: {
      id: result.evidences[0].model.id,
      probability: result.evidences[0].post,
    },
    entropy: result.entropy,
    maxEntropy: result.maxEntropy,
    canaryHits: result.canaryHits,
    canaryTotal: result.canaryTotal,
    unanswered: result.unanswered,
    models: result.evidences.map((entry) => ({
      id: entry.model.id,
      cutoff: entry.model.cutoff,
      probability: entry.post,
      inWindowKnown: entry.kb,
      inWindowTotal: entry.nb,
      postCutoffKnown: entry.ga,
      postCutoffTotal: entry.na,
    })),
    byCutoff: result.byCutoff,
  };
}

function normalizeRequestedModels(value) {
  if (value === undefined || value === null || value === "") return [];
  const values = Array.isArray(value) ? value : [value];
  if (!values.every((model) => typeof model === "string")) {
    throw new Error("models must be an array of strings");
  }
  return [...new Set(values.map((model) => model.trim()).filter(Boolean))].slice(0, 32);
}

function enqueueRun({ scheduleId = null, model = null, models = [], start = true } = {}) {
  const selectedModels = Array.isArray(models) ? models.filter(Boolean) : [];
  const selectedModel = model || selectedModels[0] || null;
  const run = {
    id: randomUUID(),
    scheduleId,
    batchId: randomUUID(),
    model: selectedModel,
    models: selectedModels.length ? selectedModels : (selectedModel ? [selectedModel] : []),
    questionBankVersion: questionBank.version,
    status: "queued",
    phase: "queued",
    progress: 0,
    createdAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    answer: null,
    result: null,
    error: null,
    eventsPath: null,
  };
  state.runs.unshift(run);
  state.runs = state.runs.slice(0, MAX_RUNS);
  queue.push(run.id);
  saveState();
  if (start) pumpQueue();
  return run;
}

function enqueueRuns({ scheduleId = null, models = [] } = {}) {
  const selectedModels = normalizeRequestedModels(models);
  const batchId = randomUUID();
  const runs = (selectedModels.length ? selectedModels : [null]).map((model) => {
    const run = enqueueRun({ scheduleId, model, start: false });
    run.batchId = batchId;
    run.models = selectedModels;
    return run;
  });
  saveState();
  pumpQueue();
  return runs;
}

function publicBatch(runs) {
  return {
    batchId: runs[0]?.batchId || null,
    runs: runs.map(publicRun),
  };
}

function runChild(run) {
  const runDir = join(runsDir, run.id);
  mkdirSync(runDir, { recursive: true });
  const answerPath = join(runDir, "answer.json");
  const eventsPath = join(runDir, "events.jsonl");
  run.status = "running";
  run.phase = "waiting for Codex";
  run.progress = 15;
  run.startedAt = nowIso();
  run.eventsPath = eventsPath;
  saveState();

  const args = [
    join(ROOT, "scripts/run-codex-eval.mjs"),
    "--codex-bin", options.codexBin,
    "--output", answerPath,
    "--events", eventsPath,
  ];
  if (run.model) args.push("--model", run.model);
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  active.set(run.id, child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  child.on("error", (error) => finishChild(run, 1, stdout, `${stderr}\n${error.message}`));
  child.on("close", (code, signal) => finishChild(run, code ?? 1, stdout, `${stderr}\n${signal || ""}`));
}

function finishChild(run, code, stdout, stderr) {
  if (!active.has(run.id)) return;
  active.delete(run.id);
  if (run.cancelRequested) {
    run.status = "cancelled";
    run.phase = "cancelled";
    run.progress = 100;
    run.error = "Cancelled by user";
  } else if (code === 0) {
    try {
      const answer = JSON.parse(readFileSync(join(runsDir, run.id, "answer.json"), "utf8"));
      run.answer = answer;
      run.result = scoreAnswer(answer);
      run.usage = readUsage(join(runsDir, run.id, "events.jsonl"));
      run.status = "completed";
      run.phase = "completed";
      run.progress = 100;
    } catch (error) {
      run.status = "failed";
      run.phase = "scoring failed";
      run.error = error.message;
    }
  } else {
    run.status = "failed";
    run.phase = "Codex failed";
    run.error = (stderr || stdout || `Codex exited with status ${code}`).trim().slice(-8_000);
  }
  run.finishedAt = nowIso();
  saveState();
  void notifyWecom(run);
  pumpQueue();
}

function readUsage(eventsPath) {
  if (!existsSync(eventsPath)) return null;
  let usage = null;
  for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch {
      // Ignore non-JSON diagnostics in the event file.
    }
  }
  return usage;
}

function pumpQueue() {
  if (active.size > 0) return;
  while (queue.length) {
    const id = queue.shift();
    const run = findRun(id);
    if (!run || run.status !== "queued") continue;
    runChild(run);
    return;
  }
}

function cancelRun(id) {
  const run = findRun(id);
  if (!run) throw new Error("Run not found");
  if (run.status === "queued") {
    run.status = "cancelled";
    run.phase = "cancelled";
    run.progress = 100;
    run.finishedAt = nowIso();
    saveState();
    void notifyWecom(run);
    return run;
  }
  const child = active.get(id);
  if (child) {
    run.cancelRequested = true;
    run.phase = "cancelling";
    child.kill("SIGTERM");
    saveState();
  }
  return run;
}

function tickSchedules() {
  const now = new Date();
  const minuteKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  let changed = false;
  for (const schedule of state.schedules) {
    if (!schedule.enabled || !cronMatches(now, schedule.cron)) continue;
    if (schedule.lastTriggeredMinute === minuteKey) continue;
    if (state.runs.some((run) => run.scheduleId === schedule.id && ["queued", "running"].includes(run.status))) continue;
    schedule.lastTriggeredMinute = minuteKey;
    schedule.lastTriggeredAt = nowIso();
    enqueueRuns({ scheduleId: schedule.id, models: schedule.models || [] });
    changed = true;
  }
  if (changed) saveState();
}

function staticFile(res, pathname) {
  const requested = pathname === "/" || pathname === "/dashboard" ? "dashboard.html" : pathname.slice(1);
  const filePath = resolve(ROOT, requested);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${sep}`)) return text(res, 403, "Forbidden");
  if (!existsSync(filePath)) return text(res, 404, "Not found");
  const content = readFileSync(filePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
  };
  return text(res, 200, content, types[extname(filePath)] || "application/octet-stream");
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }
  if (!url.pathname.startsWith("/api/")) return staticFile(res, url.pathname);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, active: active.size, queued: queue.length });
    }
    if (req.method === "GET" && url.pathname === "/api/config") {
      questionBank = loadQuestionBank();
      return json(res, 200, {
        questionCount: questionBank.questions.length,
        canaryCount: questionBank.questions.filter((q) => q.canary).length,
        candidateCount: questionBank.models.length,
        questionBankVersion: questionBank.version,
        models: questionBank.models.map((model) => ({ id: model.id, cutoff: model.cutoff })),
        host: options.host,
        port: options.port,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/codex-models") {
      try {
        return json(res, 200, await fetchCodexModels());
      } catch (error) {
        return json(res, 200, { fetchedAt: modelCache.fetchedAt, models: [], error: error.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/wecom") {
      return json(res, 200, publicWecomConfig());
    }
    if (req.method === "PATCH" && url.pathname === "/api/wecom") {
      const body = await readBody(req);
      const config = state.wecom || defaultWecomConfig();
      if (body.webhookUrl !== undefined) {
        config.webhookUrl = body.webhookUrl ? validateWebhookUrl(String(body.webhookUrl).trim()) : "";
      }
      if (body.enabled !== undefined) config.enabled = Boolean(body.enabled);
      if (body.mentionAll !== undefined) config.mentionAll = Boolean(body.mentionAll);
      if (body.events !== undefined) {
        if (!body.events || typeof body.events !== "object" || Array.isArray(body.events)) {
          throw new Error("events must be an object");
        }
        config.events = {
          completed: body.events.completed !== false,
          failed: body.events.failed !== false,
          cancelled: body.events.cancelled !== false,
        };
      }
      config.updatedAt = nowIso();
      state.wecom = config;
      saveState();
      return json(res, 200, publicWecomConfig());
    }
    if (req.method === "POST" && url.pathname === "/api/wecom/test") {
      await postWecom("### wimgpt 通知测试\n- 状态：连接成功", false);
      const config = state.wecom || defaultWecomConfig();
      config.lastSentAt = nowIso();
      config.lastError = null;
      state.wecom = config;
      saveState();
      return json(res, 200, publicWecomConfig());
    }
    if (req.method === "GET" && url.pathname === "/api/schedules") {
      return json(res, 200, state.schedules);
    }
    if (req.method === "GET" && url.pathname === "/api/runs") {
      const limit = Math.min(Number(url.searchParams.get("limit") || 50), MAX_RUNS);
      return json(res, 200, state.runs.slice(0, limit).map(publicRun));
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const run = findRun(url.pathname.split("/").pop());
      return run ? json(res, 200, publicRun(run)) : json(res, 404, { error: "Run not found" });
    }
    if (req.method === "POST" && url.pathname === "/api/runs") {
      const body = await readBody(req);
      if (Object.prototype.hasOwnProperty.call(body, "models")) {
        return json(res, 201, publicBatch(enqueueRuns({ models: body.models })));
      }
      return json(res, 201, publicRun(enqueueRun({ model: body.model || null })));
    }
    if (req.method === "POST" && /^\/api\/runs\/[^/]+\/cancel$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      return json(res, 200, publicRun(cancelRun(id)));
    }
    if (req.method === "POST" && url.pathname === "/api/schedules") {
      const body = await readBody(req);
      const models = Object.prototype.hasOwnProperty.call(body, "models")
        ? normalizeRequestedModels(body.models)
        : normalizeRequestedModels(body.model);
      const schedule = {
        id: randomUUID(),
        name: String(body.name || "Codex evaluation").trim().slice(0, 120),
        cron: validateCron(body.cron || "0 * * * *"),
        model: models[0] || null,
        models,
        enabled: body.enabled !== false,
        createdAt: nowIso(),
        lastTriggeredMinute: null,
        lastTriggeredAt: null,
      };
      state.schedules.push(schedule);
      saveState();
      return json(res, 201, schedule);
    }
    if (req.method === "PATCH" && /^\/api\/schedules\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").pop();
      const schedule = findSchedule(id);
      if (!schedule) return json(res, 404, { error: "Schedule not found" });
      const body = await readBody(req);
      if (body.name !== undefined) schedule.name = String(body.name).trim().slice(0, 120);
      if (body.cron !== undefined) schedule.cron = validateCron(body.cron);
      if (Object.prototype.hasOwnProperty.call(body, "models")) {
        schedule.models = normalizeRequestedModels(body.models);
        schedule.model = schedule.models[0] || null;
      } else if (body.model !== undefined) {
        schedule.models = normalizeRequestedModels(body.model);
        schedule.model = schedule.models[0] || null;
      }
      if (body.enabled !== undefined) schedule.enabled = Boolean(body.enabled);
      saveState();
      return json(res, 200, schedule);
    }
    if (req.method === "DELETE" && /^\/api\/schedules\/[^/]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").pop();
      const before = state.schedules.length;
      state.schedules = state.schedules.filter((schedule) => schedule.id !== id);
      if (state.schedules.length === before) return json(res, 404, { error: "Schedule not found" });
      saveState();
      return json(res, 204, null);
    }
    if (req.method === "POST" && /^\/api\/schedules\/[^/]+\/run$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const schedule = findSchedule(id);
      if (!schedule) return json(res, 404, { error: "Schedule not found" });
      const runs = enqueueRuns({ scheduleId: id, models: schedule.models || schedule.model || [] });
      return json(res, 201, runs.length === 1 ? publicRun(runs[0]) : publicBatch(runs));
    }
    return json(res, 404, { error: "API route not found" });
  } catch (error) {
    return json(res, 400, { error: error.message });
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => json(res, 500, { error: error.message }));
});
server.listen(options.port, options.host, () => {
  console.log(`wimgpt dashboard: http://${options.host}:${options.port}/`);
  console.log(`state directory: ${stateDir}`);
});
const scheduler = setInterval(tickSchedules, TICK_MS);
scheduler.unref();

function shutdown(signal) {
  clearInterval(scheduler);
  for (const child of active.values()) child.kill("SIGTERM");
  server.close(() => {
    console.log(`stopped (${signal})`);
    process.exit(0);
  });
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
