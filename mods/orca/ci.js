// Pure GitHub CI/CD inspector and retry policy for Orca.
// Zero Herdr host/UI imports and zero Node APIs so it runs in both Herdr and bun test.

const MAX_LOG_LINES = 120;
const MAX_LOG_CHARS = 6000;

const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

const SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

const FAILURE_CHECK_STATES = new Set([
  "failure",
  "error",
  "timed_out",
  "action_required",
  "startup_failure",
  "cancelled",
]);

const PENDING_CHECK_STATES = new Set([
  "pending",
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "expected",
]);

function classifyRun(run) {
  const status = String(run?.status ?? "").toLowerCase();
  const conclusion = String(run?.conclusion ?? "").toLowerCase();

  if (status !== "completed") {
    return "pending";
  }
  if (FAILURE_CONCLUSIONS.has(conclusion)) {
    return "failure";
  }
  if (SUCCESS_CONCLUSIONS.has(conclusion)) {
    return "success";
  }
  return conclusion ? "failure" : "pending";
}

function classifyPrCheck(check) {
  const bucket = String(check?.bucket ?? "").toLowerCase();
  if (bucket === "fail" || bucket === "cancel") return "failure";
  if (bucket === "pending") return "pending";
  if (bucket === "pass" || bucket === "skipping") return "success";

  const state = String(check?.state ?? "").toLowerCase();
  if (FAILURE_CHECK_STATES.has(state)) return "failure";
  if (PENDING_CHECK_STATES.has(state)) return "pending";
  return "success";
}

function deduplicateRunsByName(runs) {
  const seen = new Set();
  const result = [];
  for (const run of runs) {
    const name = typeof run?.name === "string" ? run.name.trim() : "";
    if (name) {
      if (seen.has(name)) continue;
      seen.add(name);
    }
    result.push(run);
  }
  return result;
}

export function evaluateCiState(runs = [], prChecks = [], headSha = null) {
  const rawRuns = Array.isArray(runs) ? runs : [];
  const rawChecks = Array.isArray(prChecks) ? prChecks : [];

  const sha = typeof headSha === "string" && headSha.trim() ? headSha.trim() : null;
  const matchingRuns = deduplicateRunsByName(
    sha
      ? rawRuns.filter((r) => !r?.headSha || r.headSha === sha)
      : rawRuns,
  );

  if (matchingRuns.length === 0 && rawChecks.length === 0) {
    return {
      state: "none",
      summary: "No CI runs or PR checks found",
      failedRunId: null,
      failedName: null,
    };
  }

  const failedRuns = [];
  const pendingRuns = [];
  const passedRuns = [];

  for (const run of matchingRuns) {
    const kind = classifyRun(run);
    if (kind === "failure") failedRuns.push(run);
    else if (kind === "pending") pendingRuns.push(run);
    else passedRuns.push(run);
  }

  const failedChecks = [];
  const pendingChecks = [];
  const passedChecks = [];

  for (const check of rawChecks) {
    const kind = classifyPrCheck(check);
    if (kind === "failure") failedChecks.push(check);
    else if (kind === "pending") pendingChecks.push(check);
    else passedChecks.push(check);
  }

  if (failedRuns.length > 0 || failedChecks.length > 0) {
    const firstRun = failedRuns[0] ?? null;
    const firstCheck = failedChecks[0] ?? null;
    const failedRunId = typeof firstRun?.databaseId === "number" ? firstRun.databaseId : null;
    const failedName = firstRun?.name ?? firstCheck?.name ?? null;
    const names = [
      ...failedRuns.map((r) => r?.name).filter(Boolean),
      ...failedChecks.map((c) => c?.name).filter(Boolean),
    ];
    const uniqueNames = [...new Set(names)];
    const summary = uniqueNames.length > 0
      ? `CI failed: ${uniqueNames.join(", ")}`
      : "CI failed";

    return {
      state: "failure",
      summary,
      failedRunId,
      failedName,
    };
  }

  if (pendingRuns.length > 0 || pendingChecks.length > 0) {
    const names = [
      ...pendingRuns.map((r) => r?.name).filter(Boolean),
      ...pendingChecks.map((c) => c?.name).filter(Boolean),
    ];
    const uniqueNames = [...new Set(names)];
    const summary = uniqueNames.length > 0
      ? `CI pending: ${uniqueNames.join(", ")}`
      : "CI pending";

    return {
      state: "pending",
      summary,
      failedRunId: null,
      failedName: null,
    };
  }

  const total = passedRuns.length + passedChecks.length;
  return {
    state: "success",
    summary: `All ${total} CI check(s) passed`,
    failedRunId: null,
    failedName: null,
  };
}

export function shouldRetryCi(ciRetryCount, maxCiRetries = 3) {
  const hasExplicitMax =
    maxCiRetries !== undefined &&
    maxCiRetries !== null &&
    !(typeof maxCiRetries === "string" && maxCiRetries.trim() === "");
  const parsedMax = hasExplicitMax ? Number(maxCiRetries) : 3;
  const max = Number.isFinite(parsedMax) ? parsedMax : 3;
  if (max === 0) return true;
  const count = Number(ciRetryCount) || 0;
  return count < max;
}

