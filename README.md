# wimgpt — which model are you talking to?

[中文文档](README.zh-CN.md)

Estimates which model is serving you by probing its training-data cutoff:
quiz the model about dated real events, paste the reply back, get a posterior
over candidate models.

![Example output](assets/panel.png)


## Use

1. Open `index.html`
2. Copy the quiz, send it in a fresh ChatGPT chat with search disabled.
3. Paste the reply, hit Analyze. (Load sample → Analyze for a demo.)

## Automated runs with Codex

The repository includes an optional dependency-free Node.js runner for a local
Codex CLI. It uses the Codex login already configured on the machine, so it does
not require an OpenAI API key. The runner writes the same JSON shape accepted by
the reply box in this page.

Requirements: Node.js 18 or later and a working Codex CLI. Check the login
before scheduling a run:

```bash
codex login status
```

Run the complete question bank and save the answer for pasting into the UI:

```bash
node scripts/run-codex-eval.mjs \
  --output /tmp/wimgpt-codex-answer.json \
  --events /tmp/wimgpt-codex-events.jsonl
```

For the local dashboard, start the built-in server and open
`http://127.0.0.1:8787/`:

```bash
node server.mjs
```

The same checks used before a contribution can be run without installing any
packages:

```bash
npm test
```

### Run as a persistent PM2 service

PM2 must run as the same user that completed `codex login`; do not start this
process with `sudo`, because the worker needs that user's Codex authentication.
Install PM2 once, then start and save the dashboard process:

```bash
npm install --global pm2
npm run pm2:start
curl http://127.0.0.1:8787/api/health
```

Enable restart after reboot by running the printed command from `pm2 startup`
once, then save the current process list:

```bash
npm run pm2:startup
pm2 save
```

Useful lifecycle commands are `npm run pm2:restart`, `npm run pm2:stop`,
`npm run pm2:remove`, and `pm2 logs wimgpt-dashboard`. The PM2 ecosystem file
keeps the service on loopback, stores application state and PM2 logs under
`.wimgpt/`, restarts after crashes, and avoids file watching so a generated run
cannot trigger a restart loop.

The dashboard stores schedules, runs, normalized answers, and score summaries
under `.wimgpt/`. The server binds to loopback by default. Use a five-field local
cron expression such as `0 3 * * *`; the scheduler checks it every 15 seconds and
keeps one Codex run active at a time. A schedule can select multiple model IDs;
the server creates one queued run per selected model and links them with a shared
batch ID. Leaving the selection empty uses Codex's default model.

Runs and schedules are paginated (10, 20, or 50 rows) and sorted by creation
time, newest first. The dashboard polls only the current pages every three
seconds while visible. Run lists contain summaries; answers and full posteriors
are loaded when opening a detail. The trend has its own pages (10, 20, or 50 scored
runs), ordered by completion time, newest first. Its page and size are independent
of the run list. The existing 200-run
retention limit is unchanged; pagination does not delete history.

Timestamps use the browser's time zone and locale, identified at the top of the
page. Hover over a timestamp to see its original UTC value. Storage and exports
retain standard timestamps; cron schedules use the server's time zone.

List API callers can request `GET /api/runs?page=1&pageSize=20` and
`GET /api/schedules?page=1&pageSize=20`, or
`GET /api/runs/trend?page=1&pageSize=20`. These return
`{ items, page, pageSize, total, totalPages }`; page size must be 1–100, and pages
past the end return the last page. Calls without pagination retain their array
response, including full run data. `GET /api/runs/trend?limit=20` returns a
bounded summary list for the trend.

### Upstream update reminders and manual installation

The dashboard can periodically check a public GitHub branch and display a new
version notice. It never installs or restarts automatically. Configure this
optional feature using its dedicated template:

```bash
cp config/updates/.env.example config/updates/.env
```

Fill the repository URL and the name of the PM2 process that owns this server.
The template is the complete update configuration inventory and contains its
non-secret defaults. Missing `.env` disables the feature; incomplete or invalid
settings are reported on the page. The local `.env` is ignored by Git and is not
served over HTTP. Restart the existing PM2 process to load configuration changes;
use `pm2 restart <your-process-name>` to retain host-specific arguments rather
than reapplying the repository ecosystem file. `--updates-config PATH` selects
a different update configuration file, including for isolated tests.

