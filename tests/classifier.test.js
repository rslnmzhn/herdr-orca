import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MIN_REVIEW_SCORE,
  BLOCKING_REVIEW_CHECKS,
  OPTIONAL_REVIEW_CHECKS,
  getDefaultOptionalReviewChecks,
  getMaxOptionalReviewScore,
  resolveMinReviewScore,
  evaluateReviewRubric,
  stripAnsi,
  normalizeBaseUrl,
  fetchModels,
  parseClassifierVerdict,
  buildClassifierMessages,
  buildReviewerMessages,
  classifySessionTurn,
} from "../mods/orca/classifier.js";

describe("normalizeBaseUrl", () => {
  test("normalizes host, trailing slashes, and /v1 suffix without duplicating /v1", () => {
    expect(normalizeBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(normalizeBaseUrl("https://proxy.example.com/openai/v1/")).toBe("https://proxy.example.com/openai/v1");
    expect(normalizeBaseUrl("")).toBe("");
    expect(normalizeBaseUrl("   ")).toBe("");
    expect(normalizeBaseUrl(null)).toBe("");
  });
});

describe("stripAnsi & parseClassifierVerdict", () => {
  test("strips ANSI escape sequences and parses fenced JSON verdicts", () => {
    expect(stripAnsi("\u001b[32mOK\u001b[0m")).toBe("OK");
    expect(stripAnsi("\u001b]0;Window Title\u0007hello\u001b[1;31m!\u001b[0m")).toBe("hello!");
    const fenced = "Вот результат:\n```json\n{\"verdict\":\"waiting_ci\",\"reason\":\"Агент запушил ветку и ждёт GitHub Actions\",\"ci_ref\":\"main\"}\n```";
    expect(parseClassifierVerdict(fenced)).toEqual({
      verdict: "waiting_ci",
      reason: "Агент запушил ветку и ждёт GitHub Actions",
      ci_ref: "main",
    });
  });

  test("falls back to needs_user on unparseable output or unknown verdict", () => {
    const res = parseClassifierVerdict("not json at all");
    expect(res.verdict).toBe("needs_user");
    expect(res.reason.length).toBeGreaterThan(0);

    const unknown = parseClassifierVerdict('{"verdict":"maybe","reason":"unclear"}');
    expect(unknown.verdict).toBe("needs_user");
    expect(unknown.reason).toBe("unclear");
  });

  test("omits ci_ref when absent or empty", () => {
    const res = parseClassifierVerdict('{"verdict":"failed","reason":"Build failed","ci_ref":""}');
    expect(res).toEqual({ verdict: "failed", reason: "Build failed" });
    expect("ci_ref" in res).toBe(false);
  });
});

describe("buildClassifierMessages", () => {
  test("builds system and user messages with stripped terminal tail and context", () => {
    const messages = buildClassifierMessages({
      epic: { id: "EPIC-001", title: "Auth", dod: "All tests pass" },
      task: { id: "TASK-001.2", title: "Login", subitems: ["Add JWT"] },
      terminalTail: "\u001b[32mPASS\u001b[0m 12 tests",
      gitStatus: "M src/auth.js",
      gitLog: "abc123 feat: login",
      ciSummary: "none",
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("EPIC-001");
    expect(messages[1].content).toContain("TASK-001.2");
    expect(messages[1].content).toContain("PASS 12 tests");
    expect(messages[1].content).not.toContain("\u001b[32m");
    expect(messages[1].content).toContain("M src/auth.js");
  });
});

describe("fetchModels & classifySessionTurn", () => {
  test("fetchModels omits Authorization when apiKey is empty and sorts model ids", async () => {
    let seenHeaders = null;
    let seenUrl = null;
    const mockFetch = async (url, opts) => {
      seenUrl = url;
      seenHeaders = opts.headers;
      return new Response(JSON.stringify({ data: [{ id: "qwen2.5-coder" }, { id: "llama3.2" }] }), { status: 200 });
    };
    const models = await fetchModels({ baseUrl: "http://localhost:11434", apiKey: "" }, mockFetch);
    expect(seenUrl).toBe("http://localhost:11434/v1/models");
    expect(seenHeaders.Authorization).toBeUndefined();
    expect(models).toEqual(["llama3.2", "qwen2.5-coder"]);
  });

  test("fetchModels sends Bearer Authorization when apiKey is provided and throws on HTTP error", async () => {
    let seenHeaders = null;
    const okFetch = async (_url, opts) => {
      seenHeaders = opts.headers;
      return new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });
    };
    const models = await fetchModels({ baseUrl: "https://api.openai.com/v1", apiKey: "  sk-123  " }, okFetch);
    expect(seenHeaders.Authorization).toBe("Bearer sk-123");
    expect(models).toEqual(["gpt-4o-mini"]);

    const errFetch = async () => new Response("Unauthorized", { status: 401 });
    await expect(fetchModels({ baseUrl: "https://api.openai.com/v1", apiKey: "bad" }, errFetch)).rejects.toThrow(/401/);
  });

  test("classifySessionTurn retries without response_format when server returns 400", async () => {
    const bodies = [];
    const mockFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (body.response_format) {
        return new Response(JSON.stringify({ error: { message: "response_format unsupported" } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"completed","reason":"Тесты прошли"}' } }],
        }),
        { status: 200 },
      );
    };
    const res = await classifySessionTurn(
      { baseUrl: "http://localhost:11434/v1", apiKey: "sk-test", model: "qwen2.5" },
      { epic: { id: "EPIC-001", title: "Auth", dod: "" }, task: null, terminalTail: "All tests passed", gitStatus: "", gitLog: "", ciSummary: "" },
      mockFetch,
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[0].response_format).toEqual({ type: "json_object" });
    expect(bodies[0].temperature).toBe(0);
    expect(bodies[0].max_tokens).toBe(400);
    expect(bodies[1].response_format).toBeUndefined();
    expect(res).toEqual({ verdict: "completed", reason: "Тесты прошли" });
  });

  test("classifySessionTurn omits Authorization when apiKey is whitespace and throws on non-400 errors", async () => {
    let seenHeaders = null;
    const mockFetch = async (_url, opts) => {
      seenHeaders = opts.headers;
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
    };
    await expect(
      classifySessionTurn(
        { baseUrl: "http://localhost:11434", apiKey: "   ", model: "llama3.2" },
        { epic: { id: "EPIC-001", title: "Auth", dod: "" }, task: null, terminalTail: "", gitStatus: "", gitLog: "", ciSummary: "" },
        mockFetch,
      ),
    ).rejects.toThrow(/429/);
    expect(seenHeaders.Authorization).toBeUndefined();
  });

  test("reviewer mode runs tool-calling inspection loop and returns needs_fix with evidence and issues", async () => {
    const requests = [];
    const toolCallsSeen = [];
    let step = 0;
    const mockFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      requests.push(body);
      step++;
      if (step === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: { name: "git_diff", arguments: '{"target":"working"}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  verdict: "needs_fix",
                  reason: "Агент оставил заглушку TODO вместо реализации",
                  evidence: ["git_diff: +// TODO: implement"],
                  issues: ["Реализовать проверку в src/auth.js"],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const toolExecutor = async (name, args) => {
      toolCallsSeen.push({ name, args });
      return "diff --git a/src/auth.js b/src/auth.js\n+// TODO: implement";
    };

    const res = await classifySessionTurn(
      { baseUrl: "https://api.openai.com/v1", apiKey: "sk-test", model: "gpt-4o" },
      {
        reviewMode: "reviewer",
        epic: { id: "EPIC-001", title: "Auth", dod: "Tests pass" },
        task: { id: "TASK-001.1", title: "Verify token", subitems: [] },
        terminalTail: "Done!",
        gitStatus: "M src/auth.js",
        gitLog: "",
        gitDiff: "",
        ciSummary: "",
      },
      mockFetch,
      toolExecutor,
    );

    expect(requests).toHaveLength(2);
    expect(Array.isArray(requests[0].tools)).toBe(true);
    expect(requests[0].max_tokens).toBeGreaterThanOrEqual(800);
    expect(toolCallsSeen).toEqual([{ name: "git_diff", args: { target: "working" } }]);
    expect(requests[1].messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true);
    expect(res).toEqual({
      verdict: "needs_fix",
      reason: "Агент оставил заглушку TODO вместо реализации",
      evidence: ["git_diff: +// TODO: implement"],
      issues: ["Реализовать проверку в src/auth.js"],
    });
  });

  test("reviewer mode falls back cleanly when endpoint rejects tools with HTTP 400", async () => {
    const bodies = [];
    const mockFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      bodies.push(body);
      if (body.tools) {
        return new Response(JSON.stringify({ error: { message: "tools not supported" } }), { status: 400 });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  verdict: "completed",
                  reason: "Дифф и тесты подтверждают выполнение",
                  evidence: ["34 pass in terminal"],
                  issues: [],
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const res = await classifySessionTurn(
      { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen2.5" },
      {
        reviewMode: "reviewer",
        epic: { id: "EPIC-001", title: "Auth", dod: "" },
        task: null,
        terminalTail: "34 pass, 0 fail",
        gitStatus: "M src/auth.js",
        gitLog: "abc123 feat: auth",
        gitDiff: "+export function verify() { return true; }",
        ciSummary: "",
      },
      mockFetch,
      async () => "unused",
    );

    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies[bodies.length - 1].tools).toBeUndefined();
    expect(res.verdict).toBe("completed");
    expect(res.evidence).toEqual(["34 pass in terminal"]);
  });

  test("waitOnError retries on network errors, timeouts, 5xx/429, and invalid JSON until response arrives", async () => {
    let attempt = 0;
    const retries = [];
    const mockFetch = async () => {
      attempt++;
      if (attempt === 1) throw new Error("ECONNRESET");
      if (attempt === 2) return new Response("Bad Gateway", { status: 502 });
      if (attempt === 3) return new Response("<html>not json</html>", { status: 200 });
      if (attempt === 4) return new Promise(() => {}); // hangs -> triggers timeoutMs
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"verdict":"completed","reason":"Готово"}' } }],
        }),
        { status: 200 },
      );
    };

    const res = await classifySessionTurn(
      { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen2.5" },
      { epic: null, task: null, terminalTail: "ok", gitStatus: "", gitLog: "", ciSummary: "" },
      mockFetch,
      null,
      null,
      {
        waitOnError: true,
        timeoutMs: 20,
        retryDelaysMs: [1],
        onRetry: (info) => retries.push(info),
      },
    );

    expect(attempt).toBe(5);
    expect(retries).toHaveLength(4);
    expect(res).toEqual({ verdict: "completed", reason: "Готово" });
  });

  test("waitOnError stops immediately when shouldAbort returns true or on 401 auth error", async () => {
    let aborted = false;
    let calls = 0;
    const hangingOrFailingFetch = async () => {
      calls++;
      throw new Error("network down");
    };

    await expect(
      classifySessionTurn(
        { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen2.5" },
        { epic: null, task: null, terminalTail: "", gitStatus: "", gitLog: "", ciSummary: "" },
        hangingOrFailingFetch,
        null,
        null,
        {
          waitOnError: true,
          sleepFn: async () => {
            aborted = true;
          },
          shouldAbort: () => aborted,
        },
      ),
    ).rejects.toThrow(/Aborted/);
    expect(calls).toBe(1);

    let authCalls = 0;
    const authFailFetch = async () => {
      authCalls++;
      return new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 });
    };
    await expect(
      classifySessionTurn(
        { baseUrl: "http://localhost:11434/v1", apiKey: "bad", model: "qwen2.5" },
        { epic: null, task: null, terminalTail: "", gitStatus: "", gitLog: "", ciSummary: "" },
        authFailFetch,
        null,
        null,
        { waitOnError: true, sleepFn: async () => {} },
      ),
    ).rejects.toThrow(/401/);
    expect(authCalls).toBe(1);
  });
});

