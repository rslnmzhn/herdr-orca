// Pure read-only inspection tools and review-fix prompt builder for Orca Reviewer mode.
// Zero Herdr host/UI imports and zero Node APIs so it runs in both Herdr and bun test.

import { normPath, joinPath } from "./paths.js";

const ANSI_OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI_RE = /[\u001b\u009b]\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESC_RE = /\u001b[@-Z\\-_]/g;

function stripAnsi(text) {
  if (text === null || text === undefined) return "";
  return String(text)
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_ESC_RE, "");
}

const MAX_TOOL_OUTPUT_CHARS = 12000;
const MAX_FILE_LINES = 250;
const MAX_LIST_FILES = 200;

export const REVIEWER_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_terminal",
      description:
        "Read recent lines from the coding agent's live terminal screen and scrollback to verify commands run and actual test/build output.",
      parameters: {
        type: "object",
        properties: {
          lines: {
            type: "integer",
            description: "Number of trailing lines to read (20 to 400, default 150).",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "Run `git status --short` in the project root to see modified, added, or untracked files.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description:
        "Inspect actual code changes in the repository (`working` unstaged+staged diff, `staged` diff, or `last_commit` patch).",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["working", "staged", "last_commit"],
            description: "Which diff to inspect (default: working).",
          },
          path: {
            type: "string",
            description: "Optional relative file or directory path inside the repository.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List tracked files in the repository (optionally filtered to a relative subdirectory).",
      parameters: {
        type: "object",
        properties: {
          dir: {
            type: "string",
            description: "Optional relative subdirectory inside the repository.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file inside the project repository (or the backlog epic file) with 1-based line numbers to verify implementation details and tests.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path inside the project root (or the backlog epic file path).",
          },
          start_line: {
            type: "integer",
            description: "1-based start line (default 1).",
          },
          end_line: {
            type: "integer",
            description: "1-based end line (capped to 250 lines per call).",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

function capOutput(text, maxChars = MAX_TOOL_OUTPUT_CHARS) {
  const str = String(text ?? "");
  if (str.length <= maxChars) return str;
  return `${str.slice(0, maxChars)}\n... [truncated ${str.length - maxChars} chars]`;
}

function isSafeRelativePath(rel) {
  if (typeof rel !== "string") return false;
  const trimmed = rel.trim();
  if (!trimmed || trimmed.startsWith("-")) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/.test(trimmed)) return false;
  const parts = trimmed.replace(/\\/g, "/").split("/");
  return !parts.some((p) => p === "..");
}

export function resolveSafeRepoPath(projectRoot, rawPath, allowedExtraPaths = []) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.startsWith("-")) return null;

  const normalizedInput = normPath(trimmed);
  if (!normalizedInput) return null;

  for (const extra of allowedExtraPaths) {
    const normExtra = normPath(extra);
    if (normExtra && normalizedInput === normExtra) {
      return normExtra;
    }
  }

  const root = normPath(projectRoot);
  if (!root) return null;

  if (normalizedInput === root || normalizedInput.startsWith(`${root}/`)) {
    const rel = normalizedInput.slice(root.length + 1);
    return isSafeRelativePath(rel) ? normalizedInput : null;
  }

  if (!isSafeRelativePath(trimmed)) return null;
  const cleanRel = trimmed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!cleanRel) return root;
  return joinPath(root, cleanRel);
}

export function createReviewerToolExecutor({
  projectRoot = null,
  terminal = null,
  on = null,
  epicFilePath = null,
  execFn,
  hcFn,
  readTextFileFn,
}) {
  const execOpts = { cwd: projectRoot, on: on ?? null };
  const allowedExtras = epicFilePath ? [epicFilePath] : [];

  return async (name, rawArgs = {}) => {
    const args = rawArgs && typeof rawArgs === "object" ? rawArgs : {};
    try {
      if (name === "read_terminal") {
        if (!terminal || typeof hcFn !== "function") {
          return "Error: terminal is unavailable";
        }
        const rawLines = Number(args.lines);
        const lines = Number.isFinite(rawLines)
          ? Math.max(20, Math.min(400, Math.round(rawLines)))
          : 150;
        const res = await hcFn(["read", terminal, "--lines", String(lines)]);
        if (res.code !== 0) {
          return `Error reading terminal: ${(res.stderr || res.stdout || "hc read failed").trim()}`;
        }
        const clean = stripAnsi(res.stdout ?? "").trim();
        return capOutput(clean || "(terminal output is empty)");
      }

      if (name === "git_status") {
        if (!projectRoot || typeof execFn !== "function") {
          return "Error: projectRoot is unavailable";
        }
        const res = await execFn("git", ["status", "--short"], execOpts);
        if (res.code !== 0) {
          return `Error running git status: ${(res.stderr || res.stdout || "failed").trim()}`;
        }
        return capOutput((res.stdout ?? "").trim() || "(working tree clean)");
      }

      if (name === "git_diff") {
        if (!projectRoot || typeof execFn !== "function") {
          return "Error: projectRoot is unavailable";
        }
        const target = args.target === "staged" || args.target === "last_commit" ? args.target : "working";
        const relPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : null;
        if (relPath && !isSafeRelativePath(relPath)) {
          return "Error: invalid relative path";
        }

        if (target === "last_commit") {
          const gitArgs = ["show", "--stat", "--patch", "-n", "1", "HEAD"];
          if (relPath) gitArgs.push("--", relPath);
          const res = await execFn("git", gitArgs, execOpts);
          if (res.code !== 0) {
            return `Error running git show: ${(res.stderr || res.stdout || "failed").trim()}`;
          }
          return capOutput((res.stdout ?? "").trim() || "(empty commit diff)");
        }

        if (target === "staged") {
          const gitArgs = ["diff", "--cached"];
          if (relPath) gitArgs.push("--", relPath);
          const res = await execFn("git", gitArgs, execOpts);
          if (res.code !== 0) {
            return `Error running git diff --cached: ${(res.stderr || res.stdout || "failed").trim()}`;
          }
          return capOutput((res.stdout ?? "").trim() || "(no staged changes)");
        }

        const unstagedArgs = ["diff"];
        const stagedArgs = ["diff", "--cached"];
        if (relPath) {
          unstagedArgs.push("--", relPath);
          stagedArgs.push("--", relPath);
        }
        const [unstaged, staged] = await Promise.all([
          execFn("git", unstagedArgs, execOpts),
          execFn("git", stagedArgs, execOpts),
        ]);
        if (unstaged.code !== 0 && staged.code !== 0) {
          return `Error running git diff: ${(unstaged.stderr || staged.stderr || "failed").trim()}`;
        }
        const parts = [];
        if (unstaged.code === 0 && unstaged.stdout?.trim()) {
          parts.push(unstaged.stdout.trim());
        }
        if (staged.code === 0 && staged.stdout?.trim()) {
          parts.push(`# Staged changes\n${staged.stdout.trim()}`);
        }
        return capOutput(parts.join("\n\n") || "(no working tree diff)");
      }

      if (name === "list_files") {
        if (!projectRoot || typeof execFn !== "function") {
          return "Error: projectRoot is unavailable";
        }
        const dir = typeof args.dir === "string" && args.dir.trim() ? args.dir.trim() : null;
        if (dir && !isSafeRelativePath(dir)) {
          return "Error: invalid relative directory";
        }
        const gitArgs = ["ls-files"];
        if (dir) gitArgs.push("--", dir);
        const res = await execFn("git", gitArgs, execOpts);
        if (res.code !== 0) {
          return `Error running git ls-files: ${(res.stderr || res.stdout || "failed").trim()}`;
        }
        const lines = String(res.stdout ?? "")
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        if (lines.length === 0) return "(no tracked files matched)";
        const shown = lines.slice(0, MAX_LIST_FILES);
        const suffix = lines.length > MAX_LIST_FILES ? `\n... (+${lines.length - MAX_LIST_FILES} more)` : "";
        return capOutput(shown.join("\n") + suffix);
      }

      if (name === "read_file") {
        if (typeof readTextFileFn !== "function") {
          return "Error: readTextFile is unavailable";
        }
        const resolved = resolveSafeRepoPath(projectRoot, args.path, allowedExtras);
        if (!resolved) {
          return "Error: path is outside the project root or invalid";
        }
        const text = await readTextFileFn(resolved, { on: on ?? null });
        if (text === null || text === undefined) {
          return `Error: file not found (${resolved})`;
        }
        const allLines = String(text).split(/\r?\n/);
        const rawStart = Number(args.start_line);
        const start = Number.isFinite(rawStart) && rawStart >= 1 ? Math.floor(rawStart) : 1;
        const rawEnd = Number(args.end_line);
        const requestedEnd =
          Number.isFinite(rawEnd) && rawEnd >= start ? Math.floor(rawEnd) : start + MAX_FILE_LINES - 1;
        const end = Math.min(allLines.length, requestedEnd, start + MAX_FILE_LINES - 1);
        if (start > allLines.length) {
          return `(file has ${allLines.length} lines; start_line ${start} is past EOF)`;
        }
        const numbered = [];
        for (let i = start; i <= end; i++) {
          numbered.push(`${i}: ${allLines[i - 1]}`);
        }
        const suffix = end < allLines.length ? `\n... [EOF at line ${allLines.length}]` : "";
        return capOutput(numbered.join("\n") + suffix);
      }

      return `Error: unknown tool "${name}"`;
    } catch (err) {
      return `Error executing ${name}: ${err?.message ?? String(err)}`;
    }
  };
}

export function buildReviewFixPrompt(epic, task, verdict, attempt, maxRetries) {
  const maxLabel = maxRetries === 0 ? "∞" : String(maxRetries);
  const lines = [
    `Ревьювер отклонил выполнение (попытка ${attempt}/${maxLabel}). Исправь замечания и подтверди результат реальным запуском проверок/тестов.`,
    "",
  ];

  if (epic) {
    lines.push(`Эпик: ${epic.id ?? ""} — ${epic.title ?? ""}`.trim());
  }
  if (task) {
    lines.push(`Задача: ${task.id ?? ""} — ${task.title ?? ""}`.trim());
  }
  if (verdict?.reason) {
    lines.push(`Причина отклонения: ${verdict.reason}`);
  }

  const issues = Array.isArray(verdict?.issues) ? verdict.issues.filter(Boolean) : [];
  if (issues.length > 0) {
    lines.push("", "Замечания ревьювера:");
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
  }

  const evidence = Array.isArray(verdict?.evidence) ? verdict.evidence.filter(Boolean) : [];
  if (evidence.length > 0) {
    lines.push("", "Наблюдаемые факты:");
    for (const ev of evidence) {
      lines.push(`- ${ev}`);
    }
  }

  lines.push(
    "",
    "Инструкции:",
    "1. Устрани все перечисленные замечания без заглушек, TODO и пропуска тестов.",
    "2. Запусти релевантные тесты/проверки и убедись, что они реально проходят после последних правок.",
  );
  if (epic?.filePath) {
    lines.push(
      `3. Обновляй статус в ${epic.filePath} по формату Kanban-доски: \`[ ] TODO\` (\`- [ ]\`), \`[-] IN PROGRESS\` (\`- [-]\`), \`[!] BLOCKED\` (\`- [!]\`), \`[x] DONE\` (\`- [x]\`).`,
    );
  }

  return lines.join("\n");
}
