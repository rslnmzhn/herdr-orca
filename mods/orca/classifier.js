// Pure OpenAI-compatible classifier & adversarial reviewer client for Orca.
// Zero Herdr host/UI imports and zero Node APIs so it runs in both Herdr and bun test.

import { REVIEWER_TOOLS } from "./reviewer_tools.js";

const VALID_VERDICTS = new Set([
  "completed",
  "waiting_tests",
  "waiting_ci",
  "needs_fix",
  "needs_user",
  "failed",
]);
const VALID_CHECK_STATUSES = new Set(["pass", "partial", "fail", "na"]);
const MAX_REVIEW_TOOL_ROUNDS = 6;
const DEFAULT_RETRY_DELAYS_MS = [3000, 5000, 10000, 15000, 30000];
const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

export const DEFAULT_MIN_REVIEW_SCORE = 15;

export const BLOCKING_REVIEW_CHECKS = [
  {
    id: "requirements_met",
    label: "Требования задачи / DoD выполнены",
    promptRule:
      "All assigned task/epic requirements, subitems, DoD, or claims in the agent's turn are genuinely implemented.",
  },
  {
    id: "no_stubs",
    label: "Нет заглушек (TODO / фейков)",
    promptRule:
      "No TODO, FIXME, NotImplemented, empty handlers, or hardcoded fake returns.",
  },
  {
    id: "logic_edge_cases",
    label: "Логика и граничные случаи верны",
    promptRule:
      "Core logic and edge cases (null/empty/bounds/state transitions) are sound with no obvious bugs or regressions.",
  },
  {
    id: "security_safety",
    label: "Безопасность и сохранность данных",
    promptRule:
      "No hardcoded secrets, injection risks, path traversal, race conditions, or data loss.",
  },
  {
    id: "no_test_cheating",
    label: "Нет читерства с тестами",
    promptRule:
      "No skipped/disabled tests (test.skip, xit), deleted assertions, or tests rigged to pass on broken code.",
  },
  {
    id: "checks_passed",
    label: "Проверки затронутого слоя не падают",
    promptRule:
      "Relevant checks/tests for the modified layer pass (do NOT fail just because earlier unrelated steps scrolled past the 400-line terminal tail if no failure is observed).",
  },
];

export const OPTIONAL_REVIEW_CHECKS = [
  {
    id: "integration_wired",
    weight: 7,
    defaultEnabled: true,
    label: "Код подключён к точкам вызова",
    promptRule:
      "New code is actually wired into callers, UI, routes, or exports (not dead/unused code).",
  },
  {
    id: "error_handling",
    weight: 8,
    defaultEnabled: true,
    label: "Корректная обработка ошибок",
    promptRule:
      "Errors are propagated or handled explicitly without silent swallowing or broken state.",
  },
  {
    id: "tests_exist_and_meaningful",
    weight: 6,
    defaultEnabled: true,
    label: "Есть осмысленные тесты",
    promptRule:
      "Meaningful tests/checks cover the new or changed behavior (not trivial assertions).",
  },
  {
    id: "modularity_no_god_object",
    weight: 6,
    defaultEnabled: false,
    label: "Без God-class / монолитов",
    promptRule:
      "Changes stay modular without creating a God-class, God-service, or bloated monolithic function.",
  },
  {
    id: "no_duplication_or_bloat",
    weight: 5,
    defaultEnabled: false,
    label: "Без копипасты и лишнего кода",
    promptRule:
      "No copy-paste duplication, speculative abstractions, or unrelated refactoring outside task scope.",
  },
  {
    id: "readability_conventions",
    weight: 4,
    defaultEnabled: false,
    label: "Читаемость и стиль проекта",
    promptRule:
      "Clear naming, follows project conventions, no commented-out dead code.",
  },
  {
    id: "clean_diff_and_logs",
    weight: 5,
    defaultEnabled: false,
    label: "Чистый diff и логи",
    promptRule:
      "Clean diff with no debug leftovers, duplicate warning/error logs, or stray temporary files.",
  },
  {
    id: "repo_and_backlog_state",
    weight: 5,
    defaultEnabled: false,
    label: "Консистентный git и бэклог",
    promptRule:
      "git status is consistent and backlog/*.md status matches Kanban format when working on a backlog item.",
  },
];

const BLOCKING_CHECK_MAP = new Map(BLOCKING_REVIEW_CHECKS.map((c) => [c.id, c]));
const OPTIONAL_CHECK_MAP = new Map(OPTIONAL_REVIEW_CHECKS.map((c) => [c.id, c]));

export function getDefaultOptionalReviewChecks() {
  return OPTIONAL_REVIEW_CHECKS.filter((c) => c.defaultEnabled).map((c) => c.id);
}

