import { describe, expect, test } from "bun:test";
import {
  evaluateCiState,
  shouldRetryCi,
  buildCiFixPrompt,
  checkGithubCiStatus,
  fetchFailedCiLogs,
} from "../mods/orca/ci.js";

describe("evaluateCiState", () => {
  test("detects pending, success, and failure across runs and PR checks", () => {
    expect(
      evaluateCiState([{ databaseId: 10, status: "in_progress", conclusion: null, name: "CI", headSha: "abc" }], [], "abc").state,
    ).toBe("pending");

    expect(
      evaluateCiState([{ databaseId: 11, status: "completed", conclusion: "success", name: "CI", headSha: "abc" }], [], "abc").state,
    ).toBe("success");

    const fail = evaluateCiState(
      [{ databaseId: 12, status: "completed", conclusion: "failure", name: "Build & Test", headSha: "abc" }],
      [],
      "abc",
    );
    expect(fail.state).toBe("failure");
    expect(fail.failedRunId).toBe(12);
    expect(fail.failedName).toBe("Build & Test");
  });

  test("returns none when no matching runs or PR checks exist", () => {
    const empty = evaluateCiState([], [], "abc");
    expect(empty).toEqual({
      state: "none",
      summary: "No CI runs or PR checks found",
      failedRunId: null,
      failedName: null,
    });

    const mismatchedSha = evaluateCiState(
      [{ databaseId: 99, status: "completed", conclusion: "failure", name: "Old CI", headSha: "oldsha" }],
      [],
      "newsha",
    );
    expect(mismatchedSha.state).toBe("none");
  });

  test("evaluates PR checks buckets (fail, pending, pass) and prioritizes failure over pending", () => {
    const prFail = evaluateCiState(
      [{ databaseId: 20, status: "in_progress", conclusion: null, name: "Workflow", headSha: "abc" }],
      [
        { name: "lint", state: "FAILURE", bucket: "fail", link: "https://example.com/1" },
        { name: "test", state: "PENDING", bucket: "pending", link: "https://example.com/2" },
      ],
      "abc",
    );
    expect(prFail.state).toBe("failure");
    expect(prFail.failedName).toBe("lint");

    const prPending = evaluateCiState(
      [{ databaseId: 21, status: "completed", conclusion: "success", name: "Workflow", headSha: "abc" }],
      [{ name: "deploy-preview", state: "PENDING", bucket: "pending" }],
      "abc",
    );
    expect(prPending.state).toBe("pending");

    const prPass = evaluateCiState(
      [],
      [
        { name: "lint", state: "SUCCESS", bucket: "pass" },
        { name: "skip", state: "SKIPPED", bucket: "skipping" },
      ],
      "abc",
    );
    expect(prPass.state).toBe("success");
  });

  test("treats timed_out, cancelled, action_required, startup_failure as failure and queued/waiting/requested as pending", () => {
    const timedOut = evaluateCiState(
      [{ databaseId: 30, status: "completed", conclusion: "timed_out", name: "E2E", headSha: "abc" }],
      [],
      "abc",
    );
    expect(timedOut.state).toBe("failure");
    expect(timedOut.failedRunId).toBe(30);

    const queued = evaluateCiState(
      [{ databaseId: 31, status: "queued", conclusion: null, name: "Build", headSha: "abc" }],
      [],
      "abc",
    );
    expect(queued.state).toBe("pending");
  });
});

describe("shouldRetryCi & buildCiFixPrompt", () => {
  test("0 means unlimited retries; positive N caps at N attempts", () => {
    expect(shouldRetryCi(0, 3)).toBe(true);
    expect(shouldRetryCi(2, 3)).toBe(true);
    expect(shouldRetryCi(3, 3)).toBe(false);
    expect(shouldRetryCi(99, 0)).toBe(true);
  });

  test("defaults maxCiRetries to 3 when undefined, null, or empty string", () => {
    expect(shouldRetryCi(0)).toBe(true);
    expect(shouldRetryCi(2)).toBe(true);
    expect(shouldRetryCi(3)).toBe(false);
    expect(shouldRetryCi(0, null)).toBe(true);
    expect(shouldRetryCi(3, null)).toBe(false);
    expect(shouldRetryCi(0, "")).toBe(true);
    expect(shouldRetryCi(3, "")).toBe(false);
  });

  test("buildCiFixPrompt includes attempt counter, workflow name, and log tail", () => {
    const prompt = buildCiFixPrompt(
      { id: "EPIC-001", title: "Auth", filePath: "C:/repo/backlog/001.md" },
      { id: "TASK-001.2", title: "Login" },
      { failedName: "CI", summary: "CI failed" },
      "Error: test failed at line 42",
      2,
      3,
    );
    expect(prompt).toContain("2/3");
    expect(prompt).toContain("CI");
    expect(prompt).toContain("Error: test failed at line 42");
  });

  test("buildCiFixPrompt handles unlimited retries (maxRetries=0) and null task", () => {
    const prompt = buildCiFixPrompt(
      { id: "EPIC-002", title: "Billing", filePath: "C:/repo/backlog/002.md" },
      null,
      { failedName: null, summary: "Checks failed" },
      "",
      1,
      0,
    );
    expect(prompt).toContain("EPIC-002");
    expect(prompt).toContain("1/∞");
    expect(prompt).toContain("Checks failed");
  });
});