Use **Check for updates** for an immediate check, then **Update and restart**
to install a compatible version. Checks only read remote references. Installation
requires a clean checkout, no active evaluation, and ownership by the configured
PM2 process with autorestart enabled. New queued runs wait during installation.
The updater fetches the branch, verifies that the target includes the current
commit and the dashboard/updater, and runs syntax checks and `npm test` in a
temporary copy before a fast-forward merge. It then exits gracefully so PM2
restarts it with the same arguments. It never calls `pm2:start` or rewrites the
PM2 dump. The page reloads when the updated process is ready. No additional npm
library or GitHub token is required.

A fork with local features can diverge from the original repository's `main`.
Those changes need merging before this updater can install them; it never
discards local features or switches branches. Dependency/runtime changes also
require a manual deployment. Before installation, the previous commit is saved
under `refs/wimgpt-update-backups/`; `.wimgpt/update-receipt.json` records the
successful update and backup reference. Candidate test failures leave the running
checkout unchanged. A failed startup after installation requires manual recovery
using the saved reference; automatic startup rollback is not implemented.

The HTTP API accepts the legacy `model` string and the multi-model `models` array
on run and schedule requests. `GET /api/config` returns the question-bank model
catalog, while `GET /api/codex-models` asks the local Codex app server for its
currently available models. Enterprise WeChat notifications are disabled by
default; configure them through the local `PATCH /api/wecom` endpoint only when
you have a trusted loopback client and a webhook URL.

The normalized answer is also printed to stdout. Use `--model MODEL` to select a
Codex model, `--dry-run` to inspect the generated prompt, and `--limit 8` for a
small smoke test. `--limit` intentionally produces a partial question set and
is not suitable for a full run in the browser.

For a private scheduled run, call the command from cron or a systemd timer. Keep
the runner on the host where Codex is logged in; do not mount the Codex auth
directory into a public browser container or accept arbitrary shell commands
from HTTP requests. The runner uses a read-only sandbox, a fresh ephemeral
conversation, a JSON Schema, and a timeout for each run.

This measures the model through the Codex harness. It does not prove which model
the ChatGPT web app selected for a separate conversation. Store the requested
model, question-bank version, raw answer, and run timestamp with scheduled
results so later cutoff updates remain auditable.

## How it works

### Setup

A quiz of $n$ dated events $q_1,\dots,q_n$ with event dates $d_1 \le \dots \le d_n$;
candidate models $m_1,\dots,m_M$ with training-data cutoffs $c_1,\dots,c_M$ and
priors $\pi_j = P(m_j)$, $\sum_j \pi_j = 1$ (uniform by default). Each reply
$r_i \in \{0,1\}$: 1 = knows the event.

### Likelihood model

$$P(r_i = 1 \mid m_j) = \begin{cases} p, & d_i \le c_j \\[2pt] \varepsilon, & d_i > c_j \end{cases}$$