export function normalizeOptionalReviewChecks(raw) {
  if (!Array.isArray(raw)) {
    return getDefaultOptionalReviewChecks();
  }
  const seen = new Set();
  const out = [];
  for (const id of raw) {
    if (typeof id === "string" && OPTIONAL_CHECK_MAP.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function getMaxOptionalReviewScore(enabledIds) {
  const normalized = normalizeOptionalReviewChecks(enabledIds);
  let total = 0;
  for (const id of normalized) {
    total += OPTIONAL_CHECK_MAP.get(id)?.weight ?? 0;
  }
  return total;
}

export function resolveMinReviewScore(rawValue, enabledIds) {
  const maxScore = getMaxOptionalReviewScore(enabledIds);
  if (maxScore <= 0) return 0;
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return Math.min(DEFAULT_MIN_REVIEW_SCORE, maxScore);
  }
  const parsed = Number(String(rawValue).trim());
  if (!Number.isFinite(parsed)) {
    return Math.min(DEFAULT_MIN_REVIEW_SCORE, maxScore);
  }
  return Math.max(0, Math.min(Math.floor(parsed), maxScore));
}

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

export function buildHeaders(apiKey, extra = {}) {
  const headers = { ...extra };
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

export async function readErrorDetail(res) {
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

export function extractMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part && typeof part === "object" && part.type !== "thinking")
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function tryParseJsonObject(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (!cleaned) return null;
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Try fenced or embedded JSON below.
  }

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
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

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Scan balanced JSON objects from the end in case earlier text had braces.
    }
  }

  let fallbackObj = null;
  for (let end = cleaned.lastIndexOf("}"); end !== -1; end = cleaned.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = end; i >= 0; i--) {
      const ch = cleaned[i];
      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
      } else if (ch === "}") {
        depth++;
      } else if (ch === "{") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(cleaned.slice(i, end + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              if (
                "state" in parsed ||
                "verdict" in parsed ||
                "checks" in parsed ||
                "action" in parsed ||
                "reason" in parsed
              ) {
                return parsed;
              }
              if (!fallbackObj) fallbackObj = parsed;
            }
          } catch {
            // Keep scanning earlier objects.
          }
          break;
        }
      }
    }
  }

  return fallbackObj;
}

function normalizeCheckStatus(raw) {
  const val = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (val === "pass" || val === "passed" || val === "ok") return "pass";
  if (val === "partial" || val === "warn") return "partial";
  if (val === "fail" || val === "failed") return "fail";
  if (val === "na" || val === "n/a") return "na";
  return null;
}

function parseCheckEntry(rawEntry) {
  if (typeof rawEntry === "string") {
    return { status: normalizeCheckStatus(rawEntry), note: "" };
  }
  if (rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)) {
    return {
      status: normalizeCheckStatus(rawEntry.status),
      note: typeof rawEntry.note === "string" ? rawEntry.note.trim() : "",
    };
  }
  return { status: null, note: "" };
}

export function evaluateReviewRubric(rawChecks, reviewConfig = {}) {
  const enabledOptionalIds = normalizeOptionalReviewChecks(reviewConfig?.optionalChecks);
  const enabledSet = new Set(enabledOptionalIds);
  const selectedMax = getMaxOptionalReviewScore(enabledOptionalIds);
  const minScore = resolveMinReviewScore(reviewConfig?.minReviewScore, enabledOptionalIds);
  const checksObj = rawChecks && typeof rawChecks === "object" && !Array.isArray(rawChecks) ? rawChecks : {};

  const checks = {};
  const failedBlocking = [];
  const failedOptional = [];
  const partialOptional = [];

  for (const def of BLOCKING_REVIEW_CHECKS) {
    const parsed = parseCheckEntry(checksObj[def.id]);
    const status = parsed.status ?? "na";
    checks[def.id] = {
      id: def.id,
      label: def.label,
      blocking: true,
      weight: 0,
      status,
      note: parsed.note,
    };
    if (status === "fail" || status === "partial") {
      failedBlocking.push({
        id: def.id,
        label: def.label,
        status,
        note: parsed.note,
      });
    }
  }

  let earned = 0;
  let applicableMax = 0;

  for (const def of OPTIONAL_REVIEW_CHECKS) {
    if (!enabledSet.has(def.id)) continue;
    const parsed = parseCheckEntry(checksObj[def.id]);
    const status = parsed.status ?? "fail";
    checks[def.id] = {
      id: def.id,
      label: def.label,
      blocking: false,
      weight: def.weight,
      status,
      note: parsed.note,
    };
    if (status === "na") continue;
    applicableMax += def.weight;
    if (status === "pass") {
      earned += def.weight;
    } else if (status === "partial") {
      earned += def.weight * 0.5;
      partialOptional.push({
        id: def.id,
        label: def.label,
        weight: def.weight,
        note: parsed.note,
      });
    } else {
      failedOptional.push({
        id: def.id,
        label: def.label,
        weight: def.weight,
        note: parsed.note,
      });
    }
  }

  const earnedRounded = Number.isInteger(earned) ? earned : Number(earned.toFixed(1));
  const effectiveThreshold =
    selectedMax <= 0 || applicableMax <= 0
      ? 0
      : applicableMax === selectedMax
        ? minScore
        : Math.round((minScore * applicableMax) / selectedMax);

  const blockingPassed = failedBlocking.length === 0;
  const scorePassed = applicableMax <= 0 || earnedRounded >= effectiveThreshold;
  const passed = blockingPassed && scorePassed;

  return {
    passed,
    blockingPassed,
    scorePassed,
    earned: earnedRounded,
    applicableMax,
    selectedMax,
    minScore,
    effectiveThreshold,
    failedBlocking,
    failedOptional,
    partialOptional,
    checks,
  };
}

