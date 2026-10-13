const $ = (id) => document.getElementById(id);
let schedules = [];
let listRequest = null;
let updateActionPending = false;
let restartTarget = null;
const pages = {
  runs: { page: 1, pageSize: Number($("runs-page-size").value), totalPages: 1 },
  schedules: { page: 1, pageSize: Number($("schedules-page-size").value), totalPages: 1 },
  trend: { page: 1, pageSize: Number($("trend-page-size").value), totalPages: 1 },
};
const dateTimeOptions = {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
};
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, { ...dateTimeOptions, second: "2-digit" });
const compactDateTimeFormatter = new Intl.DateTimeFormat(undefined, dateTimeOptions);
$("time-zone").textContent = `Times shown in your browser's time zone: ${dateTimeFormatter.resolvedOptions().timeZone}.`;

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function escapeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function formatLocalTime(value, empty = "—", compact = false) {
  if (!value) return empty;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return empty;
  return (compact ? compactDateTimeFormatter : dateTimeFormatter).format(date);
}

function renderTime(value, empty = "—", compact = false) {
  const formatted = formatLocalTime(value, empty, compact);
  if (!value || formatted === empty) return escapeText(formatted);
  return `<time datetime="${escapeText(value)}" title="${escapeText(value)}">${escapeText(formatted)}</time>`;
}

function statusClass(status) {
  return `status ${String(status || "").toLowerCase()}`;
}

function selectedModels(id) {
  return [...$(id).selectedOptions].map((option) => option.value);
}

function setSelectedModels(id, models) {
  const selected = new Set(Array.isArray(models) ? models : []);
  [...$(id).options].forEach((option) => { option.selected = selected.has(option.value); });
}

function renderModelOptions(models) {
  const available = Array.isArray(models) ? models : [];
  const runSelected = $("run-models") ? selectedModels("run-models") : [];
  const scheduleSelected = $("schedule-models") ? selectedModels("schedule-models") : [];
  const options = available.map((model) => {
    const label = model.displayName || model.id;
    const cutoff = model.cutoff ? ` · cutoff ${model.cutoff}` : "";
    return `<option value="${escapeText(model.id)}">${escapeText(label)}${escapeText(cutoff)}</option>`;
  }).join("");
  $("run-models").innerHTML = options;
  $("schedule-models").innerHTML = options;
  setSelectedModels("run-models", runSelected);
  setSelectedModels("schedule-models", scheduleSelected);
}

function renderConfig(config, codexModels) {
  $("config").innerHTML = [
    [config.questionCount, "questions"],
    [config.canaryCount, "canaries"],
    [config.candidateCount, "candidates"],
    [config.questionBankVersion, "bank version"],
  ].map(([value, label]) => `<div class="stat"><b>${escapeText(value)}</b>${label}</div>`).join("");
  renderModelOptions(codexModels?.length ? codexModels : config.models);
}