with $p = 0.9$ (in-window events can fail recall) and $\varepsilon = 0.05$
(post-cutoff events can be guessed or hallucinated; with $\varepsilon = 0$ a
single hit past a candidate's cutoff would zero its likelihood, and a hit past
every candidate's cutoff would zero all of them).

$$L_j = P(r_{1:n} \mid m_j) = \prod_{i=1}^{n} P(r_i \mid m_j)$$

### Sufficient statistics
```math
n_j = \#\{i : d_i \le c_j\}, \qquad K_j = \sum_{d_i \le c_j} r_i, \qquad G_j = \sum_{d_i > c_j} r_i
```

$$L_j = p^{K_j}\,(1-p)^{\,n_j - K_j}\;\cdot\;\varepsilon^{G_j}\,(1-\varepsilon)^{\,n - n_j - G_j}$$

The answer vector enters only through $(n_j, K_j, G_j)$: the test estimates a
change point — where the date-sorted answer sequence flips from 1s to 0s.

### Posterior

$$P(m_j \mid r) = \frac{\pi_j\, L_j}{\sum_{j'=1}^{M} \pi_{j'}\, L_{j'}}, \qquad \log \frac{P(m_a \mid r)}{P(m_b \mid r)} = \log \frac{\pi_a}{\pi_b} + \log \frac{L_a}{L_b}$$

- Uniform priors ⇒ posterior ∝ likelihood.
- Same cutoff ⇒ identical likelihood for every answer pattern; the posterior
  ratio equals the prior ratio (50/50 under uniform priors).

### Evidence per boundary question

A question with $c_a < d_i \le c_b$ contributes to the log-odds between $b$ and $a$:

$$r_i = 1:\ \ \log\frac{p}{\varepsilon} \approx 2.89 \text{ nats} \quad (\approx 18\times)$$

$$r_i = 0:\ \ \log\frac{1-\varepsilon}{1-p} \approx 2.25 \text{ nats toward } a \quad (\approx 9.5\times)$$

Single questions can misfire (10% in-window miss rate), so each gap between
candidate cutoffs carries 2–3 questions.

### Worked example

Two candidates: $A$ (cutoff before $d_2$), $B$ (after). Both questions are in
$B$'s window, only $q_1$ in $A$'s. Reply $r = (1, 0)$:

$$L_A = 0.9 \cdot 0.95 = 0.855 \qquad L_B = 0.9 \cdot 0.10 = 0.09$$

- Uniform prior: $P(A \mid r) = 0.855 / (0.855 + 0.09) = 90.5\%$

### Missing answers

Omitted from the likelihood (scoring them 0 would bias toward older cutoffs).
Fewer than 60% of questions answered invalidates the run.

### Outputs

Per-model posterior; per-cutoff-band posterior; MAP; posterior entropy
$H = -\sum_j P_j \log P_j$; canary check (fabricated events — claiming to know
one flags hallucination). Non-JSON replies are parsed as numbered lines and
graded by keyword match.

## Data files

`questions.json` — dated events (`id`, `date`, `question`, `truth`, `keywords`,
optional `canary`). Place events in the gaps between candidate cutoffs; use
only unguessable specifics — if the answer is guessable from pre-event
knowledge, drop or rephrase the question.

`models.json` — candidates (`id`, `cutoff`); priors default to uniform.
Cutoffs as of 2026-09 (partly third-party; verify against developers.openai.com):

| model | cutoff |
|---|---|
| gpt-6-astra | 2026-04-30 |
| gpt-6-sol | 2026-04-20 |
| gpt-6-luna | 2026-05-18 |
| gpt-5.6 | 2026-02-16 |
| gpt-5.5-pro / 5.5-mini | 2025-12-01 |
| gpt-5.4 / 5.2 | 2025-08-31 |
| gpt-5 / 5.1 | 2024-09-30 |
| gpt-5-mini / nano | 2024-05-31 |
| gpt-4.1 / o3 | 2024-06-01 |
| gpt-4o / 4o-mini | 2023-10-01 |

## Limitations

- Measures the cutoff; same-cutoff candidates are never separated.
- Global $p$/$\varepsilon$: if residual guessability exceeds $\varepsilon=0.05$,
  per-hit Bayes factors are overstated — re-run with $\varepsilon \times 3$ to
  check robustness.
- Web search collapses the test onto the newest cutoff; use a fresh chat with
  search off. Self-report can be suppressed by the web system prompt — verify
  surprising results with free-recall questions.
- One conversation leaks slight context between items; refusals depress $p$.
- Cutoffs change silently.

## Sources

- Cutoffs: [llm-knowledge-cutoff-dates](https://github.com/HaoooWang/llm-knowledge-cutoff-dates),
  [GPT-6 Astra launch](https://openai.com/index/gpt-6-astra/),
  [GPT-5.5 Pro cutoff](https://tutorsbot.com), [GPT-5.6 cutoff](https://www.eesel.ai),
  [GPT-6 Astra cutoff](https://dev.to)
- Event dates: Wikipedia current-events portals
  [2025-10](https://en.wikipedia.org/wiki/Portal:Current_events/October_2025),
  [2026-02](https://en.wikipedia.org/wiki/Portal:Current_events/February_2026),
  [2026-03](https://en.wikipedia.org/wiki/Portal:Current_events/March_2026)
- Downgrade scenario: [community report: 5.6 Pro auto-routed to 5.5 mini](https://community.openai.com)
