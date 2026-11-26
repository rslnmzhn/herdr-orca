// Self-updater for Orca: tries ordinary git pull / upstream sync first,
// and falls back to the configured OpenAI-compatible model only if ordinary update fails.
// Zero Herdr host/UI imports and zero Node APIs so it runs in both Herdr and bun test.

import { normPath, joinPath } from "./paths.js";
import {
  normalizeBaseUrl,
  buildHeaders,
  readErrorDetail,
  tryParseJsonObject,
  postAndParseJson,
} from "./classifier.js";
import { resolveSafeRepoPath } from "./reviewer_tools.js";

export const UPSTREAM_REPO = "https://github.com/rslnmzhn/herdr-orca.git";
const MAX_UPDATE_TOOL_ROUNDS = 10;

const UPDATE_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the local install or cloned upstream repo.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["local", "upstream"] },
          dir: { type: "string", description: "Optional relative subdirectory (e.g. mods/orca)." },
        },
        required: ["source"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 file from local install or cloned upstream repo.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["local", "upstream"] },
          path: { type: "string", description: "Relative path (e.g. mods/orca/ui.js or RECIPE.md)." },
        },
        required: ["source", "path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_local_file",
      description: "Write updated UTF-8 content to a file under mods/ or layouts/ in the local install.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path under mods/ or layouts/." },
          content: { type: "string", description: "Full updated file content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_check",
      description: "Run `herdr-app check` on mods/orca, mods/tabs-orca, and mods/agents-orca.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  },
];