export function parseClassifierVerdict(rawText, reviewConfig = null) {
  const text = String(rawText ?? "").trim();
  const obj = tryParseJsonObject(text);
  if (!obj) {
    return {
      verdict: "needs_user",
      reason: "Не удалось разобрать ответ классификатора",
    };
  }

  const rawState = typeof obj.state === "string" ? obj.state.trim().toLowerCase() : "";
  const rawVerdict = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
  const hasChecks = obj.checks && typeof obj.checks === "object" && !Array.isArray(obj.checks);
  const rawReason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim()
      : typeof obj.summary === "string" && obj.summary.trim()
        ? obj.summary.trim()
        : "";

  if (!rawState && !rawVerdict && !hasChecks && !rawReason) {
    return {
      verdict: "needs_user",
      reason: "Не удалось разобрать ответ классификатора",
    };
  }

  const processState =
    rawState === "waiting_ci" ||
    rawState === "waiting_tests" ||
    rawState === "needs_user" ||
    rawState === "failed"
      ? rawState
      : rawVerdict === "waiting_ci" ||
          rawVerdict === "waiting_tests" ||
          rawVerdict === "needs_user" ||
          rawVerdict === "failed"
        ? rawVerdict
        : null;

  const reason = rawReason || "Классификатор не указал причину";
  const fallbackVerdict = VALID_VERDICTS.has(rawVerdict)
    ? rawVerdict
    : VALID_VERDICTS.has(rawState)
      ? rawState
      : "needs_user";

  const result = {
    verdict: processState ?? fallbackVerdict,
    reason,
  };

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

  if (!processState && obj.checks && typeof obj.checks === "object" && !Array.isArray(obj.checks)) {
    const hasKnownCheck = Object.keys(obj.checks).some(
      (k) => BLOCKING_CHECK_MAP.has(k) || OPTIONAL_CHECK_MAP.has(k),
    );
    if (hasKnownCheck) {
      const rubric = evaluateReviewRubric(obj.checks, reviewConfig ?? {});
      result.verdict = rubric.passed ? "completed" : "needs_fix";
      result.review = rubric;
      if (!rubric.passed && (!result.issues || result.issues.length === 0)) {
        const autoIssues = [];
        for (const b of rubric.failedBlocking) {
          autoIssues.push(`[Блокер: ${b.label}] ${b.note || "требуется исправление"}`);
        }
        for (const o of rubric.failedOptional) {
          autoIssues.push(`[${o.label}, -${o.weight} б.] ${o.note || "не выполнено"}`);
        }
        for (const p of rubric.partialOptional) {
          autoIssues.push(`[${p.label}, частично] ${p.note || "требуется доработка"}`);
        }
        if (autoIssues.length > 0) {
          result.issues = autoIssues;
        }
      }
    }
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
    '- "completed": the assigned task/epic is finished and verified, with no pending tests, CI wait, or user question.',
    '- "waiting_tests": the agent started local tests/build/checks (or is waiting for a local test run to finish) and has NOT pushed to remote CI.',
    '- "waiting_ci": the agent pushed changes or triggered remote CI (GitHub Actions / PR checks) and is waiting for remote CI to complete.',
    '- "needs_user": the agent is asking the user a question, requesting approval/input, or the outcome is unclear.',
    '- "failed": the agent hit a fatal error, aborted, or left failing tests/build without continuing.',
    'Respond strictly with a single JSON object: {"verdict":"completed|waiting_tests|waiting_ci|needs_user|failed","reason":"concise explanation","ci_ref":"optional branch or PR ref"}.',
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

function formatReviewHistoryForPrompt(reviewHistory) {
  if (!Array.isArray(reviewHistory) || reviewHistory.length === 0) return "";
  const lines = [];
  for (const entry of reviewHistory) {
    if (!entry || typeof entry !== "object") continue;
    const attemptNum = entry.attempt ?? "?";
    const scorePart = entry.review
      ? ` | optional score: ${entry.review.earned}/${entry.review.applicableMax} (threshold ${entry.review.effectiveThreshold})`
      : "";
    lines.push(`Attempt #${attemptNum}: verdict=${entry.verdict ?? "unknown"}${scorePart}`);
    if (entry.reason) {
      lines.push(`  Reason: ${entry.reason}`);
    }
    if (entry.review?.checks && typeof entry.review.checks === "object") {
      const nonPass = Object.values(entry.review.checks)
        .filter((c) => c && c.status !== "pass" && c.status !== "na")
        .map((c) => `${c.id}=${c.status}${c.note ? ` (${c.note})` : ""}`);
      const passedIds = Object.values(entry.review.checks)
        .filter((c) => c && c.status === "pass")
        .map((c) => c.id);
      if (passedIds.length > 0) {
        lines.push(`  Passed checks: ${passedIds.join(", ")}`);
      }
      if (nonPass.length > 0) {
        lines.push(`  Failed/partial checks: ${nonPass.join("; ")}`);
      }
    }
    if (Array.isArray(entry.issues) && entry.issues.length > 0) {
      lines.push(`  Issues reported: ${entry.issues.join(" | ")}`);
    }
  }
  return lines.join("\n");
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
    reviewConfig = null,
    reviewAttempt = 1,
    reviewHistory = [],
  } = ctx ?? {};

  const enabledOptionalIds = normalizeOptionalReviewChecks(reviewConfig?.optionalChecks);
  const enabledSet = new Set(enabledOptionalIds);
  const enabledOptionalDefs = OPTIONAL_REVIEW_CHECKS.filter((c) => enabledSet.has(c.id));
  const maxOptionalScore = getMaxOptionalReviewScore(enabledOptionalIds);
  const minScore = resolveMinReviewScore(reviewConfig?.minReviewScore, enabledOptionalIds);

  const blockingLines = BLOCKING_REVIEW_CHECKS.map(
    (c) => `   - "${c.id}" [BLOCKING]: ${c.promptRule}`,
  );
  const optionalLines =
    enabledOptionalDefs.length > 0
      ? enabledOptionalDefs.map(
          (c) => `   - "${c.id}" (+${c.weight} pts): ${c.promptRule}`,
        )
      : [
          "   - (None enabled — minimum strictness mode: evaluate ONLY the mandatory blocking checks above.)",
        ];

  const systemPrompt = [
    "You are an independent, skeptical senior code reviewer and verification auditor.",
    "Your job is to verify whether the coding agent genuinely completed the assigned task/epic with real, working code — or whether it fabricated results, took shortcuts, left stubs, or missed requirements.",
    "",
    "Core verification rules (anti-hallucination, anti-reward-hacking, anti-loop):",
    "1. NEVER treat the coding agent's own summary or claims ('done', 'all tests pass', 'implemented X') as proof. Verify every claim against actual code changes, file contents, and observed command output.",
    hasTools
      ? "2. Use your read-only inspection tools (`git_diff`, `read_file`, `git_status`, `list_files`, `read_terminal`) to inspect the actual modified files, tests, saved verification logs, and terminal output before approving. Do not guess or invent file paths, line numbers, or test results you did not observe."
      : "2. Base your judgment strictly on the provided diff, git status/log, CI summary, and terminal output. Do not invent file paths, line numbers, or test results not present in the evidence.",
    "3. Avoid false rejections and endless review loops:",
    "   - Only require fresh test/build runs for the layer actually modified in the latest changes. Do NOT fail `checks_passed` merely because earlier unrelated build/test steps scrolled past the 400-line terminal tail when no failure is observed; check saved log files via `list_files` + `read_file` if present.",
    "   - Do NOT invent requirements outside the assigned task/DoD/agent's stated scope, and do NOT penalize pre-existing untouched code.",
    "   - On retry attempts (attempt > 1), check `Previous review history` first: verify whether previously reported issues were fixed, and do NOT flip previously `pass` checks to `fail` unless the new diff introduced a regression in them.",
    "",
    "4. Evaluate the structured rubric below. The host computes the final score and pass/fail verdict deterministically from your `checks`:",
    "   Mandatory BLOCKING checks (rate strictly as `pass` or `fail`, or `na` only if genuinely inapplicable):",
    ...blockingLines,
    "",
    enabledOptionalDefs.length > 0
      ? `   Optional strictness checks (rate as \`pass\` = 100%, \`partial\` = 50%, \`fail\` = 0%, or \`na\` if inapplicable; required threshold: ${minScore}/${maxOptionalScore} pts):`
      : "   Optional strictness checks:",
    ...optionalLines,
    "",
    "5. Choose `state`:",
    '   - "reviewed": you completed the rubric evaluation above (host decides completed vs needs_fix from `checks`).',
    '   - "waiting_tests": the agent started local tests/build/checks (or is waiting for a local test run to finish) and has NOT pushed to remote CI.',
    '   - "waiting_ci": changes look solid and were pushed/triggered remote CI (GitHub Actions / PR checks), and remote CI checks are still running.',
    '   - "needs_user": the agent is asking the user a question, needs credentials/approval, or evidence is genuinely ambiguous.',
    '   - "failed": fatal unrecoverable error or aborted run.',
    "",
    "Respond strictly with a single JSON object (reason, check notes, and issues in Russian):",
    '{"state":"reviewed|waiting_tests|waiting_ci|needs_user|failed","reason":"concise verdict summary in Russian","checks":{"<check_id>":{"status":"pass|partial|fail|na","note":"short factual note in Russian"}},"evidence":["concrete file:line or observed command output"],"issues":["specific actionable defect to fix if any check failed or scored partial"],"ci_ref":"optional branch or PR ref"}',
  ].join("\n");

  const parts = [];
  if (epic) {
    parts.push(`Epic: ${epic.id ?? ""} — ${epic.title ?? ""}`.trim());
    if (epic.goal) {
      parts.push(`Epic Goal:\n${tailText(epic.goal, 2000)}`);
    }
    if (epic.dod) {
      parts.push(`Definition of Done:\n${tailText(epic.dod, 2500)}`);
    }
  }
  if (task) {
    parts.push(`Assigned Task: ${task.id ?? ""} — ${task.title ?? ""}`.trim());
    if (Array.isArray(task.subitems) && task.subitems.length > 0) {
      parts.push(`Subitems:\n${task.subitems.map((s) => `- ${s}`).join("\n")}`);
    }
  }

  if (!epic && !task) {
    parts.push(
      "Review mode: standalone review of the agent's latest turn/changes (no backlog epic/task attached). Verify the agent's claims in the terminal output against actual code changes and tests.",
    );
  }

  parts.push(`Current review attempt: #${reviewAttempt}`);
  const historyText = formatReviewHistoryForPrompt(reviewHistory);
  if (historyText) {
    parts.push(`Previous review history (do not forget prior findings or regress passed checks):\n${tailText(historyText, 6000)}`);
  }

  const cleanTail = tailText(stripAnsi(terminalTail), 14000).trim();
  parts.push(`Terminal tail:\n${cleanTail || "(empty)"}`);

  if (gitStatus && String(gitStatus).trim()) {
    parts.push(`Git status:\n${tailText(String(gitStatus).trim(), 3500)}`);
  }
  if (gitLog && String(gitLog).trim()) {
    parts.push(`Git log:\n${tailText(String(gitLog).trim(), 3500)}`);
  }
  if (gitDiff && String(gitDiff).trim()) {
    parts.push(`Git diff snapshot:\n${tailText(String(gitDiff).trim(), 18000)}`);
  }
  if (ciSummary && String(ciSummary).trim()) {
    parts.push(`CI summary:\n${tailText(String(ciSummary).trim(), 2000)}`);
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: parts.join("\n\n") },
  ];
}

