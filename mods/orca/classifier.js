// Pure OpenAI-compatible classifier & adversarial reviewer client for Orca.
// Zero Herdr host/UI imports and zero Node APIs so it runs in both Herdr and bun test.

import { REVIEWER_TOOLS } from "./reviewer_tools.js";

const VALID_VERDICTS = new Set(["completed", "waiting_ci", "needs_fix", "needs_user", "failed"]);
const MAX_REVIEW_TOOL_ROUNDS = 6;

const ANSI_OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI_RE = /[\u001b\u009b]\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC_RE = /\u001b[@-Z\\-_]/g;

export function stripAnsi(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_ESC_RE, "");
}

export function normalizeBaseUrl(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (/\/v1$/i.test(trimmed)) {
    return `${trimmed.slice(0, -3)}/v1`;
  }
  return `${trimmed}/v1`;
}

function buildHeaders(apiKey, extra = {}) {
  const headers = { ...extra };
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function readErrorDetail(res) {
  try {
    const text = await res.text();
    if (!text) return res.statusText || "Unknown error";
    try {
      const parsed = JSON.parse(text);
      const msg = parsed?.error?.message || parsed?.message;
      if (typeof msg === "string" && msg.trim()) return msg.trim();
    } catch {
      // Fall back to raw text below.
    }
    return text.trim().slice(0, 300);
  } catch {
    return res.statusText || "Unknown error";
  }
}

function tailText(text, maxChars) {
  const str = String(text ?? "");
  if (str.length <= maxChars) return str;
  return str.slice(str.length - maxChars);
}

export async function fetchModels(cfg, fetchFn = fetch) {
  const baseUrl = normalizeBaseUrl(cfg?.baseUrl);
  if (!baseUrl) {
    throw new Error("Base URL is required");
  }

  const res = await fetchFn(`${baseUrl}/models`, {
    method: "GET",
    headers: buildHeaders(cfg?.apiKey, { Accept: "application/json" }),
  });

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Failed to fetch models (HTTP ${res.status}): ${detail}`);
  }

  const payload = await res.json();
  const rawList = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : Array.isArray(payload)
        ? payload
        : [];

  const ids = new Set();
  for (const item of rawList) {
    const id = typeof item === "string" ? item : item?.id;
    if (typeof id === "string" && id.trim()) {
      ids.add(id.trim());
    }
  }

  return [...ids].sort((a, b) => a.localeCompare(b));
}

function tryParseJsonObject(text) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Try fenced or embedded JSON below.
  }

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fall through to brace extraction.
    }
  }

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(text.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return null;
    }
  }

  return null;
}

export function parseClassifierVerdict(rawText) {
  const text = String(rawText ?? "").trim();
  const obj = tryParseJsonObject(text);
  if (!obj) {
    return {
      verdict: "needs_user",
      reason: "Не удалось разобрать ответ классификатора",
    };
  }

  const rawVerdict = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
  const verdict = VALID_VERDICTS.has(rawVerdict) ? rawVerdict : "needs_user";
  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim()
      : "Классификатор не указал причину";

  const result = { verdict, reason };
  if (typeof obj.ci_ref === "string" && obj.ci_ref.trim()) {
    result.ci_ref = obj.ci_ref.trim();
  }
  if (Array.isArray(obj.evidence)) {
    result.evidence = obj.evidence
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (Array.isArray(obj.issues)) {
    result.issues = obj.issues
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  return result;
}

export function buildClassifierMessages(ctx) {
  const {
    epic = null,
    task = null,
    terminalTail = "",
    gitStatus = "",
    gitLog = "",
    ciSummary = "",
  } = ctx ?? {};

  const systemPrompt = [
    "You classify the latest turn of an autonomous coding agent in a terminal.",
    "Choose exactly one verdict:",
    '- "completed": the assigned task/epic is finished and verified, with no pending CI wait or user question.',
    '- "waiting_ci": the agent pushed changes or triggered CI and is waiting for CI/checks to complete.',
    '- "needs_user": the agent is asking the user a question, requesting approval/input, or the outcome is unclear.',
    '- "failed": the agent hit a fatal error, aborted, or left failing tests/build without continuing.',
    'Respond strictly with a single JSON object: {"verdict":"completed|waiting_ci|needs_user|failed","reason":"concise explanation","ci_ref":"optional branch or PR ref"}.',
  ].join("\n");

  const parts = [];
  if (epic) {
    parts.push(`Epic: ${epic.id ?? ""} — ${epic.title ?? ""}`.trim());
    if (epic.dod) {
      parts.push(`Definition of Done:\n${tailText(epic.dod, 1500)}`);
    }
  }
  if (task) {
    parts.push(`Task: ${task.id ?? ""} — ${task.title ?? ""}`.trim());
    if (Array.isArray(task.subitems) && task.subitems.length > 0) {
      parts.push(`Subitems:\n${task.subitems.map((s) => `- ${s}`).join("\n")}`);
    }
  }

  const cleanTail = tailText(stripAnsi(terminalTail), 6000).trim();
  parts.push(`Terminal tail:\n${cleanTail || "(empty)"}`);

  if (gitStatus && String(gitStatus).trim()) {
    parts.push(`Git status:\n${tailText(String(gitStatus).trim(), 2000)}`);
  }
  if (gitLog && String(gitLog).trim()) {
    parts.push(`Git log:\n${tailText(String(gitLog).trim(), 2000)}`);
  }
  if (ciSummary && String(ciSummary).trim()) {
    parts.push(`CI summary:\n${tailText(String(ciSummary).trim(), 1500)}`);
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: parts.join("\n\n") },
  ];
}

export function buildReviewerMessages(ctx, hasTools = false) {
  const {
    epic = null,
    task = null,
    terminalTail = "",
    gitStatus = "",
    gitLog = "",
    gitDiff = "",
    ciSummary = "",
  } = ctx ?? {};

  const systemPrompt = [
    "You are an independent, skeptical senior code reviewer and verification auditor.",
    "Your job is to verify whether the coding agent genuinely completed the assigned task/epic with real, working code — or whether it fabricated results, took shortcuts, left stubs, or missed requirements.",
    "",
    "Core verification rules (anti-hallucination & anti-reward-hacking):",
    "1. NEVER treat the coding agent's own summary or claims ('done', 'all tests pass', 'implemented X') as proof. Verify every claim against actual code changes, file contents, and observed command output.",
    hasTools
      ? "2. Use your read-only inspection tools (`git_diff`, `read_file`, `git_status`, `list_files`, `read_terminal`) to inspect the actual modified files, tests, and terminal output before approving. Do not guess or invent file paths, line numbers, or test results you did not observe."
      : "2. Base your judgment strictly on the provided diff, git status/log, CI summary, and terminal output. Do not invent file paths, line numbers, or test results not present in the evidence.",
    "3. Check for fabrication, stubs, and reward hacking:",
    "   - Missing or partial implementation of the task, subitems, or Definition of Done.",
    "   - Placeholder code (`TODO`, `FIXME`, `NotImplemented`, empty handlers, hardcoded fake returns, silent error swallowing).",
    "   - Test cheating: skipped/disabled tests (`test.skip`, `xit`), deleted assertions, trivial assertions, or claiming tests passed when terminal output shows failures or no test run after the last edit.",
    "   - Uncommitted/broken state or backlog status mismatch when the task is claimed done.",
    "4. Choose exactly one verdict:",
    '   - "completed": verified against real diff/files/terminal output; requirements and checks are genuinely satisfied with no pending CI wait.',
    '   - "waiting_ci": changes look solid and were pushed/triggered CI, and CI checks are still running.',
    '   - "needs_fix": concrete defects, missing requirements, stubs, failing/missing tests, or unverified/fabricated claims were found that the agent must fix.',
    '   - "needs_user": the agent is asking the user a question, needs credentials/approval, or evidence is genuinely ambiguous.',
    '   - "failed": fatal unrecoverable error or aborted run.',
    "",
    "Respond strictly with a single JSON object (reason and issues in Russian):",
    '{"verdict":"completed|waiting_ci|needs_fix|needs_user|failed","reason":"concise verdict summary in Russian","evidence":["concrete file:line or observed command output"],"issues":["specific actionable defect to fix if verdict is needs_fix"],"ci_ref":"optional branch or PR ref"}',
  ].join("\n");

  const parts = [];
  if (epic) {
    parts.push(`Epic: ${epic.id ?? ""} — ${epic.title ?? ""}`.trim());
    if (epic.goal) {
      parts.push(`Epic Goal:\n${tailText(epic.goal, 1500)}`);
    }
    if (epic.dod) {
      parts.push(`Definition of Done:\n${tailText(epic.dod, 2000)}`);
    }
  }
  if (task) {
    parts.push(`Assigned Task: ${task.id ?? ""} — ${task.title ?? ""}`.trim());
    if (Array.isArray(task.subitems) && task.subitems.length > 0) {
      parts.push(`Subitems:\n${task.subitems.map((s) => `- ${s}`).join("\n")}`);
    }
  }

  const cleanTail = tailText(stripAnsi(terminalTail), 8000).trim();
  parts.push(`Terminal tail:\n${cleanTail || "(empty)"}`);

  if (gitStatus && String(gitStatus).trim()) {
    parts.push(`Git status:\n${tailText(String(gitStatus).trim(), 2500)}`);
  }
  if (gitLog && String(gitLog).trim()) {
    parts.push(`Git log:\n${tailText(String(gitLog).trim(), 2500)}`);
  }
  if (gitDiff && String(gitDiff).trim()) {
    parts.push(`Git diff snapshot:\n${tailText(String(gitDiff).trim(), 10000)}`);
  }
  if (ciSummary && String(ciSummary).trim()) {
    parts.push(`CI summary:\n${tailText(String(ciSummary).trim(), 1500)}`);
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: parts.join("\n\n") },
  ];
}

async function postChatCompletion(url, headers, body, fetchFn) {
  return fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function runSingleShotClassification(url, headers, model, messages, maxTokens, fetchFn) {
  const sendRequest = (withResponseFormat) => {
    const body = {
      model,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
    };
    if (withResponseFormat) {
      body.response_format = { type: "json_object" };
    }
    return postChatCompletion(url, headers, body, fetchFn);
  };

  let res = await sendRequest(true);
  if (res.status === 400 || res.status === 422) {
    await res.body?.cancel?.().catch(() => {});
    res = await sendRequest(false);
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Classifier request failed (HTTP ${res.status}): ${detail}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  return parseClassifierVerdict(content);
}

export async function classifySessionTurn(
  cfg,
  ctx,
  fetchFn = fetch,
  toolExecutor = null,
  onProgress = null,
) {
  const baseUrl = normalizeBaseUrl(cfg?.baseUrl);
  if (!baseUrl) {
    throw new Error("Base URL is required");
  }
  const model = typeof cfg?.model === "string" ? cfg.model.trim() : "";
  if (!model) {
    throw new Error("Model is required");
  }

  const url = `${baseUrl}/chat/completions`;
  const headers = buildHeaders(cfg?.apiKey, {
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  const isReviewer = ctx?.reviewMode === "reviewer";
  if (!isReviewer) {
    const messages = buildClassifierMessages(ctx);
    return runSingleShotClassification(url, headers, model, messages, 400, fetchFn);
  }

  const hasTools = typeof toolExecutor === "function";
  const messages = buildReviewerMessages(ctx, hasTools);
  if (!hasTools) {
    return runSingleShotClassification(url, headers, model, messages, 1000, fetchFn);
  }

  let useResponseFormat = true;
  for (let round = 0; round < MAX_REVIEW_TOOL_ROUNDS; round++) {
    const body = {
      model,
      messages,
      temperature: 0,
      max_tokens: 1000,
      tools: REVIEWER_TOOLS,
      tool_choice: "auto",
    };
    if (useResponseFormat) {
      body.response_format = { type: "json_object" };
    }

    let res = await postChatCompletion(url, headers, body, fetchFn);
    if ((res.status === 400 || res.status === 422) && useResponseFormat) {
      await res.body?.cancel?.().catch(() => {});
      useResponseFormat = false;
      delete body.response_format;
      res = await postChatCompletion(url, headers, body, fetchFn);
    }

    if (res.status === 400 || res.status === 422) {
      await res.body?.cancel?.().catch(() => {});
      const fallbackMessages = buildReviewerMessages(ctx, false);
      return runSingleShotClassification(url, headers, model, fallbackMessages, 1000, fetchFn);
    }

    if (!res.ok) {
      const detail = await readErrorDetail(res);
      throw new Error(`Reviewer request failed (HTTP ${res.status}): ${detail}`);
    }

    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];

    if (toolCalls.length === 0) {
      return parseClassifierVerdict(msg?.content ?? "");
    }

    messages.push({
      role: "assistant",
      content: msg?.content ?? null,
      tool_calls: toolCalls,
    });

    for (const tc of toolCalls) {
      const fnName = tc?.function?.name ?? "";
      let parsedArgs = {};
      try {
        const rawArgs = tc?.function?.arguments;
        parsedArgs = typeof rawArgs === "string" && rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch {
        parsedArgs = {};
      }
      if (typeof onProgress === "function") {
        const argHint = parsedArgs?.path || parsedArgs?.target || parsedArgs?.dir || "";
        onProgress(argHint ? `${fnName}(${argHint})` : fnName);
      }
      const toolOutput = await toolExecutor(fnName, parsedArgs);
      messages.push({
        role: "tool",
        tool_call_id: tc?.id ?? `call_${round}`,
        content: String(toolOutput ?? ""),
      });
    }
  }

  messages.push({
    role: "user",
    content:
      "Tool inspection budget reached. Return your final JSON verdict now based strictly on the evidence observed so far.",
  });
  return runSingleShotClassification(url, headers, model, messages, 1000, fetchFn);
}