function renderSchedules(schedules) {
  if (!schedules.length) {
    $("schedules").innerHTML = '<p class="muted">No schedules yet.</p>';
    return;
  }
  const rows = schedules.map((schedule) => `<tr>
    <td>${escapeText(schedule.name)}</td>
    <td><code>${escapeText(schedule.cron)}</code></td>
    <td>${escapeText((schedule.models || (schedule.model ? [schedule.model] : [])).join(", ") || "Codex default")}</td>
    <td><span class="${statusClass(schedule.enabled ? "enabled" : "paused")}">${schedule.enabled ? "enabled" : "paused"}</span></td>
    <td>${renderTime(schedule.lastTriggeredAt, "never")}</td>
    <td><div class="inline-actions">
      <button class="ghost" data-action="schedule-run" data-id="${schedule.id}">Run now</button>
      <button class="ghost" data-action="schedule-edit" data-id="${schedule.id}">Edit</button>
      <button class="ghost" data-action="schedule-toggle" data-id="${schedule.id}" data-enabled="${schedule.enabled}">${schedule.enabled ? "Pause" : "Resume"}</button>
      <button class="danger" data-action="schedule-delete" data-id="${schedule.id}">Delete</button>
    </div></td>
  </tr>`).join("");
  $("schedules").innerHTML = `<table><thead><tr><th>Name</th><th>Cron</th><th>Model</th><th>Status</th><th>Last triggered</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderRuns(items) {
  if (!items.length) {
    $("runs").innerHTML = '<p class="muted">No runs yet.</p>';
    return;
  }
  const rows = items.map((run) => `<tr>
    <td><code>${escapeText(run.id.slice(0, 8))}</code><br><small>${renderTime(run.createdAt)}</small></td>
    <td><span class="${statusClass(run.status)}">${escapeText(run.status)}</span><br><small>${escapeText(run.phase || "")}</small></td>
    <td>${escapeText(run.model || "Codex default")}</td>
    <td>${run.result ? `${escapeText(run.result.map.id)} (${(run.result.map.probability * 100).toFixed(1)}%)` : "—"}</td>
    <td>${run.result ? run.result.entropy.toFixed(2) : "—"}</td>
    <td><div class="inline-actions"><button class="ghost" data-action="run-detail" data-id="${run.id}">Detail</button>${["queued", "running"].includes(run.status) ? `<button class="danger" data-action="run-cancel" data-id="${run.id}">Cancel</button>` : ""}</div></td>
  </tr>`).join("");
  $("runs").innerHTML = `<table><thead><tr><th>Run</th><th>Status</th><th>Model</th><th>MAP</th><th>Entropy</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderTrend(completed) {
  $("trend").innerHTML = completed.length ? completed.map((run) => `<div class="trend-row">
    <span>${renderTime(run.finishedAt || run.createdAt, "—", true)}</span>
    <div class="trend-track"><div class="trend-fill" style="width:${Math.max(1, run.result.map.probability * 100)}%"></div></div>
    <span>${escapeText(run.result.map.id)} ${(run.result.map.probability * 100).toFixed(1)}%</span>
  </div>`).join("") : '<p class="muted">Complete a run to populate the trend.</p>';
}

function renderDetail(run) {
  $("run-detail").hidden = false;
  const usage = run.usage ? ` · tokens ${run.usage.input_tokens || 0}/${run.usage.output_tokens || 0}` : "";
  $("detail-meta").textContent = `${run.id} · ${formatLocalTime(run.startedAt || run.createdAt)} · ${run.status}${usage}`;
  $("detail-meta").title = run.startedAt || run.createdAt || "";
  const result = run.result;
  $("detail-summary").innerHTML = result ? `<div class="summary">
    <div class="stat"><b>${escapeText(result.map.id)}</b>MAP (${(result.map.probability * 100).toFixed(1)}%)</div>
    <div class="stat"><b>${result.entropy.toFixed(3)}</b>entropy</div>
    <div class="stat"><b>${result.canaryHits}/${result.canaryTotal}</b>canary hits</div>
    <div class="stat"><b>${result.unanswered}</b>unanswered</div>
  </div>` : `<p class="muted">${escapeText(run.phase || run.status)}</p>`;
  $("detail-models").innerHTML = result ? `<table><thead><tr><th>Model</th><th>Cutoff</th><th>Posterior</th><th>In-window</th><th>Post-cutoff</th></tr></thead><tbody>${result.models.map((model) => `<tr><td>${escapeText(model.id)}</td><td>${escapeText(model.cutoff)}</td><td>${(model.probability * 100).toFixed(3)}%</td><td>${model.inWindowKnown}/${model.inWindowTotal}</td><td>${model.postCutoffKnown}/${model.postCutoffTotal}</td></tr>`).join("")}</tbody></table>` : "";
  $("detail-answer").textContent = run.answer ? JSON.stringify(run.answer, null, 2) : "";
  $("detail-error").textContent = run.error || "";
}

function renderPagination(name, data) {
  pages[name] = { page: data.page, pageSize: data.pageSize, totalPages: data.totalPages };
  const start = data.total ? (data.page - 1) * data.pageSize + 1 : 0;
  const end = Math.min(data.page * data.pageSize, data.total);
  $(`${name}-page-info`).textContent = `${start}–${end} of ${data.total} · Page ${data.page} of ${data.totalPages}`;
  $(`${name}-prev`).disabled = data.page <= 1;
  $(`${name}-next`).disabled = data.page >= data.totalPages;
}

async function refreshConfig() {
  try {
    const [config, codexModels] = await Promise.all([
      request("/api/config"), request("/api/codex-models"),
    ]);
    renderConfig(config, codexModels.models);
  } catch (error) {
    $("config").textContent = error.message;
  }
}

async function refresh() {
  listRequest?.abort();
  const controller = new AbortController();
  listRequest = controller;
  const query = (name) => `page=${pages[name].page}&pageSize=${pages[name].pageSize}`;
  try {
    const [schedulePage, runPage, trendPage, updateStatus] = await Promise.all([
      request(`/api/schedules?${query("schedules")}`, { signal: controller.signal }),
      request(`/api/runs?${query("runs")}`, { signal: controller.signal }),
      request(`/api/runs/trend?${query("trend")}`, { signal: controller.signal }),
      request("/api/updates", { signal: controller.signal }),
    ]);
    if (controller.signal.aborted) return;
    if (restartTarget && updateStatus.currentVersion === restartTarget && !updateStatus.busy) {
      window.location.reload();
      return;
    }
    schedules = schedulePage.items;
    renderSchedules(schedules);
    renderRuns(runPage.items);
    renderTrend(trendPage.items);
    renderPagination("schedules", schedulePage);
    renderPagination("runs", runPage);
    renderPagination("trend", trendPage);
    renderUpdateStatus(updateStatus);
    $("list-error").hidden = true;
  } catch (error) {
    if (error.name === "AbortError") return;
    $("list-error").textContent = error.message;
    $("list-error").hidden = false;
  } finally {
    if (listRequest === controller) listRequest = null;
  }
}

function renderUpdateStatus(status) {
  const short = (version) => version ? version.slice(0, 7) : "unknown";
  let message = "Updates are not configured for this deployment.";
  if (status.configured) {
    const descriptions = {
      unchecked: "Waiting for the first version check.",
      current: "You are up to date.",
      ahead: "This version already includes the upstream version.",
      behind: "A new upstream version is available.",
      unknown: "An upstream version is available. Compatibility will be verified before updating.",
      diverged: "Upstream has changes that need merging with this version. Direct update is unavailable.",
    };
    message = `Current ${short(status.currentVersion)} · Upstream ${short(status.remoteVersion)}. ${descriptions[status.relation] || ""}`;
    if (status.dirty && status.updateAvailable) message += " Local changes must be committed or moved before updating.";
    if (!status.restartSupported && status.updateAvailable) message += " Restart is only available in the configured PM2 deployment.";
    if (status.lastCheckedAt) message += ` Checked ${formatLocalTime(status.lastCheckedAt)}.`;
  }
  if (status.checking) message += " Checking…";
  if (status.busy) message = "Validating and updating. Queued evaluations will wait until the restart finishes.";
  $("update-status").textContent = message;
  $("update-source").textContent = status.source ? `${status.source.url} · ${status.source.branch} · Checks only; updates require your click.` : "";
  $("update-error").textContent = status.error || "";
  $("update-error").hidden = !status.error;
  $("update-check").disabled = !status.configured || status.busy || status.checking || updateActionPending;
  $("update-apply").disabled = !status.configured || !status.updateAvailable || status.relation === "diverged"
    || status.dirty || !status.restartSupported || status.busy || status.checking || Boolean(status.error) || updateActionPending;
}

$("update-check").addEventListener("click", async () => {
  updateActionPending = true;
  $("update-check").disabled = true;
  $("update-apply").disabled = true;
  $("update-status").textContent = "Checking upstream for a new version…";
  try { renderUpdateStatus(await request("/api/updates/check", { method: "POST", body: "{}" })); }
  catch (error) { $("update-error").textContent = error.message; $("update-error").hidden = false; }
  finally { updateActionPending = false; await refresh(); }
});

$("update-apply").addEventListener("click", async () => {
  if (!confirm("Update from the upstream main branch and restart the dashboard? Active evaluations and local changes will block the update.")) return;
  updateActionPending = true;
  $("update-check").disabled = true;
  $("update-apply").disabled = true;
  $("update-status").textContent = "Validating the upstream version before updating…";
  try {
    const result = await request("/api/updates/apply", { method: "POST", body: "{}" });
    restartTarget = result.currentVersion;
    renderUpdateStatus(result);
    $("update-status").textContent = "Update installed. Restarting the dashboard…";
  } catch (error) {
    $("update-error").textContent = error.message;
    $("update-error").hidden = false;
  } finally { updateActionPending = false; }
});

for (const name of Object.keys(pages)) {
  for (const [direction, delta] of [["prev", -1], ["next", 1]]) {
    $(`${name}-${direction}`).addEventListener("click", () => {
      pages[name].page = Math.max(1, Math.min(pages[name].totalPages, pages[name].page + delta));
      void refresh();
    });
  }
  $(`${name}-page-size`).addEventListener("change", (event) => {
    pages[name].pageSize = Number(event.target.value);
    pages[name].page = 1;
    void refresh();
  });
}

$("run-now").addEventListener("click", async () => {
  try {
    await request("/api/runs", { method: "POST", body: JSON.stringify({ models: selectedModels("run-models") }) });
    pages.runs.page = 1;
    await refresh();
  } catch (error) { alert(error.message); }
});

$("schedule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const editId = $("schedule-edit-id").value;
    await request(editId ? `/api/schedules/${editId}` : "/api/schedules", { method: editId ? "PATCH" : "POST", body: JSON.stringify({
      name: $("schedule-name").value,
      cron: $("schedule-cron").value,
      models: selectedModels("schedule-models"),
    }) });
    if (!editId) pages.schedules.page = 1;
    clearScheduleEdit();
    await refresh();
  } catch (error) { alert(error.message); }
});