describe("checkGithubCiStatus", () => {
  test("returns error state when gh fails instead of looping silently", async () => {
    const mockExec = async (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") return { code: 0, stdout: "main\n", stderr: "" };
      if (cmd === "git" && args[0] === "rev-parse") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (cmd === "gh") return { code: 1, stdout: "", stderr: "gh: not logged into any GitHub hosts" };
      return { code: 1, stdout: "", stderr: "" };
    };
    const res = await checkGithubCiStatus("C:/repo", null, mockExec);
    expect(res.state).toBe("error");
    expect(res.error).toContain("not logged");
  });

  test("ignores 'no pull requests found' from gh pr checks and evaluates workflow runs", async () => {
    const calls = [];
    const mockExec = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "feat/auth\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "deadbeef\n", stderr: "" };
      }
      if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { databaseId: 55, status: "completed", conclusion: "success", name: "Test", headSha: "deadbeef", url: "https://github.com/x/y/actions/runs/55" },
          ]),
          stderr: "",
        };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "checks") {
        return { code: 1, stdout: "", stderr: "no pull requests found for branch \"feat/auth\"" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    const res = await checkGithubCiStatus("C:/repo", "vps", mockExec);
    expect(res.state).toBe("success");
    expect(res.branch).toBe("feat/auth");
    expect(res.failedRunId).toBeNull();
    expect(calls.every((c) => c.opts?.cwd === "C:/repo" && c.opts?.on === "vps")).toBe(true);
  });

  test("ignores 'no checks reported' from gh pr checks when PR exists before checks register", async () => {
    const mockExec = async (cmd, args) => {
      if (cmd === "git" && args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
        return { code: 0, stdout: "feat/new-pr\n", stderr: "" };
      }
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: "cafebabe\n", stderr: "" };
      }
      if (cmd === "gh" && args[0] === "run" && args[1] === "list") {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (cmd === "gh" && args[0] === "pr" && args[1] === "checks") {
        return { code: 1, stdout: "", stderr: "no checks reported on the 'feat/new-pr' branch" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    };

    const res = await checkGithubCiStatus("C:/repo", null, mockExec);
    expect(res.state).toBe("none");
    expect(res.branch).toBe("feat/new-pr");
  });

  test("returns error when git rev-parse fails", async () => {
    const mockExec = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
    const res = await checkGithubCiStatus("C:/not-a-repo", null, mockExec);
    expect(res.state).toBe("error");
    expect(res.error).toContain("not a git repository");
  });
});

describe("fetchFailedCiLogs", () => {
  test("fetches failed logs via gh run view and caps to last 120 lines and 6000 chars", async () => {
    const manyLines = Array.from({ length: 200 }, (_, i) => `line-${i + 1}`).join("\n");
    const mockExec = async (cmd, args, opts) => {
      expect(cmd).toBe("gh");
      expect(args).toEqual(["run", "view", "42", "--log-failed"]);
      expect(opts).toEqual({ cwd: "C:/repo", on: null });
      return { code: 0, stdout: manyLines, stderr: "" };
    };

    const log = await fetchFailedCiLogs("C:/repo", 42, null, mockExec);
    const lines = log.split("\n");
    expect(lines.length).toBe(120);
    expect(lines[0]).toBe("line-81");
    expect(lines[lines.length - 1]).toBe("line-200");

    const hugeLine = "x".repeat(8000);
    const hugeExec = async () => ({ code: 0, stdout: hugeLine, stderr: "" });
    const capped = await fetchFailedCiLogs("C:/repo", 42, null, hugeExec);
    expect(capped.length).toBe(6000);
  });

  test("returns empty or error message gracefully when runId is missing or gh fails", async () => {
    expect(await fetchFailedCiLogs("C:/repo", null, null, async () => ({ code: 0, stdout: "x", stderr: "" }))).toBe("");
    const errLog = await fetchFailedCiLogs("C:/repo", 77, null, async () => ({ code: 1, stdout: "", stderr: "run not found" }));
    expect(errLog).toContain("run not found");
  });
});
