// Pure OpenAI-compatible classifier client for Orca.
// Zero Herdr host/UI imports and zero Node APIs so it runs in both Herdr and bun test.

const VALID_VERDICTS = new Set(["completed", "waiting_ci", "needs_user", "failed"]);

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

export async function classifySessionTurn(cfg, ctx, fetchFn = fetch) {
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
  const messages = buildClassifierMessages(ctx);

  const sendRequest = (withResponseFormat) => {
    const body = {
      model,
      messages,
      temperature: 0,
      max_tokens: 400,
    };
    if (withResponseFormat) {
      body.response_format = { type: "json_object" };
    }
    return fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  };

  let res = await sendRequest(true);
  if (res.status === 400) {
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