$("refresh").addEventListener("click", () => { void refreshConfig(); void refresh(); });
$("close-detail").addEventListener("click", () => { $("run-detail").hidden = true; });
$("schedule-cancel-edit").addEventListener("click", clearScheduleEdit);
$("download-detail").addEventListener("click", () => {
  if (!window.currentRunDetail) return;
  const blob = new Blob([JSON.stringify(window.currentRunDetail, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `wimgpt-run-${window.currentRunDetail.id}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

function clearScheduleEdit() {
  $("schedule-edit-id").value = "";
  $("schedule-name").value = "Nightly cutoff check";
  $("schedule-cron").value = "0 3 * * *";
  setSelectedModels("schedule-models", []);
  $("schedule-submit").textContent = "Create schedule";
  $("schedule-cancel-edit").hidden = true;
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const id = button.dataset.id;
  try {
    if (button.dataset.action === "run-detail") {
      window.currentRunDetail = await request(`/api/runs/${id}`);
      renderDetail(window.currentRunDetail);
      return;
    }
    if (button.dataset.action === "schedule-edit") {
      const schedule = schedules.find((item) => item.id === id);
      if (!schedule) throw new Error("Schedule not found");
      $("schedule-edit-id").value = schedule.id;
      $("schedule-name").value = schedule.name;
      $("schedule-cron").value = schedule.cron;
      setSelectedModels("schedule-models", schedule.models || (schedule.model ? [schedule.model] : []));
      $("schedule-submit").textContent = "Save schedule";
      $("schedule-cancel-edit").hidden = false;
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (button.dataset.action === "run-cancel") {
      await request(`/api/runs/${id}/cancel`, { method: "POST" });
    }
    if (button.dataset.action === "schedule-run") {
      await request(`/api/schedules/${id}/run`, { method: "POST" });
      pages.runs.page = 1;
    }
    if (button.dataset.action === "schedule-toggle") {
      await request(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: button.dataset.enabled !== "true" }) });
    }
    if (button.dataset.action === "schedule-delete" && confirm("Delete this schedule?")) {
      await request(`/api/schedules/${id}`, { method: "DELETE" });
    }
    await refresh();
  } catch (error) { alert(error.message); }
});

void refreshConfig();
void refresh();
setInterval(() => { if (!document.hidden && !listRequest) void refresh(); }, 3000);