describe("review strictness rubric & history", () => {
  test("resolves default min score (15) and clamps to selected optional checkboxes sum", () => {
    const defaults = getDefaultOptionalReviewChecks();
    expect(defaults).toEqual(["integration_wired", "error_handling", "tests_exist_and_meaningful"]);
    expect(getMaxOptionalReviewScore(defaults)).toBe(21);
    expect(resolveMinReviewScore("", defaults)).toBe(DEFAULT_MIN_REVIEW_SCORE);
    expect(resolveMinReviewScore("999", defaults)).toBe(21);
    expect(resolveMinReviewScore("", ["clean_diff_and_logs"])).toBe(5);
    expect(resolveMinReviewScore("10", [])).toBe(0);
  });

  test("minimum strictness mode evaluates only blocking checks and ignores optional score", () => {
    const allBlockingPass = Object.fromEntries(
      BLOCKING_REVIEW_CHECKS.map((c) => [c.id, { status: "pass", note: "ok" }]),
    );
    const resPass = evaluateReviewRubric(allBlockingPass, { optionalChecks: [], minReviewScore: 15 });
    expect(resPass.passed).toBe(true);
    expect(resPass.blockingPassed).toBe(true);
    expect(resPass.selectedMax).toBe(0);

    const withBlockingFail = {
      ...allBlockingPass,
      no_stubs: { status: "fail", note: "оставлен TODO" },
    };
    const resFail = evaluateReviewRubric(withBlockingFail, { optionalChecks: [], minReviewScore: 0 });
    expect(resFail.passed).toBe(false);
    expect(resFail.blockingPassed).toBe(false);
    expect(resFail.failedBlocking).toHaveLength(1);
  });

  test("blocking failure rejects even when optional score exceeds threshold, while minor optional partial passes", () => {
    const cfg = {
      optionalChecks: ["integration_wired", "error_handling", "tests_exist_and_meaningful", "clean_diff_and_logs"],
      minReviewScore: 15,
    };
    const blockingOk = Object.fromEntries(
      BLOCKING_REVIEW_CHECKS.map((c) => [c.id, { status: "pass", note: "ok" }]),
    );

    const minorPartial = parseClassifierVerdict(
      JSON.stringify({
        state: "reviewed",
        reason: "Основная логика и тесты в порядке, есть мелкий дубль лога",
        checks: {
          ...blockingOk,
          integration_wired: { status: "pass", note: "подключено" },
          error_handling: { status: "pass", note: "ошибки пробрасываются" },
          tests_exist_and_meaningful: { status: "pass", note: "тесты есть" },
          clean_diff_and_logs: { status: "partial", note: "двойной warn!" },
        },
      }),
      cfg,
    );
    expect(minorPartial.verdict).toBe("completed");
    expect(minorPartial.review.earned).toBe(23.5);
    expect(minorPartial.review.effectiveThreshold).toBe(15);

    const blockingBroken = parseClassifierVerdict(
      JSON.stringify({
        state: "reviewed",
        reason: "Есть заглушка",
        checks: {
          ...blockingOk,
          no_stubs: { status: "fail", note: "TODO в auth.js" },
          integration_wired: { status: "pass", note: "ok" },
          error_handling: { status: "pass", note: "ok" },
          tests_exist_and_meaningful: { status: "pass", note: "ok" },
          clean_diff_and_logs: { status: "pass", note: "ok" },
        },
      }),
      cfg,
    );
    expect(blockingBroken.verdict).toBe("needs_fix");
    expect(blockingBroken.review.blockingPassed).toBe(false);
    expect(blockingBroken.issues[0]).toContain("Блокер");

    const lowOptionalScore = parseClassifierVerdict(
      JSON.stringify({
        state: "reviewed",
        reason: "Недостаточно баллов по доп. критериям",
        checks: {
          ...blockingOk,
          integration_wired: { status: "pass", note: "ok" },
          error_handling: { status: "fail", note: "ошибки глотаются" },
          tests_exist_and_meaningful: { status: "fail", note: "нет тестов" },
          clean_diff_and_logs: { status: "pass", note: "ok" },
        },
      }),
      cfg,
    );
    expect(lowOptionalScore.verdict).toBe("needs_fix");
    expect(lowOptionalScore.review.earned).toBe(12);
    expect(lowOptionalScore.review.scorePassed).toBe(false);
  });

  test("buildReviewerMessages includes strictness rubric, attempt number, and previous review history", () => {
    const msgs = buildReviewerMessages(
      {
        epic: { id: "EPIC-1", title: "Core", goal: "Goal", dod: "DoD" },
        task: { id: "TASK-1.1", title: "Fix", subitems: ["Sub 1"] },
        terminalTail: "cargo test ok",
        reviewConfig: {
          optionalChecks: ["error_handling", "clean_diff_and_logs"],
          minReviewScore: 10,
        },
        reviewAttempt: 2,
        reviewHistory: [
          {
            attempt: 1,
            verdict: "needs_fix",
            reason: "Пропущена обработка ошибки",
            issues: ["Обработать Err в lib.rs"],
            review: {
              earned: 5,
              applicableMax: 13,
              effectiveThreshold: 10,
              checks: {
                requirements_met: { id: "requirements_met", status: "pass", note: "ok" },
                error_handling: { id: "error_handling", status: "fail", note: "unwrap()" },
              },
            },
          },
        ],
      },
      true,
    );

    expect(msgs[0].content).toContain("required threshold: 10/13 pts");
    expect(msgs[0].content).toContain('"error_handling" (+8 pts)');
    expect(msgs[0].content).not.toContain('"modularity_no_god_object"');
    expect(msgs[1].content).toContain("Current review attempt: #2");
    expect(msgs[1].content).toContain("Previous review history");
    expect(msgs[1].content).toContain("Обработать Err в lib.rs");
    expect(msgs[1].content).toContain("Passed checks: requirements_met");

    const minMsgs = buildReviewerMessages(
      {
        terminalTail: "ok",
        reviewConfig: { optionalChecks: [], minReviewScore: 0 },
      },
      false,
    );
    expect(minMsgs[0].content).toContain("minimum strictness mode");
    expect(OPTIONAL_REVIEW_CHECKS.length).toBeGreaterThan(0);
  });
});