function isAllowedWriteRelPath(rel) {
  const clean = String(rel ?? "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  if (!clean || clean.includes("..")) return false;
  return clean.startsWith("mods/") || clean.startsWith("layouts/");
}

async function makeTempDir(execFn, platform) {
  const id = `herdr-orca-upd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  if (platform === "windows") {
    const script =
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
      `$d = Join-Path $env:TEMP '${id}'; New-Item -ItemType Directory -Force -Path $d | Out-Null; $d`;
    const r = await execFn("powershell", ["-NoProfile", "-Command", script]);
    if (r.code !== 0) throw new Error(r.stderr?.trim() || "Failed to create temp dir");
    return normPath(r.stdout.trim()) || `/tmp/${id}`;
  }
  const r = await execFn("sh", ["-c", `d="\${TMPDIR:-/tmp}/${id}"; mkdir -p "$d" && printf "%s" "$d"`]);
  if (r.code !== 0) throw new Error(r.stderr?.trim() || "Failed to create temp dir");
  return normPath(r.stdout.trim()) || `/tmp/${id}`;
}

async function removeTempDir(dir, execFn, platform) {
  if (!dir) return;
  if (platform === "windows") {
    const escaped = dir.replace(/['‘’‚‛]/g, "$&$&");
    await execFn("powershell", [
      "-NoProfile",
      "-Command",
      `Remove-Item -LiteralPath '${escaped}' -Recurse -Force -ErrorAction SilentlyContinue`,
    ]).catch(() => {});
    return;
  }
  await execFn("rm", ["-rf", dir]).catch(() => {});
}

async function syncFromUpstream(upstreamDir, appHomeDir, execFn, platform) {
  if (platform === "windows") {
    const srcEsc = upstreamDir.replace(/['‘’‚‛]/g, "$&$&");
    const dstEsc = appHomeDir.replace(/['‘’‚‛]/g, "$&$&");
    const script =
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
      `& { param($src, $dst) ` +
      `foreach ($m in @('orca','tabs-orca','agents-orca')) { ` +
      `  $s = Join-Path $src "mods\\$m"; if (Test-Path -LiteralPath $s) { ` +
      `    $d = Join-Path $dst "mods\\$m"; New-Item -ItemType Directory -Force -Path $d | Out-Null; ` +
      `    Get-ChildItem -LiteralPath $s -Force | Where-Object { $_.Name -notin @('.git','jsconfig.json','gpui-kit.d.ts') } | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $d -Recurse -Force } ` +
      `  } ` +
      `} ` +
      `$l = Join-Path $src 'layouts\\main-orca.json'; if (Test-Path -LiteralPath $l) { ` +
      `  $ld = Join-Path $dst 'layouts'; New-Item -ItemType Directory -Force -Path $ld | Out-Null; ` +
      `  Copy-Item -LiteralPath $l -Destination (Join-Path $ld 'main-orca.json') -Force ` +
      `} } '${srcEsc}' '${dstEsc}'`;
    return execFn("powershell", ["-NoProfile", "-Command", script]);
  }

  const shScript =
    'src="$1"; dst="$2"; ' +
    'for m in orca tabs-orca agents-orca; do ' +
    '  if [ -d "$src/mods/$m" ]; then ' +
    '    mkdir -p "$dst/mods/$m" && cp -R "$src/mods/$m/." "$dst/mods/$m/" || exit 1; ' +
    '  fi; ' +
    'done; ' +
    'if [ -f "$src/layouts/main-orca.json" ]; then ' +
    '  mkdir -p "$dst/layouts" && cp "$src/layouts/main-orca.json" "$dst/layouts/main-orca.json" || exit 1; ' +
    'fi';
  return execFn("sh", ["-c", shScript, "orca-upd", upstreamDir, appHomeDir]);
}

async function runHerdrChecks(appHomeDir, execFn, platform) {
  const mods = ["orca", "tabs-orca", "agents-orca"];
  const candidates =
    platform === "windows"
      ? ["herdr-app", "herdr-app.exe"]
      : ["herdr-app"];

  let bin = candidates[0];
  if (platform === "windows") {
    const probe = await execFn("powershell", [
      "-NoProfile",
      "-Command",
      "$c = Get-Command herdr-app -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { $p = Join-Path $env:LOCALAPPDATA 'Programs\\herdr-app\\herdr-app.exe'; if (Test-Path $p) { $p } }",
    ]).catch(() => null);
    if (probe?.code === 0 && probe.stdout?.trim()) {
      bin = probe.stdout.trim().split(/\r?\n/)[0].trim();
    }
  }

  const outputs = [];
  for (const m of mods) {
    const modPath = joinPath(appHomeDir, `mods/${m}`);
    const res = await execFn(bin, ["check", modPath]).catch((e) => ({
      code: 127,
      stdout: "",
      stderr: String(e?.message ?? e),
    }));
    if (res.code === 127 || /program not found|cannot start/i.test(res.stderr || "")) {
      return { ok: true, skipped: true, output: "herdr-app CLI not found in PATH; skipped check" };
    }
    outputs.push(`${m}: ${res.code === 0 ? "OK" : (res.stderr || res.stdout || `exit ${res.code}`).trim()}`);
    if (res.code !== 0) {
      return { ok: false, skipped: false, output: outputs.join("\n") };
    }
  }
  return { ok: true, skipped: false, output: outputs.join("\n") };
}

async function listDirFiles(rootDir, relDir, execFn, platform) {
  const target = relDir ? resolveSafeRepoPath(rootDir, relDir) : normPath(rootDir);
  if (!target) return "Error: invalid directory";
  if (platform === "windows") {
    const esc = target.replace(/['‘’‚‛]/g, "$&$&");
    const script =
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
      `& { param($p) if (-not (Test-Path -LiteralPath $p)) { exit 2 }; ` +
      `Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.FullName -notmatch '\\\\\\.git\\\\' -and $_.Name -notin @('jsconfig.json','gpui-kit.d.ts') } | ` +
      `Select-Object -First 150 -ExpandProperty FullName } '${esc}'`;
    const r = await execFn("powershell", ["-NoProfile", "-Command", script]);
    if (r.code !== 0) return `Error: ${(r.stderr || "cannot list").trim()}`;
    const prefix = `${normPath(rootDir)}/`;
    return (r.stdout || "")
      .split(/\r?\n/)
      .map((l) => normPath(l))
      .filter(Boolean)
      .map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p))
      .join("\n") || "(empty)";
  }
  const r = await execFn("sh", [
    "-c",
    'cd "$1" && find "${2:-.}" -maxdepth 4 -type f ! -path "*/.git/*" ! -name "jsconfig.json" ! -name "gpui-kit.d.ts" | head -n 150',
    "orca-list",
    normPath(rootDir),
    relDir || ".",
  ]);
  if (r.code !== 0) return `Error: ${(r.stderr || "cannot list").trim()}`;
  return (r.stdout || "").trim() || "(empty)";
}

async function runModelUpdate({
  settings,
  localRoot,
  upstreamDir,
  appHomeDir,
  failureReason,
  gitContext,
  execFn,
  readTextFileFn,
  writeTextFileFn,
  fetchFn,
  platform,
  onProgress,
}) {
  const baseUrl = normalizeBaseUrl(settings?.baseUrl);
  const model = typeof settings?.model === "string" ? settings.model.trim() : "";
  if (!baseUrl || !model) {
    return {
      ok: false,
      method: "none",
      error: `Обычный pull не удался (${failureReason}). Настройте модель в Настройках для автообновления.`,
    };
  }

  onProgress?.(`Обычный pull не помог — запуск модели ${model}…`);

  const url = `${baseUrl}/chat/completions`;
  const headers = buildHeaders(settings?.apiKey, {
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  const systemPrompt = [
    "You are updating the `herdr-orca` Herdr mod bundle from its upstream GitHub repository because an ordinary git pull/sync failed.",
    "Use your tools (`list_files`, `read_file`, `write_local_file`, `run_check`) to inspect the upstream files and local files, merge/apply the upstream update cleanly without breaking local customizations or leaving conflict markers, and verify with `run_check`.",
    "Only write files under `mods/` or `layouts/`. Never write `.git`, `shared.json`, `settings.json`, or `keys.json`.",
    'When finished, respond strictly with JSON: {"ok":true|false,"summary":"concise Russian summary"}.',
  ].join("\n");

  const userParts = [
    `Ordinary update failure: ${failureReason}`,
    `Local root: ${localRoot}`,
    `Upstream clone: ${upstreamDir}`,
  ];
  if (gitContext) userParts.push(`Git context:\n${gitContext}`);

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userParts.join("\n\n") },
  ];

  const executeTool = async (name, args) => {
    if (name === "list_files") {
      const root = args?.source === "upstream" ? upstreamDir : localRoot;
      return listDirFiles(root, args?.dir || "", execFn, platform);
    }
    if (name === "read_file") {
      const root = args?.source === "upstream" ? upstreamDir : localRoot;
      const resolved = resolveSafeRepoPath(root, args?.path);
      if (!resolved) return "Error: invalid path";
      const text = await readTextFileFn(resolved).catch(() => null);
      if (text === null || text === undefined) return `Error: file not found (${resolved})`;
      return String(text).slice(0, 24000);
    }
    if (name === "write_local_file") {
      if (!isAllowedWriteRelPath(args?.path)) {
        return "Error: writes are restricted to mods/ and layouts/";
      }
      const resolved = resolveSafeRepoPath(localRoot, args.path);
      if (!resolved) return "Error: invalid path";
      const existing = await readTextFileFn(resolved).catch(() => null);
      await writeTextFileFn(resolved, String(args.content ?? ""), existing ?? null);
      return `OK: wrote ${args.path}`;
    }
    if (name === "run_check") {
      const chk = await runHerdrChecks(appHomeDir, execFn, platform);
      return `${chk.ok ? "PASS" : "FAIL"}\n${chk.output}`;
    }
    return `Error: unknown tool ${name}`;
  };

  let useResponseFormat = true;
  for (let round = 0; round < MAX_UPDATE_TOOL_ROUNDS; round++) {
    const body = {
      model,
      messages,
      temperature: 0,
      max_tokens: 2000,
      tools: UPDATE_TOOLS,
      tool_choice: "auto",
    };
    if (useResponseFormat) body.response_format = { type: "json_object" };

    let { res, data } = await postAndParseJson(url, headers, body, fetchFn, {});
    if ((res.status === 400 || res.status === 422) && useResponseFormat) {
      await res.body?.cancel?.().catch(() => {});
      useResponseFormat = false;
      delete body.response_format;
      ({ res, data } = await postAndParseJson(url, headers, body, fetchFn, {}));
    }
    if (!res.ok) {
      const detail = await readErrorDetail(res);
      return { ok: false, method: "model", error: `Ошибка модели обновления (HTTP ${res.status}): ${detail}` };
    }

    const msg = data?.choices?.[0]?.message;
    const toolCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    if (toolCalls.length === 0) {
      const parsed = tryParseJsonObject(String(msg?.content ?? "").trim());
      if (parsed && typeof parsed.ok === "boolean") {
        return {
          ok: parsed.ok,
          method: "model",
          updated: parsed.ok,
          message: parsed.summary || (parsed.ok ? "Обновлено моделью" : "Модель не смогла обновить"),
          error: parsed.ok ? null : parsed.summary || "Модель не смогла обновить",
        };
      }
      return {
        ok: false,
        method: "model",
        error: "Модель вернула некорректный ответ при обновлении",
      };
    }

    messages.push({ role: "assistant", content: msg?.content ?? null, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const fnName = tc?.function?.name ?? "";
      let parsedArgs = {};
      try {
        const raw = tc?.function?.arguments;
        parsedArgs = typeof raw === "string" && raw.trim() ? JSON.parse(raw) : {};
      } catch {
        parsedArgs = {};
      }
      onProgress?.(`Модель: ${fnName}${parsedArgs?.path ? `(${parsedArgs.path})` : ""}`);
      const out = await executeTool(fnName, parsedArgs);
      messages.push({
        role: "tool",
        tool_call_id: tc?.id ?? `upd_${round}`,
        content: String(out ?? ""),
      });
    }
  }

  return { ok: false, method: "model", error: "Превышен лимит шагов модели при обновлении" };
}

const CHECK_FILES = [
  "mods/orca/main.js",
  "mods/orca/ui.js",
  "mods/orca/updater.js",
  "mods/orca/classifier.js",
  "mods/orca/ci.js",
  "mods/orca/parser.js",
  "mods/orca/sessions.js",
  "mods/tabs-orca/main.js",
  "mods/agents-orca/main.js",
  "layouts/main-orca.json",
];

function parseSha(raw) {
  const m = String(raw ?? "").match(/\b([0-9a-f]{40})\b/i);
  return m ? m[1].toLowerCase() : null;
}

async function readHeadSha(dir, execFn) {
  const r = await execFn("git", ["-C", dir, "rev-parse", "HEAD"]).catch(() => null);
  return r?.code === 0 ? parseSha(r.stdout) : null;
}

export async function checkOrcaUpdate({
  appHomeDir,
  knownSha = null,
  execFn,
  readTextFileFn,
  platform = "windows",
}) {
  const cleanHome = normPath(appHomeDir);
  if (!cleanHome) {
    return { ok: false, available: false, error: "Не определён каталог Herdr" };
  }

  const lsRes = await execFn("git", ["ls-remote", UPSTREAM_REPO, "HEAD"]).catch((e) => ({
    code: 1,
    stdout: "",
    stderr: String(e?.message ?? e),
  }));
  const remoteSha = lsRes?.code === 0 ? parseSha(lsRes.stdout) : null;
  if (!remoteSha) {
    return {
      ok: false,
      available: false,
      error: (lsRes?.stderr || lsRes?.stdout || "Не удалось проверить обновления").trim(),
    };
  }

  const orcaDir = joinPath(cleanHome, "mods/orca");
  const topRes = await execFn("git", ["-C", orcaDir, "rev-parse", "--show-toplevel"]).catch(() => null);
  const repoRoot = topRes?.code === 0 ? normPath(topRes.stdout?.trim()) : null;

  if (repoRoot) {
    const localSha = await readHeadSha(repoRoot, execFn);
    if (!localSha) {
      return { ok: true, available: true, remoteSha };
    }
    return {
      ok: true,
      available: localSha !== remoteSha,
      remoteSha,
      localSha,
    };
  }

  const cleanKnown = parseSha(knownSha);
  if (cleanKnown) {
    return {
      ok: true,
      available: cleanKnown !== remoteSha,
      remoteSha,
    };
  }

  let tempDir = null;
  try {
    tempDir = await makeTempDir(execFn, platform);
    const cloneRes = await execFn("git", ["clone", "--depth", "1", UPSTREAM_REPO, tempDir]);
    if (cloneRes.code !== 0) {
      return {
        ok: false,
        available: false,
        error: (cloneRes.stderr || cloneRes.stdout || "git clone failed").trim(),
      };
    }

    for (const rel of CHECK_FILES) {
      const [localText, remoteText] = await Promise.all([
        readTextFileFn(joinPath(cleanHome, rel)).catch(() => null),
        readTextFileFn(joinPath(tempDir, rel)).catch(() => null),
      ]);
      if (remoteText === null || remoteText === undefined) continue;
      if (localText === null || localText === undefined) {
        return { ok: true, available: true, remoteSha };
      }
      if (String(localText).replace(/\r\n/g, "\n") !== String(remoteText).replace(/\r\n/g, "\n")) {
        return { ok: true, available: true, remoteSha };
      }
    }

    return { ok: true, available: false, remoteSha, syncedSha: remoteSha };
  } finally {
    await removeTempDir(tempDir, execFn, platform);
  }
}

export async function runOrcaUpdate({
  appHomeDir,
  settings,
  execFn,
  readTextFileFn,
  writeTextFileFn,
  fetchFn = fetch,
  platform = "windows",
  onProgress = null,
}) {
  const cleanHome = normPath(appHomeDir);
  if (!cleanHome) {
    return { ok: false, method: "none", error: "Не определён каталог Herdr" };
  }

  const orcaDir = joinPath(cleanHome, "mods/orca");
  let tempDir = null;

  try {
    onProgress?.("Проверка git-репозитория…");
    const topRes = await execFn("git", ["-C", orcaDir, "rev-parse", "--show-toplevel"]).catch(() => null);
    const repoRoot = topRes?.code === 0 ? normPath(topRes.stdout?.trim()) : null;

    if (repoRoot) {
      onProgress?.("Выполняется git pull --ff-only…");
      const pullRes = await execFn("git", ["-C", repoRoot, "pull", "--ff-only"]).catch((e) => ({
        code: 1,
        stdout: "",
        stderr: String(e?.message ?? e),
      }));

      if (pullRes.code === 0) {
        const out = `${pullRes.stdout || ""}\n${pullRes.stderr || ""}`.trim();
        const upToDate = /already up[- ]to[- ]date/i.test(out);
        const remoteSha = await readHeadSha(repoRoot, execFn);
        return {
          ok: true,
          method: "git_pull",
          updated: !upToDate,
          remoteSha,
          message: upToDate ? "Orca уже актуален" : "Orca обновлён через git pull",
        };
      }

      const failureReason = (pullRes.stderr || pullRes.stdout || "git pull failed").trim();
      const stRes = await execFn("git", ["-C", repoRoot, "status", "--short"]).catch(() => null);
      const gitContext = stRes?.code === 0 ? stRes.stdout?.trim() : "";

      const baseUrl = normalizeBaseUrl(settings?.baseUrl);
      const model = typeof settings?.model === "string" ? settings.model.trim() : "";
      if (!baseUrl || !model) {
        return {
          ok: false,
          method: "none",
          error: `Обычный pull не удался (${failureReason}). Настройте модель в Настройках для автообновления.`,
        };
      }

      tempDir = await makeTempDir(execFn, platform);
      const cloneRes = await execFn("git", ["clone", "--depth", "1", UPSTREAM_REPO, tempDir]);
      if (cloneRes.code !== 0) {
        return {
          ok: false,
          method: "none",
          error: `Не удалось клонировать ${UPSTREAM_REPO}: ${(cloneRes.stderr || cloneRes.stdout || "").trim()}`,
        };
      }

      const upstreamSha = await readHeadSha(tempDir, execFn);
      const modelRes = await runModelUpdate({
        settings,
        localRoot: repoRoot,
        upstreamDir: tempDir,
        appHomeDir: cleanHome,
        failureReason,
        gitContext,
        execFn,
        readTextFileFn,
        writeTextFileFn,
        fetchFn,
        platform,
        onProgress,
      });
      return modelRes.ok && upstreamSha ? { ...modelRes, remoteSha: upstreamSha } : modelRes;
    }

    onProgress?.("Загрузка обновления из GitHub…");
    tempDir = await makeTempDir(execFn, platform);
    const cloneRes = await execFn("git", ["clone", "--depth", "1", UPSTREAM_REPO, tempDir]);
    if (cloneRes.code !== 0) {
      return {
        ok: false,
        method: "none",
        error: `Не удалось загрузить обновление: ${(cloneRes.stderr || cloneRes.stdout || "git clone failed").trim()}`,
      };
    }

    const upstreamSha = await readHeadSha(tempDir, execFn);
    onProgress?.("Копирование файлов Orca…");
    const syncRes = await syncFromUpstream(tempDir, cleanHome, execFn, platform);
    const checkRes = syncRes.code === 0 ? await runHerdrChecks(cleanHome, execFn, platform) : null;

    if (syncRes.code === 0 && checkRes?.ok) {
      return {
        ok: true,
        method: "sync",
        updated: true,
        remoteSha: upstreamSha,
        message: "Orca обновлён из GitHub",
      };
    }

    const failureReason =
      syncRes.code !== 0
        ? (syncRes.stderr || syncRes.stdout || "Ошибка копирования файлов").trim()
        : `Проверка модов не прошла:\n${checkRes?.output || ""}`;

    const modelRes = await runModelUpdate({
      settings,
      localRoot: cleanHome,
      upstreamDir: tempDir,
      appHomeDir: cleanHome,
      failureReason,
      gitContext: "",
      execFn,
      readTextFileFn,
      writeTextFileFn,
      fetchFn,
      platform,
      onProgress,
    });
    return modelRes.ok && upstreamSha ? { ...modelRes, remoteSha: upstreamSha } : modelRes;
  } finally {
    await removeTempDir(tempDir, execFn, platform);
  }
}
