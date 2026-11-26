import { describe, expect, test } from "bun:test";
import { checkOrcaUpdate, runOrcaUpdate } from "../mods/orca/updater.js";

describe("checkOrcaUpdate", () => {
  test("detects available update in git repo when remote HEAD differs from local HEAD", async () => {
    const remoteSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const localSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const mockExec = async (cmd, args) => {
      if (cmd === "git" && args.includes("ls-remote")) {
        return { code: 0, stdout: `${remoteSha}\tHEAD\n`, stderr: "" };
      }
      if (cmd === "git" && args.includes("--show-toplevel")) {
        return { code: 0, stdout: "C:/repos/herdr-orca\n", stderr: "" };
      }
      if (cmd === "git" && args.includes("rev-parse") && args.includes("HEAD")) {
        return { code: 0, stdout: `${localSha}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await checkOrcaUpdate({
      appHomeDir: "C:/Users/dev/.config/herdr-app",
      execFn: mockExec,
      readTextFileFn: async () => null,
      platform: "windows",
    });

    expect(res.ok).toBe(true);
    expect(res.available).toBe(true);
    expect(res.remoteSha).toBe(remoteSha);
  });

  test("reports up-to-date in non-git install when knownSha matches remote HEAD without cloning", async () => {
    const remoteSha = "cccccccccccccccccccccccccccccccccccccccc";
    let cloned = false;
    const mockExec = async (cmd, args) => {
      if (cmd === "git" && args.includes("ls-remote")) {
        return { code: 0, stdout: `${remoteSha}\tHEAD\n`, stderr: "" };
      }
      if (cmd === "git" && args.includes("--show-toplevel")) {
        return { code: 128, stdout: "", stderr: "not a git repository" };
      }
      if (cmd === "git" && args.includes("clone")) {
        cloned = true;
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await checkOrcaUpdate({
      appHomeDir: "C:/Users/dev/.config/herdr-app",
      knownSha: remoteSha,
      execFn: mockExec,
      readTextFileFn: async () => null,
      platform: "windows",
    });

    expect(res.ok).toBe(true);
    expect(res.available).toBe(false);
    expect(cloned).toBe(false);
  });

  test("compares files on first non-git check when knownSha is absent and returns syncedSha if identical", async () => {
    const remoteSha = "dddddddddddddddddddddddddddddddddddddddd";
    const mockExec = async (cmd, args) => {
      if (cmd === "git" && args.includes("ls-remote")) {
        return { code: 0, stdout: `${remoteSha}\tHEAD\n`, stderr: "" };
      }
      if (cmd === "git" && args.includes("--show-toplevel")) {
        return { code: 128, stdout: "", stderr: "not a git repository" };
      }
      if (cmd === "powershell") {
        return { code: 0, stdout: "C:/Temp/orca-chk\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await checkOrcaUpdate({
      appHomeDir: "C:/Users/dev/.config/herdr-app",
      knownSha: null,
      execFn: mockExec,
      readTextFileFn: async () => "same content\n",
      platform: "windows",
    });

    expect(res.ok).toBe(true);
    expect(res.available).toBe(false);
    expect(res.syncedSha).toBe(remoteSha);
  });

  test("returns available=false and ok=false when git ls-remote fails", async () => {
    const mockExec = async () => ({ code: 128, stdout: "", stderr: "Could not resolve host" });
    const res = await checkOrcaUpdate({
      appHomeDir: "C:/Users/dev/.config/herdr-app",
      execFn: mockExec,
      readTextFileFn: async () => null,
      platform: "windows",
    });

    expect(res.ok).toBe(false);
    expect(res.available).toBe(false);
  });
});

describe("runOrcaUpdate", () => {
  test("uses ordinary git pull --ff-only when mods/orca is in a git repo and skips model", async () => {
    const calls = [];
    let fetchCalled = false;
    const mockExec = async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === "git" && args.includes("rev-parse")) {
        return { code: 0, stdout: "C:/repos/herdr-orca\n", stderr: "" };
      }
      if (cmd === "git" && args.includes("pull")) {
        return { code: 0, stdout: "Updating abc..def\nFast-forward\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await runOrcaUpdate({
      appHomeDir: "C:/Users/dev/.config/herdr-app",
      settings: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5" },
      execFn: mockExec,
      readTextFileFn: async () => null,
      writeTextFileFn: async () => null,
      fetchFn: async () => {
        fetchCalled = true;
        throw new Error("should not call model");
      },
      platform: "windows",
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("git_pull");
    expect(res.updated).toBe(true);
    expect(fetchCalled).toBe(false);
    expect(calls.some((c) => c.cmd === "git" && c.args.includes("--ff-only"))).toBe(true);
  });

  test("returns clear error when git pull fails and model is not configured", async () => {
    const mockExec = async (cmd, args) => {
      if (cmd === "git" && args.includes("rev-parse")) {
        return { code: 0, stdout: "C:/repos/herdr-orca\n", stderr: "" };
      }
      if (cmd === "git" && args.includes("pull")) {
        return { code: 1, stdout: "", stderr: "error: Your local changes would be overwritten by merge" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await runOrcaUpdate({
      appHomeDir: "C:/Users/dev/.config/herdr-app",
      settings: { baseUrl: "", model: "" },
      execFn: mockExec,
      readTextFileFn: async () => null,
      writeTextFileFn: async () => null,
      platform: "windows",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("Настройте модель");
  });

  test("falls back to model from settings when git pull fails and applies update via tools", async () => {
    const written = [];
    let step = 0;
    const mockExec = async (cmd, args) => {
      if (cmd === "git" && args.includes("rev-parse")) {
        return { code: 0, stdout: "C:/repos/herdr-orca\n", stderr: "" };
      }
      if (cmd === "git" && args.includes("pull")) {
        return { code: 1, stdout: "", stderr: "fatal: Not possible to fast-forward, aborting." };
      }
      if (cmd === "git" && args.includes("status")) {
        return { code: 0, stdout: " M mods/orca/ui.js\n", stderr: "" };
      }
      if (cmd === "git" && args.includes("clone")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const mockFetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      step++;
      if (step === 1) {
        expect(Array.isArray(body.tools)).toBe(true);
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
                      function: {
                        name: "write_local_file",
                        arguments: JSON.stringify({
                          path: "mods/orca/ui.js",
                          content: "// merged ui\n",
                        }),
                      },
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
                content: JSON.stringify({ ok: true, summary: "Обновлено с сохранением локальных правок" }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    const res = await runOrcaUpdate({
      appHomeDir: "C:/Users/dev/.config/herdr-app",
      settings: { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen2.5" },
      execFn: mockExec,
      readTextFileFn: async () => "// old ui\n",
      writeTextFileFn: async (path, text, expected) => {
        written.push({ path, text, expected });
        return null;
      },
      fetchFn: mockFetch,
      platform: "windows",
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("model");
    expect(written).toEqual([
      { path: "C:/repos/herdr-orca/mods/orca/ui.js", text: "// merged ui\n", expected: "// old ui\n" },
    ]);
  });

  test("clones upstream and syncs files when installed without git, skipping model on clean sync", async () => {
    const execCalls = [];
    let fetchCalled = false;
    const mockExec = async (cmd, args) => {
      execCalls.push({ cmd, args });
      if (cmd === "git" && args.includes("rev-parse")) {
        return { code: 128, stdout: "", stderr: "not a git repository" };
      }
      if (cmd === "git" && args.includes("clone")) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const res = await runOrcaUpdate({
      appHomeDir: "C:/Users/dev/.config/herdr-app",
      settings: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5" },
      execFn: mockExec,
      readTextFileFn: async () => null,
      writeTextFileFn: async () => null,
      fetchFn: async () => {
        fetchCalled = true;
        throw new Error("should not call model");
      },
      platform: "windows",
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("sync");
    expect(fetchCalled).toBe(false);
    expect(execCalls.some((c) => c.cmd === "git" && c.args.includes("clone"))).toBe(true);
  });
});
