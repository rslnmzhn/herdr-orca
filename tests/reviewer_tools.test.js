import { describe, expect, test } from "bun:test";
import {
  REVIEWER_TOOLS,
  resolveSafeRepoPath,
  createReviewerToolExecutor,
  buildReviewFixPrompt,
} from "../mods/orca/reviewer_tools.js";

describe("REVIEWER_TOOLS schema", () => {
  test("defines read-only inspection tools in OpenAI function format", () => {
    const names = REVIEWER_TOOLS.map((t) => t.function?.name);
    expect(names).toEqual(["read_terminal", "git_status", "git_diff", "list_files", "read_file"]);
    for (const tool of REVIEWER_TOOLS) {
      expect(tool.type).toBe("function");
      expect(tool.function.parameters.type).toBe("object");
    }
  });
});

describe("resolveSafeRepoPath", () => {
  test("allows relative paths inside projectRoot and explicit epicFilePath", () => {
    expect(resolveSafeRepoPath("C:/repo", "src/app.js")).toBe("C:/repo/src/app.js");
    expect(resolveSafeRepoPath("C:/repo", "./tests/a.test.js")).toBe("C:/repo/tests/a.test.js");
    expect(
      resolveSafeRepoPath("C:/repo", "C:/other/backlog/001.md", ["C:/other/backlog/001.md"]),
    ).toBe("C:/other/backlog/001.md");
  });

  test("rejects path traversal, outside absolute paths, and flag-like paths", () => {
    expect(resolveSafeRepoPath("C:/repo", "../secret.txt")).toBeNull();
    expect(resolveSafeRepoPath("C:/repo", "src/../../etc/passwd")).toBeNull();
    expect(resolveSafeRepoPath("C:/repo", "C:/Windows/System32/drivers/etc/hosts")).toBeNull();
    expect(resolveSafeRepoPath("C:/repo", "/etc/passwd")).toBeNull();
    expect(resolveSafeRepoPath("C:/repo", "--exec=evil")).toBeNull();
  });
});

describe("createReviewerToolExecutor", () => {
  test("executes read_terminal, git_status, git_diff, list_files, and read_file safely", async () => {
    const calls = [];
    const executor = createReviewerToolExecutor({
      projectRoot: "C:/repo",
      terminal: "t2",
      on: null,
      epicFilePath: "C:/repo/backlog/001.md",
      hcFn: async (args) => {
        calls.push({ kind: "hc", args });
        return { code: 0, stdout: "\u001b[32m34 pass\u001b[0m\n0 fail", stderr: "" };
      },
      execFn: async (cmd, args, opts) => {
        calls.push({ kind: "exec", cmd, args, opts });
        if (args[0] === "status") return { code: 0, stdout: " M src/app.js\n", stderr: "" };
        if (args[0] === "diff") return { code: 0, stdout: "diff --git a/src/app.js b/src/app.js\n+ok", stderr: "" };
        if (args[0] === "ls-files" && args.includes("--others")) {
          return { code: 0, stdout: ".verify-logs/cargo.log\n", stderr: "" };
        }
        if (args[0] === "ls-files") return { code: 0, stdout: "src/app.js\ntests/app.test.js\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      readTextFileFn: async (path) => {
        calls.push({ kind: "read", path });
        return "line1\nline2\nline3\nline4";
      },
    });

    const termOut = await executor("read_terminal", { lines: 9999 });
    expect(termOut).toContain("34 pass");
    expect(termOut).not.toContain("\u001b[");
    expect(calls[0].args).toEqual(["read", "t2", "--lines", "400"]);

    const statusOut = await executor("git_status", {});
    expect(statusOut).toContain("M src/app.js");

    const diffOut = await executor("git_diff", { target: "working", path: "src/app.js" });
    expect(diffOut).toContain("+ok");

    const filesOut = await executor("list_files", { dir: "src" });
    expect(filesOut).toContain("src/app.js");
    expect(filesOut).toContain(".verify-logs/cargo.log");

    const fileOut = await executor("read_file", { path: "src/app.js", start_line: 2, end_line: 3 });
    expect(fileOut).toBe("2: line2\n3: line3\n... [EOF at line 4]");

    const blockedOut = await executor("read_file", { path: "../outside.txt" });
    expect(blockedOut).toContain("Error:");
  });
});

describe("buildReviewFixPrompt", () => {
  test("includes attempt counter, issues, evidence, and Kanban status instructions", () => {
    const prompt = buildReviewFixPrompt(
      { id: "EPIC-001", title: "Auth", filePath: "C:/repo/backlog/001.md" },
      { id: "TASK-001.2", title: "Login" },
      {
        reason: "Тесты не запускались, в коде оставлена заглушка",
        issues: ["src/auth.js:14 содержит TODO вместо проверки токена"],
        evidence: ["git_diff: +// TODO: verify token"],
      },
      1,
      3,
    );
    expect(prompt).toContain("1/3");
    expect(prompt).toContain("TASK-001.2");
    expect(prompt).toContain("src/auth.js:14");
    expect(prompt).toContain("git_diff");
    expect(prompt).toContain("[-] IN PROGRESS");
    expect(prompt).toContain("[x] DONE");
  });

  test("includes full review checklist, optional score, and prior review history", () => {
    const prompt = buildReviewFixPrompt(
      { id: "EPIC-002", title: "Sync" },
      { id: "TASK-002.1", title: "Bridge" },
      {
        reason: "Не хватает обработки ошибок",
        issues: ["Добавить обработку Err в bridge.rs"],
        review: {
          blockingPassed: true,
          failedBlocking: [],
          earned: 7,
          applicableMax: 21,
          selectedMax: 21,
          effectiveThreshold: 15,
          checks: {
            requirements_met: {
              id: "requirements_met",
              label: "Требования задачи / DoD выполнены",
              blocking: true,
              weight: 0,
              status: "pass",
              note: "реализовано",
            },
            error_handling: {
              id: "error_handling",
              label: "Корректная обработка ошибок",
              blocking: false,
              weight: 8,
              status: "fail",
              note: "ошибка проглатывается",
            },
          },
        },
      },
      2,
      0,
      [
        {
          attempt: 1,
          reason: "Была заглушка TODO",
          issues: ["Убрать TODO в bridge.rs:10"],
          review: { earned: 10, applicableMax: 21, selectedMax: 21, effectiveThreshold: 15 },
        },
      ],
    );

    expect(prompt).toContain("2/∞");
    expect(prompt).toContain("Дополнительные баллы: 7/21 (порог: 15)");
    expect(prompt).toContain("[PASS] Требования задачи / DoD выполнены (блокер)");
    expect(prompt).toContain("[FAIL] Корректная обработка ошибок (+8 б.) — ошибка проглатывается");
    expect(prompt).toContain("Попытка #1 (10/21, порог 15): Была заглушка TODO");
    expect(prompt).toContain("Убрать TODO в bridge.rs:10");
  });
});