function defaultSleep(ms) {
  if (typeof globalThis.setTimeout === "function") {
    return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
  }
  return Promise.resolve();
}

async function sleepWithAbort(ms, sleepFn, shouldAbort) {
  let remaining = Math.max(0, Number(ms) || 0);
  while (remaining > 0) {
    if (shouldAbort?.()) {
      const err = new Error("Aborted");
      err.aborted = true;
      throw err;
    }
    const step = Math.min(remaining, 500);
    await sleepFn(step);
    remaining -= step;
  }
  if (shouldAbort?.()) {
    const err = new Error("Aborted");
    err.aborted = true;
    throw err;
  }
}

async function postChatCompletion(url, headers, body, fetchFn) {
  return fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function raceWithTimeout(promise, timeoutMs, timeoutFn) {
  if (!(timeoutMs > 0)) return promise;
  let settled = false;
  let timerId = null;
  const timeoutPromise =
    typeof timeoutFn === "function"
      ? timeoutFn(timeoutMs).then(() => {
          if (!settled) {
            throw new Error(`Request timeout after ${Math.max(1, Math.round(timeoutMs / 1000))}s`);
          }
        })
      : typeof globalThis.setTimeout === "function"
        ? new Promise((_, reject) => {
            timerId = globalThis.setTimeout(() => {
              if (!settled) {
                reject(new Error(`Request timeout after ${Math.max(1, Math.round(timeoutMs / 1000))}s`));
              }
            }, timeoutMs);
          })
        : null;

  if (!timeoutPromise) return promise;
  timeoutPromise.catch(() => {});
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    settled = true;
    if (timerId !== null && typeof globalThis.clearTimeout === "function") {
      globalThis.clearTimeout(timerId);
    }
  }
}

