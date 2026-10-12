# wimgpt — 你聊的到底是什么模型？

[English](README.md)

通过探测训练数据截止日期推断实际服务你的是哪个模型，判断gpt降智：把一组带日期的真实
事件题发给模型，回复贴回来，得到各候选模型的后验分布。

![示例输出](assets/panel.png)


## 使用

1. 通过 http 打开 `index.html`
2. 复制提问，在 ChatGPT 新开对话（关闭联网/搜索）发送
3. 粘贴回复，点 Analyze（Load sample → Analyze 可看演示）

## 使用 Codex 自动运行

仓库提供了一个不依赖第三方 Node 包的 Runner，可以调用本机已经登录的
Codex CLI，自动回答当前 `questions.json` 中的题目，并生成可直接粘贴回本页
回复框的 JSON。因此个人本机运行不需要 OpenAI API Key。

需要 Node.js 18 或更高版本，以及已经可以运行的 Codex CLI。先检查登录状态：

```bash
codex login status
```

运行完整题库并保存结果：

```bash
node scripts/run-codex-eval.mjs \
  --output /tmp/wimgpt-codex-answer.json \
  --events /tmp/wimgpt-codex-events.jsonl
```

启动本地完整控制台：

```bash
node server.mjs
```

项目不需要安装 Node 依赖；贡献前的语法和原有推断自测可以直接运行：

```bash
npm test
```

### 使用 PM2 持久化部署

PM2 必须使用完成 `codex login` 的同一个用户运行。不要用 `sudo` 启动这个服务，
否则 worker 可能读不到该用户的 Codex 登录凭据。

首次安装并启动：

```bash
npm install --global pm2
npm run pm2:start
curl http://127.0.0.1:8787/api/health
```

设置系统重启后的自动恢复：

```bash
npm run pm2:startup
pm2 save
```

`pm2 startup` 会打印一条需要按当前系统执行的命令；执行后再运行 `pm2 save`
保存当前进程列表。日常可以使用 `npm run pm2:restart`、`npm run pm2:stop`、
`npm run pm2:remove` 和 `pm2 logs wimgpt-dashboard`。

PM2 配置固定监听 loopback，状态和日志放在 `.wimgpt/`，服务崩溃会自动重启，
并关闭文件监听，避免运行结果写入时触发重启循环。

然后打开 `http://127.0.0.1:8787/`。控制台支持立即运行、创建/暂停/恢复/删除
计划、取消任务、查看运行详情、后验结果和历史记录。状态、计划、答案和评分摘要
保存在 `.wimgpt/`；服务默认只监听 loopback。计划使用本地五字段 cron，例如
`0 3 * * *`，调度器每 15 秒检查一次，并且同时只运行一个 Codex 任务。
计划和立即运行都可以选择多个模型；每个模型会生成一个独立的队列任务，并通过
同一个 batch ID 关联。一个模型都不选时使用 Codex 默认模型。

HTTP API 同时接受旧的 `model` 字符串和新的 `models` 数组。`GET /api/config`
返回题库候选模型，`GET /api/codex-models` 查询本机 Codex app server 当前可用的
模型。企业微信通知默认关闭；确有需要时，仅从可信的回环客户端调用
`PATCH /api/wecom` 写入 webhook 地址。

标准输出也会打印规范化后的答案。可以用 `--model MODEL` 指定 Codex 模型，
用 `--dry-run` 查看实际发送的提问，用 `--limit 8` 做小规模 smoke test。
`--limit` 只会运行部分题目，结果不适合直接拿到完整题库的网页中分析。

个人定时运行时，可以由 cron 或 systemd timer 调用这个命令。Runner 应该运行
在已经登录 Codex 的宿主机上；不要把 Codex 登录目录挂载到公开 Web 容器，也不要
让 HTTP 请求直接传入任意 shell 命令。Runner 对每次运行使用只读沙箱、独立的
ephemeral 对话、JSON Schema 和超时控制。

这个 Runner 测量的是 Codex Harness 下模型的回答，不能证明 ChatGPT 网页端另一
个对话实际选择了哪个模型。定时结果应同时保存请求模型、题库版本、原始回答和
运行时间，以便截止日更新后复查历史结果。

## 原理

### 形式化

问卷为 $n$ 道带日期的事件题 $q_1,\dots,q_n$，事件日期 $d_1 \le \dots \le d_n$；
候选模型 $m_1,\dots,m_M$，训练数据截止日 $c_1,\dots,c_M$，先验
$\pi_j = P(m_j)$，$\sum_j \pi_j = 1$（默认均匀）。每题观测
$r_i \in \{0,1\}$：1 = 知道该事件。

### 似然模型

$$P(r_i = 1 \mid m_j) = \begin{cases} p, & d_i \le c_j \\[2pt] \varepsilon, & d_i > c_j \end{cases}$$

