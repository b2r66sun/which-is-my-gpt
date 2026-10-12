const $ = (id) => document.getElementById(id);
let runs = [];

async function request(path, options = {}) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function escapeText(value) {
  return String(value ?? "");
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
    <td>${escapeText(schedule.lastTriggeredAt || "never")}</td>
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
  runs = items;
  if (!items.length) {
    $("runs").innerHTML = '<p class="muted">No runs yet.</p>';
    $("trend").innerHTML = '<p class="muted">Complete a run to populate the trend.</p>';
    return;
  }
  const rows = items.map((run) => `<tr>
    <td><code>${escapeText(run.id.slice(0, 8))}</code><br><small>${escapeText(run.createdAt)}</small></td>
    <td><span class="${statusClass(run.status)}">${escapeText(run.status)}</span><br><small>${escapeText(run.phase || "")}</small></td>
    <td>${escapeText(run.model || "Codex default")}</td>
    <td>${run.result ? `${escapeText(run.result.map.id)} (${(run.result.map.probability * 100).toFixed(1)}%)` : "—"}</td>
    <td>${run.result ? run.result.entropy.toFixed(2) : "—"}</td>
    <td><div class="inline-actions"><button class="ghost" data-action="run-detail" data-id="${run.id}">Detail</button>${["queued", "running"].includes(run.status) ? `<button class="danger" data-action="run-cancel" data-id="${run.id}">Cancel</button>` : ""}</div></td>
  </tr>`).join("");
  $("runs").innerHTML = `<table><thead><tr><th>Run</th><th>Status</th><th>Model</th><th>MAP</th><th>Entropy</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  const completed = items.filter((run) => run.result).slice(0, 20).reverse();
  $("trend").innerHTML = completed.length ? completed.map((run) => `<div class="trend-row">
    <span>${escapeText((run.finishedAt || run.createdAt).slice(0, 16).replace("T", " "))}</span>
    <div class="trend-track"><div class="trend-fill" style="width:${Math.max(1, run.result.map.probability * 100)}%"></div></div>
    <span>${escapeText(run.result.map.id)} ${(run.result.map.probability * 100).toFixed(1)}%</span>
  </div>`).join("") : '<p class="muted">Complete a run to populate the trend.</p>';
}

function renderDetail(run) {
  $("run-detail").hidden = false;
  const usage = run.usage ? ` · tokens ${run.usage.input_tokens || 0}/${run.usage.output_tokens || 0}` : "";
  $("detail-meta").textContent = `${run.id} · ${run.startedAt || run.createdAt} · ${run.status}${usage}`;
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

async function refresh() {
  try {
    const [config, codexModels, schedules, runItems] = await Promise.all([
      request("/api/config"), request("/api/codex-models"), request("/api/schedules"), request("/api/runs?limit=100"),
    ]);
    renderConfig(config, codexModels.models);
    renderSchedules(schedules);
    renderRuns(runItems);
  } catch (error) {
    $("config").textContent = error.message;
  }
}

$("run-now").addEventListener("click", async () => {
  try {
    await request("/api/runs", { method: "POST", body: JSON.stringify({ models: selectedModels("run-models") }) });
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
    clearScheduleEdit();
    await refresh();
  } catch (error) { alert(error.message); }
});

$("refresh").addEventListener("click", refresh);
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
      const schedule = (await request("/api/schedules")).find((item) => item.id === id);
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

refresh();
setInterval(refresh, 3000);