export async function postAndParseJson(url, headers, body, fetchFn, options = {}) {
  const waitOnError = Boolean(options?.waitOnError);
  const sleepFn = typeof options?.sleepFn === "function" ? options.sleepFn : defaultSleep;
  const timeoutFn = typeof options?.timeoutFn === "function" ? options.timeoutFn : null;
  const shouldAbort = typeof options?.shouldAbort === "function" ? options.shouldAbort : null;
  const onRetry = typeof options?.onRetry === "function" ? options.onRetry : null;
  const timeoutMs =
    Number.isFinite(Number(options?.timeoutMs)) && Number(options.timeoutMs) >= 0
      ? Number(options.timeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;
  const delays =
    Array.isArray(options?.retryDelaysMs) && options.retryDelaysMs.length > 0
      ? options.retryDelaysMs
      : DEFAULT_RETRY_DELAYS_MS;

  let attempt = 0;
  for (;;) {
    if (shouldAbort?.()) {
      const err = new Error("Aborted");
      err.aborted = true;
      throw err;
    }

    try {
      const fetchPromise = postChatCompletion(url, headers, body, fetchFn);
      const res = waitOnError
        ? await raceWithTimeout(fetchPromise, timeoutMs, timeoutFn)
        : await fetchPromise;

      if (shouldAbort?.()) {
        await res.body?.cancel?.().catch(() => {});
        const err = new Error("Aborted");
        err.aborted = true;
        throw err;
      }

      if (res.status === 400 || res.status === 422) {
        return { res, data: null };
      }

      if (!res.ok) {
        const detail = await readErrorDetail(res);
        const err = new Error(`Classifier request failed (HTTP ${res.status}): ${detail}`);
        if (res.status === 401 || res.status === 403) {
          err.nonRetryable = true;
        }
        throw err;
      }

      const data = await res.json();
      return { res, data };
    } catch (err) {
      if (err?.aborted || shouldAbort?.()) {
        const abortErr = new Error("Aborted");
        abortErr.aborted = true;
        throw abortErr;
      }
      if (!waitOnError || err?.nonRetryable) {
        throw err;
      }
      attempt += 1;
      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)];
      const reason = String(err?.message ?? err);
      onRetry?.({ attempt, delayMs, reason });
      await sleepWithAbort(delayMs, sleepFn, shouldAbort);
    }
  }
}