$p = 0.9$（窗口内的事件可能回忆失败）；$\varepsilon = 0.05$（截止后的事件
可能被猜中或幻觉；若 $\varepsilon = 0$，一次截止后的命中会将该候选的似然
归零，命中在所有候选截止日之后则全部归零）。

$$L_j = P(r_{1:n} \mid m_j) = \prod_{i=1}^{n} P(r_i \mid m_j)$$

### 充分统计量

```math
n_j = \#\{i : d_i \le c_j\}, \qquad K_j = \sum_{d_i \le c_j} r_i, \qquad G_j = \sum_{d_i > c_j} r_i
```
$$L_j = p^{K_j}\,(1-p)^{\,n_j - K_j}\;\cdot\;\varepsilon^{G_j}\,(1-\varepsilon)^{\,n - n_j - G_j}$$

答案向量只通过 $(n_j, K_j, G_j)$ 进入推断：测试估计的是一个变点——按日期
排序的答案序列从 1 翻到 0 的位置。

### 后验

$$P(m_j \mid r) = \frac{\pi_j\, L_j}{\sum_{j'=1}^{M} \pi_{j'}\, L_{j'}}, \qquad \log \frac{P(m_a \mid r)}{P(m_b \mid r)} = \log \frac{\pi_a}{\pi_b} + \log \frac{L_a}{L_b}$$

- 均匀先验 ⇒ 后验 ∝ 似然
- 同截止日 ⇒ 对任何回答模式似然相同，后验比等于先验比（均匀先验下为
  50/50）

### 一道分界题的证据

日期落在 $c_a < d_i \le c_b$ 的题对 $b$ vs $a$ 的对数几率贡献：

$$r_i = 1:\ \ \log\frac{p}{\varepsilon} \approx 2.89 \text{ nats} \quad (\approx 18\text{ 倍})$$

$$r_i = 0:\ \ \log\frac{1-\varepsilon}{1-p} \approx 2.25 \text{ nats，指向 } a \quad (\approx 9.5\text{ 倍})$$

单题可能失误（窗口内 10% miss 率），每条截止缝隙放 2–3 道题。

### 数值示例

两个候选：$A$（截止日在 $d_2$ 前）、$B$（在后）。两题都在 $B$ 的窗口内，
只有 $q_1$ 在 $A$ 的窗口内。回复 $r = (1, 0)$：

$$L_A = 0.9 \cdot 0.95 = 0.855 \qquad L_B = 0.9 \cdot 0.10 = 0.09$$

- 均匀先验：$P(A \mid r) = 0.855 / (0.855 + 0.09) = 90.5\%$

### 缺失回答

从似然中整体省略（记 0 会偏向更早的截止日）。实答题数低于 60% 判定
run 无效。

### 输出

各模型后验；按截止带聚合的后验；MAP；后验熵 $H = -\sum_j P_j \log P_j$；
金丝雀检查（虚构事件——声称知道即触发幻觉警报）。非 JSON 回复按编号行
解析并用关键词判分。

## 数据文件

`questions.json`——带日期的事件（`id`、`date`、`question`、`truth`、
`keywords`、可选 `canary`）。事件放在各候选截止日的缝隙里；只用不可猜的
专名——答案可凭事前知识猜出的题，删除或改写

`models.json`——候选（`id`、`cutoff`），先验默认均匀。截止日为 2026-09
时点（部分为第三方转述，以 developers.openai.com 为准）：

| 模型 | 截止日 |
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

## 局限

- 测的是截止日；同截止日候选无法被区分
- 全局 $p$/$\varepsilon$：若题库残余可猜性超过 $\varepsilon=0.05$，每题
  Bayes 因子被高估——用 $\varepsilon \times 3$ 复跑检验稳健性
- 联网搜索使结果塌缩到最新截止日；新开对话、关闭搜索。自报可能被网页端
  系统提示压制——意外结果用自由回忆题复核
- 单对话的题目间有轻微上下文泄漏；拒答压低 $p$
- 官方可能静默更新 cutoff

## 数据来源

- 模型 cutoff 谱系：[llm-knowledge-cutoff-dates](https://github.com/HaoooWang/llm-knowledge-cutoff-dates)、
  [GPT-6 Astra 发布](https://openai.com/index/gpt-6-astra/)、
  [GPT-5.5 Pro cutoff](https://tutorsbot.com)、
  [GPT-5.6 cutoff](https://www.eesel.ai)、
  [GPT-6 Astra cutoff](https://dev.to)
- 事件日期：Wikipedia 时事门户
  [2025-10](https://en.wikipedia.org/wiki/Portal:Current_events/October_2025)、
  [2026-02](https://en.wikipedia.org/wiki/Portal:Current_events/February_2026)、
  [2026-03](https://en.wikipedia.org/wiki/Portal:Current_events/March_2026)
- 降级路由场景：[社区报告：5.6 Pro 被自动路由到 5.5 mini](https://community.openai.com)
