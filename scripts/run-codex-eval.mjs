#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: node scripts/run-codex-eval.mjs [options]

Run the questions in questions.json through the locally authenticated Codex CLI.
The final JSON can be pasted into the web UI's reply box.

Options:
  --questions PATH     Question bank (default: ./questions.json)
  --schema PATH        JSON Schema (default: ./codex-answer.schema.json)
  --model NAME         Codex model override
  --codex-bin PATH     Codex executable (default: codex)
  --output PATH        Save the normalized answer JSON to PATH
  --events PATH        Save Codex's JSONL event stream to PATH
  --limit N            Run only the first N questions (smoke tests only)
  --timeout-ms N       Stop waiting after N milliseconds (default: 300000)
  --dry-run            Print the generated prompt without invoking Codex
  --help               Show this help
`;
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    questions: resolve(ROOT, "questions.json"),
    schema: resolve(ROOT, "codex-answer.schema.json"),
    model: null,
    codexBin: "codex",
    output: null,
    events: null,
    limit: null,
    timeoutMs: 300000,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--questions") {
      options.questions = resolve(takeValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--schema") {
      options.schema = resolve(takeValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--model") {
      options.model = takeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--codex-bin") {
      options.codexBin = takeValue(argv, i, arg);
      i += 1;
      continue;
    }
    if (arg === "--output") {
      options.output = resolve(takeValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--events") {
      options.events = resolve(takeValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--limit") {
      options.limit = Number(takeValue(argv, i, arg));
      if (!Number.isInteger(options.limit) || options.limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
      i += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      options.timeoutMs = Number(takeValue(argv, i, arg));
      if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) {
        throw new Error("--timeout-ms must be an integer >= 1000");
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
  }

  return options;
}

function readQuestions(path, limit) {
  const bank = JSON.parse(readFileSync(path, "utf8"));
  if (!bank || !Array.isArray(bank.questions) || bank.questions.length === 0) {
    throw new Error(`${path} must contain a non-empty questions array`);
  }
  const questions = limit === null ? bank.questions : bank.questions.slice(0, limit);
  if (questions.length === 0) {
    throw new Error("The selected question set is empty");
  }
  questions.forEach((question, index) => {
    if (!question || typeof question.question !== "string" || !question.question.trim()) {
      throw new Error(`Question ${index + 1} has no question text`);
    }
  });
  return questions;
}

function buildPrompt(questions) {
  const head = [
    `Answer the following ${questions.length} questions from memory only.`,
    "Do not search the web and do not use any tools or files.",
    "For each question set knows=1 if you know the event and remember details,",
    "0 if you do not know it or would just be guessing; write a few words about",
    "what you remember (empty string if you do not know).",
    "Output only one JSON object and nothing else, in this format:",
    '{"answers": [{"no": 1, "knows": 1, "what": "..."}, {"no": 2, "knows": 0, "what": ""}]}',
    "",
  ].join("\n");
  return head + questions.map((question, index) => `${index + 1}. ${question.question}`).join("\n") + "\n";
}

function validateAnswers(value, questionCount) {
  if (!value || !Array.isArray(value.answers)) {
    throw new Error("Codex output must be an object with an answers array");
  }

  const seen = new Set();
  for (const answer of value.answers) {
    if (!answer || !Number.isInteger(answer.no) || answer.no < 1 || answer.no > questionCount) {
      throw new Error(`Invalid answer number: ${JSON.stringify(answer)}`);
    }
    if (seen.has(answer.no)) {
      throw new Error(`Duplicate answer number: ${answer.no}`);
    }
    if (answer.knows !== 0 && answer.knows !== 1) {
      throw new Error(`Answer ${answer.no} has knows outside 0/1`);
    }
    if (typeof answer.what !== "string") {
      throw new Error(`Answer ${answer.no} has a non-string what field`);
    }
    seen.add(answer.no);
  }

  if (seen.size !== questionCount) {
    const missing = [];
    for (let no = 1; no <= questionCount; no += 1) {
      if (!seen.has(no)) missing.push(no);
    }
    throw new Error(`Codex returned ${seen.size}/${questionCount} answers; missing ${missing.join(", ")}`);
  }

  return {
    answers: value.answers.slice().sort((a, b) => a.no - b.no),
  };
}

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function eventFailure(stdout) {
  const messages = [];
  for (const line of String(stdout || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === "error" && event.message) messages.push(event.message);
      if (event.type === "turn.failed" && event.error?.message) {
        messages.push(event.error.message);
      }
      if (event.type === "item.completed" && event.item?.type === "error" && event.item.message) {
        messages.push(event.item.message);
      }
    } catch {
      // A diagnostic line outside the JSONL stream is handled by stderr below.
    }
  }
  return [...new Set(messages)].at(-1) || "";
}

function runCodex(options, prompt, questionCount) {
  if (!existsSync(options.schema)) {
    throw new Error(`Schema file does not exist: ${options.schema}`);
  }

  const runDir = mkdtempSync(resolve(tmpdir(), "wimgpt-codex-"));
  const finalPath = options.output || resolve(runDir, "final.json");
  ensureParent(finalPath);

  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--json",
    "--output-schema",
    options.schema,
    "--output-last-message",
    finalPath,
  ];
  if (options.model) args.push("--model", options.model);
  args.push("-");

  const result = spawnSync(options.codexBin, args, {
    input: prompt,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (options.events) {
    ensureParent(options.events);
    writeFileSync(options.events, result.stdout || "", "utf8");
  }

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`Codex timed out after ${options.timeoutMs} ms`);
    }
    throw new Error(`Failed to start Codex: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = eventFailure(result.stdout) || (result.stderr || "").trim();
    throw new Error(`Codex exited with status ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  if (!existsSync(finalPath)) {
    throw new Error(`Codex completed without writing ${finalPath}`);
  }

  let final;
  try {
    final = JSON.parse(readFileSync(finalPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in ${finalPath}: ${error.message}`);
  }
  const normalized = validateAnswers(final, questionCount);
  writeFileSync(finalPath, `${JSON.stringify(normalized)}\n`, "utf8");
  return normalized;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const questions = readQuestions(options.questions, options.limit);
  const prompt = buildPrompt(questions);

  if (options.dryRun) {
    process.stdout.write(prompt);
    return;
  }

  const result = runCodex(options, prompt, questions.length);
  if (options.output) {
    process.stderr.write(`Saved ${options.output}\n`);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`codex runner: ${error.message}\n`);
  process.exitCode = 1;
}