async function runSingleShotClassification(
  url,
  headers,
  model,
  messages,
  maxTokens,
  fetchFn,
  options = {},
  reviewConfig = null,
) {
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
    return postAndParseJson(url, headers, body, fetchFn, options);
  };

  let { res, data } = await sendRequest(true);
  if (res.status === 400 || res.status === 422) {
    await res.body?.cancel?.().catch(() => {});
    ({ res, data } = await sendRequest(false));
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Classifier request failed (HTTP ${res.status}): ${detail}`);
  }

  let choice = data?.choices?.[0];
  let content = extractMessageContent(choice?.message?.content);
  if (choice?.finish_reason === "length" && !tryParseJsonObject(content)) {
    const retryBody = {
      model,
      messages: [
        ...messages,
        {
          role: "user",
          content: "Output ONLY the final JSON object now with concise notes.",
        },
      ],
      temperature: 0,
      max_tokens: Math.max(maxTokens * 2, 16384),
    };
    const retry = await postAndParseJson(url, headers, retryBody, fetchFn, options);
    if (retry.res.ok) {
      content = extractMessageContent(retry.data?.choices?.[0]?.message?.content);
    } else {
      await retry.res.body?.cancel?.().catch(() => {});
    }
  }
  return parseClassifierVerdict(content, reviewConfig);
}

export function parseChatAutoResponse(rawText) {
  const text = String(rawText ?? "").trim();
  const obj = tryParseJsonObject(text);
  if (!obj) {
    return {
      action: "escalate",
      reply: "",
      reason: "Не удалось разобрать ответ авто-классификатора",
    };
  }

  const rawAction = typeof obj.action === "string" ? obj.action.trim().toLowerCase() : "";
  const hasReply = typeof obj.reply === "string";
  const action = rawAction === "respond" && hasReply ? "respond" : "escalate";
  const reply = hasReply ? obj.reply : "";
  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim()
      : action === "respond"
        ? "Авто-ответ классификатора"
        : "Требуется решение пользователя";

  return { action, reply, reason };
}

export async function classifyChatRequest(cfg, ctx, fetchFn = fetch, options = {}) {
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

  const systemPrompt = [
    "You are an auto-mode safety & chat-request classifier for an autonomous coding agent (like Claude CLI auto-mode).",
    "The agent in the terminal is paused waiting for user confirmation, tool permission, or an answer to a question.",
    "Decide whether to auto-respond safely or escalate to the human user.",
    "",
    "Respond with action='respond' ONLY when the request is safe and within the current task scope:",
    "- Routine tool/permission prompts: reading/editing project files, running tests/linters/builds, git status/diff/add/commit on a feature branch, installing project dependencies.",
    "- Straightforward technical or clarifying questions that can be answered directly from the task context.",
    "",
    "Respond with action='escalate' when:",
    "- Destructive or irreversible actions: rm -rf outside project, git push --force, dropping databases, modifying system files/secrets/credentials, billing/external deploys.",
    "- Product, UX, or architectural decisions that genuinely require human preference.",
    "- The terminal prompt is unclear or you are not confident what input is expected.",
    "",
    "For 'reply':",
    "- For numbered confirmation menus (e.g. '1. Yes', '2. Yes, allow...'), use '1' (or '' if Enter alone confirms the highlighted default).",
    "- For [Y/n] or (y/n) prompts, use 'y'.",
    "- For chat questions, write a concise, direct answer in the language of the conversation.",
    "",
    'Respond strictly with a single JSON object: {"action":"respond|escalate","reply":"text to send","reason":"short explanation in Russian"}.',
  ].join("\n");

  const userParts = [
    `Trigger: ${ctx?.trigger || "blocked"}`,
    ctx?.reason ? `Reviewer note: ${ctx.reason}` : null,
    ctx?.epicTitle ? `Epic: ${ctx.epicTitle}` : null,
    ctx?.taskTitle ? `Task: ${ctx.taskTitle}` : null,
    ctx?.taskBody ? `Task details:\n${String(ctx.taskBody).slice(0, 1500)}` : null,
    `Recent terminal output:\n${String(ctx?.terminalOutput ?? "").slice(-6000)}`,
  ].filter(Boolean);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userParts.join("\n\n") },
  ];

  const sendRequest = (withResponseFormat) => {
    const body = {
      model,
      messages,
      temperature: 0,
      max_tokens: 1500,
    };
    if (withResponseFormat) {
      body.response_format = { type: "json_object" };
    }
    return postAndParseJson(url, headers, body, fetchFn, options);
  };

  let { res, data } = await sendRequest(true);
  if (res.status === 400 || res.status === 422) {
    await res.body?.cancel?.().catch(() => {});
    ({ res, data } = await sendRequest(false));
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Auto-responder request failed (HTTP ${res.status}): ${detail}`);
  }

  const content = extractMessageContent(data?.choices?.[0]?.message?.content);
  return parseChatAutoResponse(content);
}