export function buildCiFixPrompt(epic, task, ciInfo, logTail, attempt, maxRetries) {
  const maxLabel = maxRetries === 0 ? "∞" : String(maxRetries);
  const lines = [
    `CI check failed (attempt ${attempt}/${maxLabel}). Fix the failure and push the updated commit.`,
    "",
  ];

  if (epic) {
    lines.push(`Epic: ${epic.id ?? ""} — ${epic.title ?? ""}`.trim());
  }
  if (task) {
    lines.push(`Task: ${task.id ?? ""} — ${task.title ?? ""}`.trim());
  }
  if (ciInfo?.failedName) {
    lines.push(`Failed workflow/check: ${ciInfo.failedName}`);
  }
  if (ciInfo?.summary) {
    lines.push(`CI summary: ${ciInfo.summary}`);
  }

  const trimmedLog = String(logTail ?? "").trim();
  if (trimmedLog) {
    lines.push("", "Failed CI log tail:", "```", trimmedLog, "```");
  }

  lines.push(
    "",
    "Instructions:",
    "1. Diagnose the root cause from the CI failure logs above.",
    "2. Fix the code or tests and run the relevant checks locally.",
    "3. Commit and push your fix so CI re-runs.",
  );
  if (epic?.filePath) {
    lines.push(`4. Keep backlog status accurate in ${epic.filePath}.`);
  }

  return lines.join("\n");
}

function parseJsonArray(raw, label) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, data: [] };
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: `${label} returned non-array JSON` };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    return { ok: false, error: `Failed to parse ${label} JSON: ${err?.message ?? String(err)}` };
  }
}

export async function checkGithubCiStatus(projectRoot, on, execFn) {
  const opts = { cwd: projectRoot, on: on ?? null };
  let branch = null;

  try {
    const branchRes = await execFn("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts);
    if (branchRes.code !== 0) {
      const errMsg = (branchRes.stderr || branchRes.stdout || "git rev-parse --abbrev-ref HEAD failed").trim();
      return {
        state: "error",
        summary: `Git error: ${errMsg}`,
        failedRunId: null,
        failedName: null,
        branch: null,
        error: errMsg,
      };
    }
    branch = String(branchRes.stdout ?? "").trim() || null;

    const shaRes = await execFn("git", ["rev-parse", "HEAD"], opts);
    if (shaRes.code !== 0) {
      const errMsg = (shaRes.stderr || shaRes.stdout || "git rev-parse HEAD failed").trim();
      return {
        state: "error",
        summary: `Git error: ${errMsg}`,
        failedRunId: null,
        failedName: null,
        branch,
        error: errMsg,
      };
    }
    const headSha = String(shaRes.stdout ?? "").trim() || null;

    const runArgs = ["run", "list"];
    if (branch && branch !== "HEAD") {
      runArgs.push("--branch", branch);
    }
    runArgs.push("--limit", "5", "--json", "databaseId,status,conclusion,name,headSha,url");

    const runsRes = await execFn("gh", runArgs, opts);
    if (runsRes.code !== 0) {
      const errMsg = (runsRes.stderr || runsRes.stdout || "gh run list failed").trim();
      return {
        state: "error",
        summary: `GitHub CLI error: ${errMsg}`,
        failedRunId: null,
        failedName: null,
        branch,
        error: errMsg,
      };
    }

    const parsedRuns = parseJsonArray(runsRes.stdout, "gh run list");
    if (!parsedRuns.ok) {
      return {
        state: "error",
        summary: parsedRuns.error,
        failedRunId: null,
        failedName: null,
        branch,
        error: parsedRuns.error,
      };
    }

    const checksRes = await execFn(
      "gh",
      ["pr", "checks", "--json", "name,state,bucket,link"],
      opts,
    );

    let prChecks = [];
    if (checksRes.code !== 0) {
      const errText = (checksRes.stderr || checksRes.stdout || "").trim();
      if (!/no pull requests found|no checks reported/i.test(errText)) {
        const errMsg = errText || "gh pr checks failed";
        return {
          state: "error",
          summary: `GitHub CLI error: ${errMsg}`,
          failedRunId: null,
          failedName: null,
          branch,
          error: errMsg,
        };
      }
    } else {
      const parsedChecks = parseJsonArray(checksRes.stdout, "gh pr checks");
      if (!parsedChecks.ok) {
        return {
          state: "error",
          summary: parsedChecks.error,
          failedRunId: null,
          failedName: null,
          branch,
          error: parsedChecks.error,
        };
      }
      prChecks = parsedChecks.data;
    }

    const evaluated = evaluateCiState(parsedRuns.data, prChecks, headSha);
    return {
      ...evaluated,
      branch,
    };
  } catch (err) {
    const errMsg = err?.message ?? String(err);
    return {
      state: "error",
      summary: `CI check failed: ${errMsg}`,
      failedRunId: null,
      failedName: null,
      branch,
      error: errMsg,
    };
  }
}

export function capLogTail(rawText, maxLines = MAX_LOG_LINES, maxChars = MAX_LOG_CHARS) {
  const text = String(rawText ?? "").trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const tailedLines = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  const joined = tailedLines.join("\n");
  if (joined.length <= maxChars) return joined;
  return joined.slice(joined.length - maxChars);
}

export async function fetchFailedCiLogs(projectRoot, runId, on, execFn) {
  if (runId === null || runId === undefined || runId === "") {
    return "";
  }
  const opts = { cwd: projectRoot, on: on ?? null };
  try {
    const res = await execFn("gh", ["run", "view", String(runId), "--log-failed"], opts);
    if (res.code !== 0) {
      const errText = (res.stderr || res.stdout || "Failed to fetch CI logs").trim();
      return capLogTail(errText);
    }
    return capLogTail(res.stdout);
  } catch (err) {
    return capLogTail(err?.message ?? String(err));
  }
}