export async function classifySessionTurn(
  cfg,
  ctx,
  fetchFn = fetch,
  toolExecutor = null,
  onProgress = null,
  options = {},
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
    return runSingleShotClassification(url, headers, model, messages, 400, fetchFn, options, null);
  }

  const reviewConfig = ctx?.reviewConfig ?? null;
  const hasTools = typeof toolExecutor === "function";
  const messages = buildReviewerMessages(ctx, hasTools);
  if (!hasTools) {
    return runSingleShotClassification(
      url,
      headers,
      model,
      messages,
      8192,
      fetchFn,
      options,
      reviewConfig,
    );
  }

  let useResponseFormat = true;
  for (let round = 0; round < MAX_REVIEW_TOOL_ROUNDS; round++) {
    const body = {
      model,
      messages,
      temperature: 0,
      max_tokens: 8192,
      tools: REVIEWER_TOOLS,
      tool_choice: "auto",
    };
    if (useResponseFormat) {
      body.response_format = { type: "json_object" };
    }

    let { res, data } = await postAndParseJson(url, headers, body, fetchFn, options);
    if ((res.status === 400 || res.status === 422) && useResponseFormat) {
      await res.body?.cancel?.().catch(() => {});
      useResponseFormat = false;
      delete body.response_format;
      ({ res, data } = await postAndParseJson(url, headers, body, fetchFn, options));
    }

    if (res.status === 400 || res.status === 422) {
      await res.body?.cancel?.().catch(() => {});
      const fallbackMessages = buildReviewerMessages(ctx, false);
      return runSingleShotClassification(
        url,
        headers,
        model,
        fallbackMessages,
        8192,
        fetchFn,
        options,
        reviewConfig,
      );
    }

    if (!res.ok) {
      const detail = await readErrorDetail(res);
      throw new Error(`Reviewer request failed (HTTP ${res.status}): ${detail}`);
    }

    const choice = data?.choices?.[0];
    const msg = choice?.message;
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];

    if (toolCalls.length === 0) {
      const content = extractMessageContent(msg?.content);
      if (choice?.finish_reason === "length" && !tryParseJsonObject(content)) {
        messages.push({
          role: "user",
          content: "Output ONLY the final JSON object now with concise notes.",
        });
        return runSingleShotClassification(
          url,
          headers,
          model,
          messages,
          16384,
          fetchFn,
          options,
          reviewConfig,
        );
      }
      return parseClassifierVerdict(content, reviewConfig);
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
  return runSingleShotClassification(
    url,
    headers,
    model,
    messages,
    8192,
    fetchFn,
    options,
    reviewConfig,
  );
}

export function parseBlockedCheckResponse(rawText) {
  const text = extractMessageContent(rawText).trim();
  const obj = tryParseJsonObject(text);
  if (!obj) {
    return {
      actionable: false,
      reason: "Не удалось определить, снята ли блокировка задачи",
    };
  }
  const actionable = obj.actionable === true;
  const reason =
    typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim()
      : actionable
        ? "Блокировка снята, задачу можно выполнять"
        : "Задача всё ещё заблокирована";
  return { actionable, reason };
}

export async function checkBlockedItemActionable(cfg, ctx, fetchFn = fetch, options = {}) {
  const baseUrl = normalizeBaseUrl(cfg?.baseUrl);
  const model = typeof cfg?.model === "string" ? cfg.model.trim() : "";
  if (!baseUrl || !model) {
    return {
      actionable: false,
      reason: "Нет настроенной модели для проверки разблокировки BLOCKED-задачи",
    };
  }

  const url = `${baseUrl}/chat/completions`;
  const headers = buildHeaders(cfg?.apiKey, {
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  const epic = ctx?.epic ?? null;
  const task = ctx?.task ?? null;
  const epicsSummary = Array.isArray(ctx?.epics)
    ? ctx.epics
        .map((e) => `${e.id} [${e.status}]: ${e.title}`)
        .slice(0, 40)
        .join("\n")
    : "";

  const systemPrompt = [
    "You check whether a backlog item currently marked BLOCKED can now be executed by an autonomous coding agent.",
    "Return actionable=true ONLY if the blocker appears resolved (e.g. a prerequisite epic/task is now done, or the code/git state shows the dependency is ready).",
    "Return actionable=false if the item still depends on an unfinished/blocked task, missing credentials/secrets, external manual action, or an unresolved blocker.",
    'Respond strictly with a single JSON object: {"actionable":true|false,"reason":"short explanation in Russian"}.',
  ].join("\n");

  const userParts = [
    epic ? `Epic: ${epic.id ?? ""} [${epic.status ?? ""}] — ${epic.title ?? ""}` : null,
    epic?.goal ? `Epic Goal:\n${tailText(epic.goal, 1500)}` : null,
    epic?.dod ? `Definition of Done:\n${tailText(epic.dod, 1500)}` : null,
    task ? `Task: ${task.id ?? ""} [${task.status ?? ""}] — ${task.title ?? ""}` : null,
    Array.isArray(task?.subitems) && task.subitems.length > 0
      ? `Subitems:\n${task.subitems.map((s) => `- ${s}`).join("\n")}`
      : null,
    epicsSummary ? `All epics status:\n${epicsSummary}` : null,
    ctx?.gitStatus ? `Git status:\n${tailText(String(ctx.gitStatus), 1500)}` : null,
    ctx?.gitLog ? `Recent git log:\n${tailText(String(ctx.gitLog), 1500)}` : null,
  ].filter(Boolean);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userParts.join("\n\n") },
  ];

  const sendRequest = (withResponseFormat) => {
    const body = {
      model,
      messages,
      temperature: 0,
      max_tokens: 1000,
    };
    if (withResponseFormat) {
      body.response_format = { type: "json_object" };
    }
    return postAndParseJson(url, headers, body, fetchFn, options);
  };

  let { res, data } = await sendRequest(true);
  if (res.status === 400 || res.status === 422) {
    await res.body?.cancel?.().catch(() => {});
    ({ res, data } = await sendRequest(false));
  }

  if (!res.ok) {
    const detail = await readErrorDetail(res);
    throw new Error(`Blocked check failed (HTTP ${res.status}): ${detail}`);
  }

  return parseBlockedCheckResponse(data?.choices?.[0]?.message?.content);
}
