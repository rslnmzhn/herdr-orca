import { View } from "gpui-kit";
import { v_flex, InputState } from "gpui-base";
import {
  spaces,
  panes,
  focused,
  agents,
  terminals,
  exec,
  hc,
  home,
  readTextFile,
  writeTextFile,
  watchFolder,
  pickFolder,
  notify,
  playSound,
  theme,
  nextCommand,
  checking,
  window,
  shared,
  setShared,
  settings,
  props,
} from "herdr";
import {
  isEpicFilename,
  isNumberedEpicFilename,
  parseEpicFile,
  updateEpicStatus,
  updateTaskStatus,
  buildAgentPrompt,
  listQueueItems,
  pickNextQueueItem,
} from "./parser.js";
import { normPath, joinPath, parentDir, expandTilde } from "./paths.js";
import { normalizeBaseUrl, fetchModels, classifySessionTurn } from "./classifier.js";
import {
  checkGithubCiStatus,
  fetchFailedCiLogs,
  shouldRetryCi,
  buildCiFixPrompt,
} from "./ci.js";
import { resolveStartAction, resolveCompletedCiAction } from "./guards.js";
import { createReviewerToolExecutor, buildReviewFixPrompt } from "./reviewer_tools.js";
import {
  statusMeta,
  renderHeader,
  renderSessionAndBacklog,
  renderPipelineStrip,
  renderQueueAndLog,
  renderFooterAndSettings,
} from "./ui.js";

const STORAGE_SETTINGS = "orca.settings";
const STORAGE_FOLDERS = "orca.folders";
const STORAGE_MODE = "orca.mode";
const STORAGE_UI = "orca.ui";

const SENT_GRACE_MS = 10000;
const IDLE_DEBOUNCE_MS = 2000;
const MAX_LOGS = 200;

const remoteHomeCache = new Map();

function parseNonNegativeInt(val, fallback = 3) {
  if (val === undefined || val === null || val === "") return fallback;
  const parsed = Number(val);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeSettings(raw) {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl.trim() : "";
  const apiKey = typeof obj.apiKey === "string" ? obj.apiKey : "";
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  const maxCiRetries = parseNonNegativeInt(obj.maxCiRetries, 3);
  const maxReviewRetries = parseNonNegativeInt(obj.maxReviewRetries, 3);
  const reviewMode = obj.reviewMode === "auto" ? "auto" : "reviewer";
  const parsedPoll = Number(obj.ciPollMinutes);
  const ciPollMinutes = Number.isFinite(parsedPoll) && parsedPoll > 0 ? parsedPoll : 5;
  return {
    baseUrl,
    apiKey,
    model,
    maxCiRetries,
    maxReviewRetries,
    reviewMode,
    ciPollMinutes,
  };
}

function queueItemKey(item) {
  if (!item?.epic?.filePath) return null;
  const line = item.task?.lineIndex ?? "epic";
  return `${item.epic.filePath}::${line}`;
}

async function getHomeDir(on) {
  if (!on) return normPath(home());
  if (remoteHomeCache.has(on)) return remoteHomeCache.get(on);

  const tryPowerShell = async () => {
    try {
      const r = await exec(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $HOME",
        ],
        { on },
      );
      if (r.code === 0 && r.stdout.trim()) {
        const resolved = normPath(r.stdout.trim());
        if (resolved) remoteHomeCache.set(on, resolved);
        return resolved;
      }
    } catch {}
    return null;
  };

  try {
    const r = await exec("sh", ["-c", 'printf "%s" "$HOME"'], { on });
    if (r.code === 0 && r.stdout.trim()) {
      const resolved = normPath(r.stdout.trim());
      if (resolved) remoteHomeCache.set(on, resolved);
      return resolved;
    }
  } catch (e) {
    const msg = String(e);
    if (msg.includes("program not found") || msg.includes("cannot start sh")) {
      return tryPowerShell();
    }
  }
  return null;
}

async function resolvePath(p, on) {
  const clean = normPath(p);
  if (!clean) return null;
  if (clean === "~" || clean.startsWith("~/")) {
    const h = await getHomeDir(on);
    return expandTilde(clean, h);
  }
  return clean;
}

async function listMarkdownFiles(dir, on) {
  const cleanDir = await resolvePath(dir, on);
  if (!cleanDir) return null;

  const runPowerShell = async () => {
    const escaped = cleanDir.replace(/['‘’‚‛]/g, "$&$&");
    const script =
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); " +
      "& { param($p) if (-not (Test-Path -LiteralPath $p -PathType Container)) { exit 2 }; " +
      "ConvertTo-Json -Compress -InputObject @(Get-ChildItem -LiteralPath $p -File -Filter '*.md' -ErrorAction Stop | Select-Object -ExpandProperty Name) } " +
      `'${escaped}'`;
    const r = await exec("powershell", ["-NoProfile", "-Command", script], { on });
    if (r.code !== 0) return null;
    const parsed = JSON.parse(r.stdout || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  };

  if (!on && window()?.platform === "windows") {
    return runPowerShell();
  }

  const shScript =
    'd="$1"; test -d "$d" || exit 2; case "$d" in */) ;; *) d="$d/";; esac; for p in "${d}"*.md "${d}"*.MD; do [ -f "$p" ] || continue; printf "%s\\0" "${p##*/}"; done';
  try {
    const r = await exec("sh", ["-c", shScript, "orca", cleanDir], { on });
    if (r.code !== 0) return null;
    return r.stdout.split("\0").filter(Boolean);
  } catch (e) {
    const msg = String(e);
    if (
      on &&
      (msg.includes("program not found") ||
        msg.includes("cannot start sh") ||
        /^[A-Za-z]:\//.test(cleanDir))
    ) {
      return runPowerShell();
    }
    return null;
  }
}

async function gitTopLevel(cwd, on) {
  const cleanCwd = await resolvePath(cwd, on);
  if (!cleanCwd) return null;
  try {
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: cleanCwd, on });
    if (r.code !== 0) return null;
    return normPath(r.stdout.trim());
  } catch {
    return null;
  }
}

export default class Orca extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.size = null;

    this.state = "idle";
    this.pausedFromState = null;
    this.statusReason = null;
    this.lastVerdict = null;

    this.epics = [];
    this.backlogDir = null;
    this.projectRoot = null;
    this.overrideFolder = null;
    this.on = null;
    this.readOnly = false;
    this.loading = false;
    this.contextKey = null;
    this.activeSpaceId = null;

    const savedMode = shared(STORAGE_MODE);
    this.mode = savedMode === "epics" ? "epics" : "tasks";

    const savedFolders = shared(STORAGE_FOLDERS);
    this.spaceFolders =
      savedFolders && typeof savedFolders === "object" && !Array.isArray(savedFolders)
        ? savedFolders
        : {};

    this.settings = normalizeSettings(shared(STORAGE_SETTINGS));
    this.settingsOpen = false;
    this.apiKeyMasked = true;
    this.availableModels = [];
    this.modelsLoading = false;
    this.modelsError = null;

    this.baseUrlInput = InputState.new({
      placeholder: "https://api.openai.com/v1",
      value: this.settings.baseUrl,
    });
    this.baseUrlInput.on("submit", (_e, cx) => this.saveSettings(cx));

    this.apiKeyInput = InputState.new({
      placeholder: "sk-...",
      value: this.settings.apiKey,
    });
    this.apiKeyInput.set_masked(true);
    this.apiKeyInput.on("submit", (_e, cx) => this.saveSettings(cx));

    this.modelInput = InputState.new({
      placeholder: "gpt-4o-mini",
      value: this.settings.model,
    });
    this.modelInput.on("submit", (_e, cx) => this.saveSettings(cx));

    this.maxRetriesInput = InputState.new({
      placeholder: "3",
      value: String(this.settings.maxCiRetries),
    });
    this.maxRetriesInput.on("submit", (_e, cx) => this.saveSettings(cx));

    this.maxReviewRetriesInput = InputState.new({
      placeholder: "3",
      value: String(this.settings.maxReviewRetries),
    });
    this.maxReviewRetriesInput.on("submit", (_e, cx) => this.saveSettings(cx));

    this.selectedTerminal = null;
    this.sessionPickerOpen = false;

    this.boundRun = null;
    this.currentItem = null;
    this.skippedKeys = new Set();
    this.ciRetryCount = 0;
    this.reviewRetryCount = 0;
    this.reviewProgress = null;
    this.ciInfo = null;
    this.nextCiCheckAt = null;
    this.ciChecking = false;

    this.runSeq = 0;
    this.sendingPrompt = false;
    this.sentAt = 0;
    this.sawWorkingSinceSend = false;
    this.idleSince = null;
    this.lastAgentStatus = null;

    this.logs = [];
    this.watchHandle = null;
    this.watchedDir = null;
    this._lastPublishedUi = null;

    if (checking()) return;

    this.publishUiState();
    this.refresh(cx, true);

    cx.timer.every(1000, (cx) => this.onTick(cx));
    cx.timer.every(10000, (cx) => this.onBacklogTimer(cx));

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (cmd === "focus") {
          this.handle.focus();
        } else if (cmd === "start") {
          if (this.state === "paused") {
            this.resume(cx);
          } else if (this.state === "idle" || this.state === "error") {
            this.start(cx);
          }
        } else if (cmd === "pause") {
          if (this.isActiveState()) {
            this.pause(cx);
          }
        } else if (cmd === "stop") {
          if (this.state !== "idle") {
            this.stop(cx);
          }
        } else if (cmd === "check-ci") {
          if (this.state === "waiting_ci") {
            this.checkCiNow(cx);
          }
        } else if (cmd === "toggle-settings") {
          this.toggleSettings(cx);
        }
        cx.notify();
      }
    });
  }

  async close() {
    this.runSeq++;
    this.stopWatch();
  }

  isActiveState() {
    return (
      this.state === "watching" ||
      this.state === "classifying" ||
      this.state === "waiting_ci" ||
      this.state === "fixing_ci" ||
      this.state === "advancing"
    );
  }

  getCiPollMs() {
    const mins = Number(this.settings?.ciPollMinutes);
    return (Number.isFinite(mins) && mins > 0 ? mins : 5) * 60 * 1000;
  }

  addLog(level, text) {
    const entry = {
      time: Date.now(),
      level: level || "info",
      text: String(text ?? ""),
    };
    this.logs = [entry, ...this.logs].slice(0, MAX_LOGS);
  }

  publishUiState() {
    const t = theme();
    const meta = statusMeta(t, this.state);
    const spaceId = this.boundRun?.spaceId ?? this.activeSpaceId ?? null;
    const terminal = this.boundRun?.terminal ?? this.selectedTerminal ?? null;
    const maxCiRetries = this.settings?.maxCiRetries ?? 3;
    const next = {
      state: this.state,
      label: meta.label,
      spaceId,
      terminal,
      ciRetryCount: this.ciRetryCount,
      maxCiRetries,
    };
    const prev = this._lastPublishedUi;
    if (
      prev &&
      prev.state === next.state &&
      prev.label === next.label &&
      prev.spaceId === next.spaceId &&
      prev.terminal === next.terminal &&
      prev.ciRetryCount === next.ciRetryCount &&
      prev.maxCiRetries === next.maxCiRetries
    ) {
      return;
    }
    this._lastPublishedUi = next;
    setShared(STORAGE_UI, next);
  }

  setState(nextState) {
    this.state = nextState;
    this.publishUiState();
  }

  stopWatch() {
    if (this.watchHandle) {
      try {
        this.watchHandle.cancel();
      } catch {}
      this.watchHandle = null;
    }
    this.watchedDir = null;
  }

  startWatch(dir, on, cx) {
    if (!dir || on) {
      this.stopWatch();
      return;
    }
    if (this.watchedDir === dir && this.watchHandle) return;
    this.stopWatch();
    this.watchedDir = dir;
    cx.spawn(async (cx) => {
      while (this.watchedDir === dir) {
        const watch = watchFolder(dir);
        this.watchHandle = watch;
        try {
          const changed = await watch;
          if (this.watchedDir !== dir) break;
          if (Array.isArray(changed) && changed.length === 0) break;
          this.refresh(cx, false);
        } catch {
          if (this.watchedDir === dir) this.watchedDir = null;
          break;
        }
      }
    });
  }

  resolveContext() {
    const allSpaces = spaces() ?? [];
    const space = allSpaces.find((s) => s.active) ?? null;
    const f = focused();
    const allPanes = panes() ?? [];
    const spaceTabIds = new Set((space?.tabs ?? []).map((t) => t.id));
    const paneCwd =
      (f?.pane ? allPanes.find((p) => p.pane === f.pane)?.cwd : null) ||
      (f?.space === space?.id ? f?.cwd : null) ||
      (f?.tab && spaceTabIds.has(f.tab)
        ? allPanes.find((p) => p.tab === f.tab && p.cwd)?.cwd
        : null) ||
      allPanes.find((p) => spaceTabIds.has(p.tab) && p.cwd)?.cwd ||
      space?.folder ||
      null;
    const on = space?.machine ?? null;
    const spaceKey = space?.id ?? "__global__";
    const sharedFolders = shared(STORAGE_FOLDERS);
    if (sharedFolders && typeof sharedFolders === "object" && !Array.isArray(sharedFolders)) {
      this.spaceFolders = sharedFolders;
    }
    const overrideFolder =
      this.overrideFolder && this.overrideFolder.spaceKey === spaceKey
        ? normPath(this.overrideFolder.dir)
        : null;
    const propFolder = normPath(props()?.folder);
    const manualDir = normPath(this.spaceFolders[spaceKey]);
    const key = JSON.stringify([
      spaceKey,
      on,
      overrideFolder,
      propFolder,
      manualDir,
      normPath(paneCwd),
    ]);
    return {
      space,
      spaceKey,
      on,
      overrideFolder,
      propFolder,
      manualDir,
      paneCwd: normPath(paneCwd),
      key,
    };
  }

  async detectBacklogDir(ctx) {
    for (const rawExplicit of [ctx.overrideFolder, ctx.propFolder, ctx.manualDir]) {
      const explicitDir = await resolvePath(rawExplicit, ctx.on);
      if (!explicitDir) continue;
      const files = await listMarkdownFiles(explicitDir, ctx.on);
      if (files !== null) {
        const root = (await gitTopLevel(explicitDir, ctx.on)) || parentDir(explicitDir);
        return { backlogDir: explicitDir, projectRoot: root, files };
      }
    }

    const candidates = [];
    const seen = new Set();
    const pushCandidate = (dir, root, strict = false) => {
      const clean = normPath(dir);
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      candidates.push({ dir: clean, root: normPath(root) || parentDir(clean), strict });
    };

    const resolvedCwd = await resolvePath(ctx.paneCwd, ctx.on);
    const top = await gitTopLevel(resolvedCwd, ctx.on);
    if (resolvedCwd) {
      pushCandidate(joinPath(resolvedCwd, "backlog"), resolvedCwd, false);
      pushCandidate(joinPath(resolvedCwd, "docs/backlog"), resolvedCwd, false);
      pushCandidate(joinPath(resolvedCwd, ".backlog"), resolvedCwd, false);
    }
    if (top && top !== resolvedCwd) {
      pushCandidate(joinPath(top, "backlog"), top, false);
      pushCandidate(joinPath(top, "docs/backlog"), top, false);
      pushCandidate(joinPath(top, ".backlog"), top, false);
    }
    if (resolvedCwd) {
      const lower = resolvedCwd.toLowerCase();
      const isBacklogDir = lower.endsWith("/backlog") || lower.endsWith("/.backlog");
      pushCandidate(resolvedCwd, top || parentDir(resolvedCwd), !isBacklogDir);
    }
    if (!resolvedCwd) {
      const homeDir = await getHomeDir(ctx.on);
      if (homeDir) {
        pushCandidate(joinPath(homeDir, "backlog"), homeDir, false);
        pushCandidate(joinPath(homeDir, "docs/backlog"), homeDir, false);
        pushCandidate(joinPath(homeDir, ".backlog"), homeDir, false);
      }
    }

    for (const c of candidates) {
      const files = await listMarkdownFiles(c.dir, ctx.on);
      if (!files) continue;
      const hasEpics = c.strict ? files.some(isNumberedEpicFilename) : files.some(isEpicFilename);
      const isNamedBacklog = c.dir.toLowerCase().endsWith("/backlog") && files.length > 0;
      if (hasEpics || isNamedBacklog) {
        return { backlogDir: c.dir, projectRoot: c.root, files };
      }
    }

    return { backlogDir: null, projectRoot: top || resolvedCwd, files: null };
  }

  async loadEpicsFromFiles(dir, files, on) {
    const epicFiles = (files ?? []).filter(isEpicFilename).sort();
    const loaded = [];
    const batchSize = 12;
    for (let i = 0; i < epicFiles.length; i += batchSize) {
      const batch = epicFiles.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (name) => {
          const fullPath = joinPath(dir, name);
          const text = await readTextFile(fullPath, { on }).catch(() => null);
          if (text === null) return null;
          return parseEpicFile(name, text, fullPath);
        }),
      );
      for (const item of results) {
        if (item) loaded.push(item);
      }
    }
    loaded.sort((a, b) => a.number - b.number || a.filename.localeCompare(b.filename));
    return loaded;
  }

  async reloadEpicsForDir(dir, on) {
    if (!dir) return;
    const files = await listMarkdownFiles(dir, on);
    if (!files) return;
    const loaded = await this.loadEpicsFromFiles(dir, files, on);
    this.epics = loaded;
    this.syncCurrentItemWithEpics();
  }

  syncCurrentItemWithEpics() {
    if (!this.currentItem) return;
    const prevEpic = this.currentItem.epic;
    const prevTask = this.currentItem.task;
    const freshEpic = this.epics.find((e) => e.filePath === prevEpic?.filePath) ?? null;
    if (!freshEpic) {
      if (this.state === "idle") this.currentItem = null;
      return;
    }
    if (!prevTask) {
      if (this.state === "idle" && (freshEpic.status === "done" || freshEpic.status === "blocked")) {
        this.currentItem = null;
      } else {
        this.currentItem = { epic: freshEpic, task: null };
      }
      return;
    }
    const freshTask =
      freshEpic.tasks.find((t) => t.hasExplicitId && t.id === prevTask.id) ??
      freshEpic.tasks.find((t) => t.lineIndex === prevTask.lineIndex) ??
      freshEpic.tasks.find((t) => t.title === prevTask.title) ??
      null;
    if (!freshTask) {
      if (this.state === "idle") this.currentItem = null;
      return;
    }
    if (this.state === "idle" && (freshTask.status === "done" || freshTask.status === "blocked")) {
      this.currentItem = null;
      return;
    }
    this.currentItem = { epic: freshEpic, task: freshTask };
  }

  onBacklogTimer(cx) {
    this.refresh(cx, false);
  }

  refreshBacklog(cx) {
    this.refresh(cx, true);
  }

  refresh(cx, force = false) {
    if (this.boundRun) {
      if (this.loading && !force) return;
      const runDir = this.boundRun.backlogDir;
      const runOn = this.boundRun.on;
      if (!runDir) return;
      this.loading = true;
      cx.spawn(async (cx) => {
        try {
          await this.reloadEpicsForDir(runDir, runOn);
        } finally {
          this.loading = false;
          cx.notify();
        }
      });
      return;
    }

    const ctx = this.resolveContext();
    const contextChanged = ctx.key !== this.contextKey;
    if (contextChanged) {
      this.contextKey = ctx.key;
      this.activeSpaceId = ctx.space?.id ?? null;
      this.on = ctx.on;
      this.readOnly = Boolean(ctx.on);
      this.sessionPickerOpen = false;
      this.currentItem = null;
      this.stopWatch();
    }
    if (this.loading && !force && !contextChanged) return;

    const expectedKey = ctx.key;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const detected = await this.detectBacklogDir(ctx);
        if (this.boundRun || this.contextKey !== expectedKey) return;

        this.backlogDir = detected.backlogDir;
        this.projectRoot = detected.projectRoot;

        if (!detected.backlogDir) {
          this.epics = [];
          this.currentItem = null;
          this.stopWatch();
        } else {
          const loaded = await this.loadEpicsFromFiles(
            detected.backlogDir,
            detected.files,
            ctx.on,
          );
          if (this.boundRun || this.contextKey !== expectedKey) return;
          this.epics = loaded;
          this.syncCurrentItemWithEpics();
          this.startWatch(detected.backlogDir, ctx.on, cx);
        }

        this.ensureSelectedTerminal();
        this.publishUiState();
      } finally {
        if (!this.boundRun && this.contextKey === expectedKey) {
          this.loading = false;
        }
        cx.notify();
      }
    });
  }

  getSessionChoices() {
    const allSpaces = spaces() ?? [];
    const allPanes = panes() ?? [];
    const allAgents = agents() ?? [];
    const allTerminals = terminals() ?? [];
    const f = focused();

    const targetSpaceId =
      this.boundRun?.spaceId ??
      this.activeSpaceId ??
      allSpaces.find((s) => s.active)?.id ??
      null;

    const spaceById = new Map(allSpaces.map((s) => [s.id, s]));
    const spaceByTab = new Map();
    for (const s of allSpaces) {
      for (const tab of s.tabs ?? []) {
        spaceByTab.set(tab.id, s);
      }
    }
    const paneByTerm = new Map(
      allPanes.filter((p) => p.terminal).map((p) => [p.terminal, p]),
    );
    const agentByAddr = new Map(allAgents.map((a) => [a.address, a]));

    const choices = [];
    for (const term of allTerminals) {
      if (term.state !== "live") continue;
      const pane = paneByTerm.get(term.address) ?? null;
      const agent = agentByAddr.get(term.address) ?? null;
      const space =
        (agent?.space ? spaceById.get(agent.space) : null) ??
        (pane?.tab ? spaceByTab.get(pane.tab) : null) ??
        null;

      if (targetSpaceId && space?.id !== targetSpaceId) continue;

      const isAgent = Boolean(agent || term.program?.agent);
      choices.push({
        address: term.address,
        label:
          term.title ||
          agent?.title ||
          pane?.title ||
          term.program?.name ||
          term.address,
        programName:
          agent?.program?.name ||
          term.program?.name ||
          term.program?.key ||
          "Terminal",
        status: agent?.status ?? term.status ?? "idle",
        isAgent,
        isFocused: f?.terminal === term.address || Boolean(agent?.focused || pane?.focused),
        spaceName: space?.name ?? "",
        spaceId: space?.id ?? null,
      });
    }

    choices.sort((a, b) => {
      if (a.isAgent !== b.isAgent) return a.isAgent ? -1 : 1;
      if (a.isFocused !== b.isFocused) return a.isFocused ? -1 : 1;
      return a.address.localeCompare(b.address);
    });

    return choices;
  }

  ensureSelectedTerminal() {
    if (this.boundRun) return;
    const choices = this.getSessionChoices();
    if (choices.length === 0) {
      this.selectedTerminal = null;
      return;
    }
    if (this.selectedTerminal && choices.some((c) => c.address === this.selectedTerminal)) {
      return;
    }
    const preferred =
      choices.find((c) => c.isAgent && c.isFocused) ??
      choices.find((c) => c.isAgent) ??
      choices.find((c) => c.isFocused) ??
      choices[0];
    this.selectedTerminal = preferred?.address ?? null;
  }

  toggleSessionPicker(cx) {
    if (this.isActiveState()) {
      notify({
        title: "Цикл Orca активен",
        body: "Поставьте на паузу или остановите цикл перед сменой сессии",
        level: "warning",
      });
      return;
    }
    this.sessionPickerOpen = !this.sessionPickerOpen;
    cx.notify();
  }

  selectTerminal(address, cx) {
    if (this.isActiveState()) return;
    this.selectedTerminal = address;
    this.sessionPickerOpen = false;
    if (this.boundRun) {
      if (this.state === "paused") {
        this.boundRun = { ...this.boundRun, terminal: address };
      } else {
        this.boundRun = null;
      }
    }
    this.publishUiState();
    cx.notify();
  }

  chooseFolder(cx) {
    if (this.state !== "idle" && this.state !== "error") {
      notify({
        title: "Остановите Orca перед сменой папки",
        level: "warning",
      });
      return;
    }
    if (this.on) {
      notify({
        title: "Удалённая машина",
        body: "Выбор папки через диалог доступен только на локальной машине",
        level: "warning",
      });
      return;
    }
    cx.spawn(async (cx) => {
      const picked = await pickFolder({ prompt: "Выбрать папку backlog" });
      if (!picked) return;
      const clean = normPath(picked);
      if (!clean) return;

      let targetDir = clean;
      const directFiles = await listMarkdownFiles(clean, null);
      const hasDirectEpics = directFiles?.some(isEpicFilename);
      if (!hasDirectEpics) {
        const sub = joinPath(clean, "backlog");
        const subFiles = await listMarkdownFiles(sub, null);
        if (subFiles !== null) {
          targetDir = sub;
        }
      }

      const ctx = this.resolveContext();
      this.overrideFolder = { spaceKey: ctx.spaceKey, dir: targetDir };
      const sharedCurrent = shared(STORAGE_FOLDERS);
      const base =
        sharedCurrent && typeof sharedCurrent === "object" && !Array.isArray(sharedCurrent)
          ? sharedCurrent
          : this.spaceFolders;
      this.spaceFolders = { ...base, [ctx.spaceKey]: targetDir };
      setShared(STORAGE_FOLDERS, this.spaceFolders);
      this.refresh(cx, true);
    });
  }

  setMode(mode, cx) {
    const nextMode = mode === "epics" ? "epics" : "tasks";
    if (this.mode === nextMode) return;
    this.mode = nextMode;
    setShared(STORAGE_MODE, nextMode);
    if (this.state === "idle") {
      this.currentItem = null;
    }
    cx.notify();
  }

  setReviewMode(mode, cx) {
    const nextMode = mode === "auto" ? "auto" : "reviewer";
    if (this.settings.reviewMode === nextMode) return;
    this.settings = { ...this.settings, reviewMode: nextMode };
    setShared(STORAGE_SETTINGS, this.settings);
    this.addLog(
      "info",
      nextMode === "reviewer"
        ? "Включён режим Ревьювер (проверка кода, diff и тестов)"
        : "Включён режим Авто (быстрая отправка задач)",
    );
    cx.notify();
  }

  getQueueItems() {
    return listQueueItems(this.epics, this.mode);
  }

  pickNextAvailableItem() {
    const items = this.getQueueItems();
    for (const item of items) {
      const key = queueItemKey(item);
      if (key && !this.skippedKeys.has(key)) {
        return item;
      }
    }
    return pickNextQueueItem(this.epics, this.mode);
  }

  focusQueueItem(item, cx) {
    if (!item) return;
    if (this.state === "idle" || this.state === "paused" || this.state === "error") {
      this.currentItem = item;
      const label = item.task ? `${item.epic.id} · ${item.task.id}` : item.epic.id;
      this.addLog("info", `Выбрана задача: ${label}`);
      cx.notify();
    } else {
      notify({
        title: "Задача уже выполняется",
        body: "Используйте «Пропустить» или «Стоп» для смены задачи",
        level: "info",
      });
    }
  }

  toggleSettings(cx) {
    this.settingsOpen = !this.settingsOpen;
    if (this.settingsOpen) {
      this.baseUrlInput.set_value(this.settings.baseUrl || "");
      this.apiKeyInput.set_value(this.settings.apiKey || "");
      this.modelInput.set_value(this.settings.model || "");
      this.maxRetriesInput.set_value(String(this.settings.maxCiRetries ?? 3));
      this.maxReviewRetriesInput.set_value(String(this.settings.maxReviewRetries ?? 3));
      this.modelsError = null;
    } else {
      this.handle.focus();
    }
    cx.notify();
  }

  toggleApiKeyMask(cx) {
    this.apiKeyMasked = !this.apiKeyMasked;
    this.apiKeyInput.set_masked(this.apiKeyMasked);
    cx.notify();
  }

  selectModel(modelId, cx) {
    this.modelInput.set_value(modelId);
    this.modelsError = null;
    cx.notify();
  }

  fetchModels(cx) {
    const rawBaseUrl = this.baseUrlInput.value().trim();
    const baseUrl = normalizeBaseUrl(rawBaseUrl);
    if (!baseUrl || !/^https?:\/\/.+/i.test(baseUrl)) {
      this.modelsError = "Укажите корректный Base URL (http:// или https://)";
      cx.notify();
      return;
    }
    const apiKey = this.apiKeyInput.value();
    this.modelsLoading = true;
    this.modelsError = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const models = await fetchModels({ baseUrl, apiKey });
        this.availableModels = models;
        if (!this.modelInput.value().trim() && models.length > 0) {
          this.modelInput.set_value(models[0]);
        }
        if (models.length === 0) {
          this.modelsError = "Сервер вернул пустой список моделей";
        }
      } catch (err) {
        this.modelsError = String(err?.message ?? err);
      } finally {
        this.modelsLoading = false;
        cx.notify();
      }
    });
  }

  saveSettings(cx) {
    const rawBaseUrl = this.baseUrlInput.value().trim();
    const normalizedUrl = normalizeBaseUrl(rawBaseUrl);
    if (!normalizedUrl || !/^https?:\/\/.+/i.test(normalizedUrl)) {
      this.modelsError = "Укажите корректный Base URL (http:// или https://)";
      notify({
        title: "Некорректный Base URL",
        body: "Укажите URL вида http://localhost:11434/v1",
        level: "warning",
      });
      cx.notify();
      return;
    }

    const rawRetries = this.maxRetriesInput.value().trim();
    let maxCiRetries = 3;
    if (rawRetries !== "") {
      const parsed = Number(rawRetries);
      if (!Number.isInteger(parsed) || parsed < 0) {
        this.modelsError = "Попыток фикса CI должно быть целым числом >= 0";
        notify({
          title: "Некорректный лимит попыток CI",
          body: "Введите целое число >= 0 (0 = бесконечно)",
          level: "warning",
        });
        cx.notify();
        return;
      }
      maxCiRetries = parsed;
    }

    const rawReviewRetries = this.maxReviewRetriesInput.value().trim();
    let maxReviewRetries = 3;
    if (rawReviewRetries !== "") {
      const parsed = Number(rawReviewRetries);
      if (!Number.isInteger(parsed) || parsed < 0) {
        this.modelsError = "Попыток ревью должно быть целым числом >= 0";
        notify({
          title: "Некорректный лимит попыток ревью",
          body: "Введите целое число >= 0 (0 = бесконечно)",
          level: "warning",
        });
        cx.notify();
        return;
      }
      maxReviewRetries = parsed;
    }

    const model = this.modelInput.value().trim();
    const apiKey = this.apiKeyInput.value();

    this.settings = {
      ...this.settings,
      baseUrl: normalizedUrl,
      apiKey,
      model,
      maxCiRetries,
      maxReviewRetries,
    };
    this.baseUrlInput.set_value(normalizedUrl);
    this.maxRetriesInput.set_value(String(maxCiRetries));
    this.maxReviewRetriesInput.set_value(String(maxReviewRetries));
    setShared(STORAGE_SETTINGS, this.settings);
    this.modelsError = null;
    this.settingsOpen = false;
    this.publishUiState();
    this.handle.focus();

    notify({
      title: "Настройки Orca сохранены",
      body: model ? `Модель: ${model}` : normalizedUrl,
      level: "success",
    });
    cx.notify();
  }

  readTerminalAgentStatus(address) {
    if (!address) return "idle";
    const agent = (agents() ?? []).find((a) => a.address === address);
    if (agent?.status) return agent.status;
    const term = (terminals() ?? []).find((t) => t.address === address);
    return term?.status ?? "idle";
  }

  isTerminalLive(address) {
    if (!address) return false;
    const term = (terminals() ?? []).find((t) => t.address === address);
    return Boolean(term && term.state === "live");
  }

  failRun(reason, cx) {
    this.runSeq++;
    this.sendingPrompt = false;
    this.idleSince = null;
    this.nextCiCheckAt = null;
    this.statusReason = reason;
    this.setState("error");
    this.addLog("error", reason);
    notify({
      title: "Orca: ошибка",
      body: reason,
      level: "error",
      ...(this.boundRun?.terminal
        ? { action: { name: "pane.focus", args: { terminal: this.boundRun.terminal } } }
        : {}),
    });
    playSound("blocked");
    cx.notify();
  }

  start(cx) {
    if (this.isActiveState()) return;
    this.boundRun = null;
    this.sendingPrompt = false;

    const baseUrl = normalizeBaseUrl(this.settings?.baseUrl);
    const model = this.settings?.model?.trim();
    if (!baseUrl || !model) {
      this.settingsOpen = true;
      this.statusReason = "Укажите Base URL и модель классификатора в настройках";
      notify({
        title: "Настройте классификатор",
        body: this.statusReason,
        level: "warning",
      });
      cx.notify();
      return;
    }

    this.ensureSelectedTerminal();
    if (!this.selectedTerminal || !this.isTerminalLive(this.selectedTerminal)) {
      this.statusReason = "Выберите живую сессию агента в активном space";
      notify({
        title: "Сессия не выбрана",
        body: this.statusReason,
        level: "warning",
      });
      cx.notify();
      return;
    }

    if (!this.backlogDir) {
      this.statusReason = "Папка backlog не найдена";
      notify({
        title: "Бэклог не найден",
        body: "Выберите папку backlog перед запуском",
        level: "warning",
      });
      cx.notify();
      return;
    }

    if (this.readOnly) {
      this.statusReason = "Удалённый бэклог в режиме только чтения";
      notify({
        title: "Только чтение",
        body: "Запись статусов на удалённую машину не поддерживается",
        level: "warning",
      });
      cx.notify();
      return;
    }

    this.skippedKeys.clear();
    const queue = this.getQueueItems();
    const chosen =
      this.currentItem && queue.some((q) => queueItemKey(q) === queueItemKey(this.currentItem))
        ? this.currentItem
        : this.pickNextAvailableItem();

    if (!chosen) {
      this.completeBacklog(cx);
      return;
    }

    const agentStatus = this.readTerminalAgentStatus(this.selectedTerminal);
    const startAction = resolveStartAction(agentStatus);
    if (startAction === "block") {
      this.statusReason = "Агент в выбранной сессии ожидает ответа пользователя (blocked)";
      this.addLog("warn", this.statusReason);
      notify({
        title: "Orca: требуется внимание",
        body: this.statusReason,
        level: "warning",
        action: { name: "pane.focus", args: { terminal: this.selectedTerminal } },
      });
      playSound("blocked");
      cx.notify();
      return;
    }

    const space =
      (spaces() ?? []).find((s) => s.id === this.activeSpaceId) ??
      (spaces() ?? []).find((s) => s.active) ??
      null;

    this.boundRun = {
      spaceId: space?.id ?? null,
      terminal: this.selectedTerminal,
      backlogDir: this.backlogDir,
      projectRoot: this.projectRoot || parentDir(this.backlogDir) || space?.folder || null,
      on: this.on ?? null,
    };
    this.currentItem = chosen;
    this.ciRetryCount = 0;
    this.reviewRetryCount = 0;
    this.reviewProgress = null;
    this.ciInfo = null;
    this.nextCiCheckAt = null;
    this.lastVerdict = null;
    this.statusReason = null;
    this.pausedFromState = null;
    this.sessionPickerOpen = false;

    if (startAction === "attach") {
      this.sentAt = Date.now();
      this.sawWorkingSinceSend = true;
      this.lastAgentStatus = "working";
      this.idleSince = null;
      this.setState("watching");
      this.addLog(
        "info",
        `Подключено к активной сессии ${this.selectedTerminal} (ожидание завершения хода)`,
      );
      cx.notify();
      return;
    }

    this.dispatchCurrentItem(cx);
  }

  dispatchCurrentItem(cx) {
    const runCtx = this.boundRun;
    const item = this.currentItem;
    if (!runCtx || !item) return;

    const seq = ++this.runSeq;
    const label = item.task ? `${item.epic.id} · ${item.task.id}` : item.epic.id;
    const prompt = buildAgentPrompt(item.epic, item.task, runCtx.projectRoot);

    this.sendingPrompt = true;
    this.setState("advancing");
    this.statusReason = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        await this.markItemStatusOnDisk(item, "in_progress", runCtx.on).catch(() => {});
        await this.reloadEpicsForDir(runCtx.backlogDir, runCtx.on).catch(() => {});
        if (this.runSeq !== seq) return;

        const res = await hc(["send", runCtx.terminal, prompt]).catch((e) => ({
          code: 1,
          stderr: String(e),
        }));
        if (this.runSeq !== seq) return;

        if (res.code !== 0) {
          this.failRun(
            `Не удалось отправить задачу в ${runCtx.terminal}: ${res.stderr || "ошибка hc send"}`,
            cx,
          );
          return;
        }

        this.sentAt = Date.now();
        this.lastAgentStatus = this.readTerminalAgentStatus(runCtx.terminal);
        this.sawWorkingSinceSend = this.lastAgentStatus === "working";
        this.idleSince = null;
        this.setState("watching");
        this.addLog("info", `Запущена задача ${label} в ${runCtx.terminal}`);
        cx.notify();
      } finally {
        if (this.runSeq === seq) {
          this.sendingPrompt = false;
        }
      }
    });
  }

  pause(cx) {
    if (!this.isActiveState()) return;
    this.pausedFromState = this.state;
    this.runSeq++;
    this.sendingPrompt = false;
    this.idleSince = null;
    this.nextCiCheckAt = null;
    this.setState("paused");
    this.statusReason = "Цикл поставлен на паузу";
    this.addLog("warn", "Цикл поставлен на паузу");
    cx.notify();
  }

  resume(cx) {
    if (this.state !== "paused") return;
    if (!this.boundRun || !this.isTerminalLive(this.boundRun.terminal)) {
      this.failRun("Целевой терминал больше не активен", cx);
      return;
    }

    this.runSeq++;
    this.statusReason = null;
    this.idleSince = null;

    if (this.pausedFromState === "waiting_ci") {
      this.pausedFromState = null;
      this.setState("waiting_ci");
      this.addLog("info", "Возобновлено ожидание CI");
      this.runCiCheck(cx);
      return;
    }

    this.pausedFromState = null;
    if (this.currentItem) {
      this.sentAt = Date.now();
      this.lastAgentStatus = this.readTerminalAgentStatus(this.boundRun.terminal);
      this.sawWorkingSinceSend = this.lastAgentStatus === "working";
      this.setState("watching");
      this.addLog("info", "Наблюдение возобновлено");
      cx.notify();
    } else {
      this.start(cx);
    }
  }

  stop(cx) {
    this.runSeq++;
    this.sendingPrompt = false;
    this.boundRun = null;
    this.currentItem = null;
    this.skippedKeys.clear();
    this.ciRetryCount = 0;
    this.reviewRetryCount = 0;
    this.reviewProgress = null;
    this.ciInfo = null;
    this.nextCiCheckAt = null;
    this.lastVerdict = null;
    this.statusReason = null;
    this.pausedFromState = null;
    this.sentAt = 0;
    this.sawWorkingSinceSend = false;
    this.idleSince = null;
    this.lastAgentStatus = null;
    this.setState("idle");
    this.addLog("info", "Цикл остановлен");
    this.refresh(cx, true);
    cx.notify();
  }

  skipCurrent(cx) {
    if (!this.boundRun || !this.currentItem) return;
    const key = queueItemKey(this.currentItem);
    if (key) this.skippedKeys.add(key);

    const label = this.currentItem.task
      ? `${this.currentItem.epic.id} · ${this.currentItem.task.id}`
      : this.currentItem.epic.id;
    this.addLog("warn", `Пропущена задача ${label}`);

    this.ciRetryCount = 0;
    this.reviewRetryCount = 0;
    this.reviewProgress = null;
    this.ciInfo = null;
    this.nextCiCheckAt = null;
    this.lastVerdict = null;
    this.statusReason = null;
    this.pausedFromState = null;
    this.idleSince = null;

    const items = this.getQueueItems();
    const hasUnskipped = items.some((item) => {
      const k = queueItemKey(item);
      return k && !this.skippedKeys.has(k);
    });
    if (!hasUnskipped && items.length > 1) {
      this.skippedKeys.clear();
      if (key) this.skippedKeys.add(key);
    }

    const next = this.pickNextAvailableItem();
    if (!next) {
      this.completeBacklog(cx);
      return;
    }
    this.currentItem = next;
    this.dispatchCurrentItem(cx);
  }

  onTick(cx) {
    if (this.state === "waiting_ci") {
      if (this.nextCiCheckAt && Date.now() >= this.nextCiCheckAt && !this.ciChecking) {
        this.runCiCheck(cx);
      } else {
        cx.notify();
      }
      return;
    }

    if (this.state !== "watching" && this.state !== "fixing_ci") {
      return;
    }
    if (this.sendingPrompt) {
      return;
    }

    const terminal = this.boundRun?.terminal;
    if (!terminal || !this.isTerminalLive(terminal)) {
      this.failRun(`Терминал ${terminal ?? ""} завершился или недоступен`, cx);
      return;
    }

    const status = this.readTerminalAgentStatus(terminal);
    if (status === "blocked") {
      this.pausedFromState = this.state;
      this.runSeq++;
      this.idleSince = null;
      this.setState("paused");
      this.statusReason = "Агент ожидает ответа пользователя (blocked)";
      this.addLog("warn", this.statusReason);
      notify({
        title: "Orca: требуется внимание",
        body: this.statusReason,
        level: "warning",
        action: { name: "pane.focus", args: { terminal } },
      });
      playSound("blocked");
      cx.notify();
      return;
    }

    if (status === "working") {
      this.sawWorkingSinceSend = true;
      this.idleSince = null;
      this.lastAgentStatus = "working";
      return;
    }

    const elapsedSinceSend = Date.now() - (this.sentAt || 0);
    if (!this.sawWorkingSinceSend && elapsedSinceSend < SENT_GRACE_MS) {
      return;
    }

    if (status === "idle" || status === "done") {
      if (!this.idleSince) {
        this.idleSince = Date.now();
      } else if (Date.now() - this.idleSince >= IDLE_DEBOUNCE_MS) {
        this.idleSince = null;
        this.lastAgentStatus = status;
        this.classifyCurrentTurn(cx);
      }
    }
  }

  classifyCurrentTurn(cx) {
    const runCtx = this.boundRun;
    const item = this.currentItem;
    if (!runCtx || !item) return;

    const isReviewer = (this.settings?.reviewMode ?? "reviewer") === "reviewer";
    const seq = ++this.runSeq;
    this.reviewProgress = isReviewer ? "Сбор фактов…" : null;
    this.setState("classifying");
    this.statusReason = null;
    this.addLog(
      "info",
      isReviewer
        ? "Ревьювер проверяет работу агента…"
        : "Классификация завершения хода агента…",
    );
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const readRes = await hc([
          "read",
          runCtx.terminal,
          "--lines",
          isReviewer ? "200" : "120",
        ]).catch((e) => ({
          code: 1,
          stdout: "",
          stderr: String(e),
        }));
        if (this.runSeq !== seq) return;
        const terminalTail = readRes?.stdout ?? "";

        let gitStatus = "";
        let gitLog = "";
        let gitDiff = "";
        if (runCtx.projectRoot) {
          const [stRes, logRes] = await Promise.all([
            exec("git", ["status", "--short"], {
              cwd: runCtx.projectRoot,
              on: runCtx.on,
            }).catch(() => null),
            exec("git", ["log", isReviewer ? "-5" : "-1", "--oneline"], {
              cwd: runCtx.projectRoot,
              on: runCtx.on,
            }).catch(() => null),
          ]);
          if (this.runSeq !== seq) return;
          if (stRes?.code === 0) gitStatus = stRes.stdout.trim();
          if (logRes?.code === 0) gitLog = logRes.stdout.trim();

          if (isReviewer) {
            const [unstagedRes, stagedRes] = await Promise.all([
              exec("git", ["diff"], { cwd: runCtx.projectRoot, on: runCtx.on }).catch(() => null),
              exec("git", ["diff", "--cached"], { cwd: runCtx.projectRoot, on: runCtx.on }).catch(
                () => null,
              ),
            ]);
            if (this.runSeq !== seq) return;
            const diffParts = [];
            if (unstagedRes?.code === 0 && unstagedRes.stdout?.trim()) {
              diffParts.push(unstagedRes.stdout.trim());
            }
            if (stagedRes?.code === 0 && stagedRes.stdout?.trim()) {
              diffParts.push(`# Staged\n${stagedRes.stdout.trim()}`);
            }
            if (diffParts.length > 0) {
              gitDiff = diffParts.join("\n\n");
            } else {
              const showRes = await exec("git", ["show", "--stat", "--patch", "-n", "1", "HEAD"], {
                cwd: runCtx.projectRoot,
                on: runCtx.on,
              }).catch(() => null);
              if (this.runSeq !== seq) return;
              if (showRes?.code === 0) gitDiff = showRes.stdout.trim();
            }
          }
        }

        let ci = {
          state: "none",
          summary: "",
          failedRunId: null,
          failedName: null,
          branch: null,
        };
        if (runCtx.projectRoot) {
          ci = await checkGithubCiStatus(runCtx.projectRoot, runCtx.on, exec);
          if (this.runSeq !== seq) return;
        }

        const ciSummary =
          ci.state !== "none" && ci.state !== "error" ? ci.summary : "";
        if (ci.state !== "none" && ci.state !== "error") {
          this.ciInfo = ci;
        }

        const toolExecutor = isReviewer
          ? createReviewerToolExecutor({
              projectRoot: runCtx.projectRoot,
              terminal: runCtx.terminal,
              on: runCtx.on,
              epicFilePath: item.epic?.filePath ?? null,
              execFn: exec,
              hcFn: hc,
              readTextFileFn: readTextFile,
            })
          : null;

        const onProgress = isReviewer
          ? (stepText) => {
              if (this.runSeq !== seq) return;
              this.reviewProgress = stepText;
              this.addLog("info", `Ревьювер: ${stepText}`);
              cx.notify();
            }
          : null;

        const verdict = await classifySessionTurn(
          this.settings,
          {
            reviewMode: isReviewer ? "reviewer" : "auto",
            epic: item.epic,
            task: item.task,
            terminalTail,
            gitStatus,
            gitLog,
            gitDiff,
            ciSummary,
          },
          fetch,
          toolExecutor,
          onProgress,
        );
        if (this.runSeq !== seq) return;

        this.reviewProgress = null;
        this.lastVerdict = verdict;
        this.addLog("info", `Вердикт: ${verdict.verdict} — ${verdict.reason}`);
        if (Array.isArray(verdict.evidence) && verdict.evidence.length > 0) {
          this.addLog("info", `Факты: ${verdict.evidence.slice(0, 3).join(" | ")}`);
        }

        if (verdict.verdict === "completed") {
          const ciAction = resolveCompletedCiAction(ci.state);
          if (ciAction === "wait_ci") {
            this.ciInfo = ci;
            this.enterWaitingCi(ci.summary || "CI ещё выполняется — ожидание завершения", cx);
            return;
          }
          if (ciAction === "fix_ci") {
            this.ciInfo = ci;
            await this.handleCiFailure(runCtx, item, ci, seq, cx);
            return;
          }
          await this.markDoneAndAdvance(seq, cx);
          return;
        }

        if (verdict.verdict === "needs_fix") {
          await this.handleReviewFailure(runCtx, item, verdict, seq, cx);
          return;
        }

        if (verdict.verdict === "waiting_ci") {
          this.ciInfo =
            ci.state !== "none"
              ? ci
              : {
                  state: "pending",
                  summary: verdict.reason || "Ожидание CI",
                  branch: ci.branch ?? null,
                };
          this.enterWaitingCi(verdict.reason || "Ожидание завершения CI", cx);
          return;
        }

        this.pausedFromState = "watching";
        this.setState("paused");
        this.statusReason =
          verdict.reason ||
          (verdict.verdict === "failed"
            ? "Агент завершился с ошибкой"
            : "Требуется участие пользователя");
        this.addLog(verdict.verdict === "failed" ? "error" : "warn", this.statusReason);
        notify({
          title:
            verdict.verdict === "failed"
              ? "Orca: ошибка агента"
              : "Orca: требуется ответ",
          body: this.statusReason,
          level: verdict.verdict === "failed" ? "error" : "warning",
          action: { name: "pane.focus", args: { terminal: runCtx.terminal } },
        });
        playSound("blocked");
        cx.notify();
      } catch (err) {
        if (this.runSeq !== seq) return;
        this.reviewProgress = null;
        const msg = String(err?.message ?? err);
        this.failRun(`Ошибка классификации: ${msg}`, cx);
      }
    });
  }

  async handleReviewFailure(runCtx, item, verdict, seq, cx) {
    const maxRetries = this.settings?.maxReviewRetries ?? 3;
    const issues = Array.isArray(verdict?.issues) ? verdict.issues.filter(Boolean) : [];
    const summary = issues[0] || verdict?.reason || "Ревьювер отклонил выполнение";

    if (shouldRetryCi(this.reviewRetryCount, maxRetries)) {
      this.reviewRetryCount += 1;
      this.sendingPrompt = true;
      this.setState("advancing");
      this.statusReason = `Ревью: возврат на доработку (${summary})`;
      const maxLabel = maxRetries === 0 ? "∞" : String(maxRetries);
      this.addLog(
        "warn",
        `Ревью отклонено (попытка ${this.reviewRetryCount}/${maxLabel}): ${summary}`,
      );
      cx.notify();

      try {
        const fixPrompt = buildReviewFixPrompt(
          item.epic,
          item.task,
          verdict,
          this.reviewRetryCount,
          maxRetries,
        );
        const sendRes = await hc(["send", runCtx.terminal, fixPrompt]).catch((e) => ({
          code: 1,
          stderr: String(e),
        }));
        if (this.runSeq !== seq) return;

        if (sendRes.code !== 0) {
          this.sendingPrompt = false;
          this.failRun(
            `Не удалось отправить замечания ревью в ${runCtx.terminal}: ${sendRes.stderr || "ошибка hc send"}`,
            cx,
          );
          return;
        }

        this.sentAt = Date.now();
        this.lastAgentStatus = this.readTerminalAgentStatus(runCtx.terminal);
        this.sawWorkingSinceSend = this.lastAgentStatus === "working";
        this.idleSince = null;
        this.sendingPrompt = false;
        this.setState("watching");
        this.addLog("info", `Отправлены замечания ревью (попытка ${this.reviewRetryCount})`);
        cx.notify();
      } finally {
        if (this.runSeq === seq) {
          this.sendingPrompt = false;
        }
      }
      return;
    }

    this.runSeq++;
    this.setState("error");
    this.statusReason = `Исчерпан лимит попыток ревью (${maxRetries}): ${summary}`;
    this.addLog("error", this.statusReason);
    notify({
      title: "Orca: ревью не пройдено",
      body: this.statusReason,
      level: "error",
      action: { name: "pane.focus", args: { terminal: runCtx.terminal } },
    });
    playSound("blocked");
    cx.notify();
  }

  enterWaitingCi(reason, cx) {
    const pollMs = this.getCiPollMs();
    this.nextCiCheckAt = Date.now() + pollMs;
    this.statusReason = reason || null;
    this.setState("waiting_ci");
    this.addLog(
      "info",
      `Ожидание CI (следующая проверка через ${Math.round(pollMs / 60000)} мин)`,
    );
    cx.notify();
  }

  checkCiNow(cx) {
    if (this.state !== "waiting_ci" || this.ciChecking) return;
    this.runCiCheck(cx);
  }

  runCiCheck(cx) {
    if (this.ciChecking) return;
    const runCtx = this.boundRun;
    const item = this.currentItem;
    if (!runCtx || !item) return;

    if (!runCtx.projectRoot) {
      this.pausedFromState = "waiting_ci";
      this.runSeq++;
      this.setState("paused");
      this.statusReason = "Не определён корень проекта для проверки CI";
      this.addLog("error", this.statusReason);
      notify({ title: "Orca: ошибка CI", body: this.statusReason, level: "warning" });
      playSound("blocked");
      cx.notify();
      return;
    }

    this.ciChecking = true;
    const seq = this.runSeq;
    this.nextCiCheckAt = null;
    this.addLog("info", "Проверка статуса GitHub CI…");
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const ci = await checkGithubCiStatus(runCtx.projectRoot, runCtx.on, exec);
        if (this.runSeq !== seq) return;
        this.ciInfo = ci;

        if (ci.state === "success") {
          this.addLog("success", ci.summary || "CI прошёл успешно");
          await this.markDoneAndAdvance(seq, cx);
          return;
        }

        if (ci.state === "pending") {
          this.nextCiCheckAt = Date.now() + this.getCiPollMs();
          this.statusReason = ci.summary || "CI ещё выполняется";
          this.addLog(
            "info",
            `${this.statusReason} — следующая проверка через ${this.settings.ciPollMinutes || 5} мин`,
          );
          return;
        }

        if (ci.state === "failure") {
          await this.handleCiFailure(runCtx, item, ci, seq, cx);
          return;
        }

        this.pausedFromState = "waiting_ci";
        this.runSeq++;
        this.setState("paused");
        this.statusReason = ci.summary || "Не удалось получить статус CI";
        this.addLog("error", this.statusReason);
        notify({
          title: "Orca: ошибка проверки CI",
          body: this.statusReason,
          level: "warning",
        });
        playSound("blocked");
      } catch (err) {
        if (this.runSeq !== seq) return;
        this.pausedFromState = "waiting_ci";
        this.runSeq++;
        this.setState("paused");
        this.statusReason = `Ошибка проверки CI: ${String(err?.message ?? err)}`;
        this.addLog("error", this.statusReason);
        notify({
          title: "Orca: ошибка проверки CI",
          body: this.statusReason,
          level: "error",
        });
        playSound("blocked");
      } finally {
        this.ciChecking = false;
        if (this.runSeq === seq) {
          this.sendingPrompt = false;
        }
        cx.notify();
      }
    });
  }

  async handleCiFailure(runCtx, item, ci, seq, cx) {
    const maxRetries = this.settings?.maxCiRetries ?? 3;
    if (shouldRetryCi(this.ciRetryCount, maxRetries)) {
      this.ciRetryCount += 1;
      this.sendingPrompt = true;
      this.setState("fixing_ci");
      this.statusReason = ci.summary || "CI упал — отправка логов агенту";
      const maxLabel = maxRetries === 0 ? "∞" : String(maxRetries);
      this.addLog(
        "warn",
        `CI упал (попытка ${this.ciRetryCount}/${maxLabel}): ${ci.summary}`,
      );
      cx.notify();

      try {
        const logTail = await fetchFailedCiLogs(
          runCtx.projectRoot,
          ci.failedRunId,
          runCtx.on,
          exec,
        );
        if (this.runSeq !== seq) return;

        const fixPrompt = buildCiFixPrompt(
          item.epic,
          item.task,
          ci,
          logTail,
          this.ciRetryCount,
          maxRetries,
        );
        const sendRes = await hc(["send", runCtx.terminal, fixPrompt]).catch((e) => ({
          code: 1,
          stderr: String(e),
        }));
        if (this.runSeq !== seq) return;

        if (sendRes.code !== 0) {
          this.sendingPrompt = false;
          this.failRun(
            `Не удалось отправить фикс CI в ${runCtx.terminal}: ${sendRes.stderr || "ошибка hc send"}`,
            cx,
          );
          return;
        }

        this.sentAt = Date.now();
        this.lastAgentStatus = this.readTerminalAgentStatus(runCtx.terminal);
        this.sawWorkingSinceSend = this.lastAgentStatus === "working";
        this.idleSince = null;
        this.sendingPrompt = false;
        this.setState("watching");
        this.addLog("info", `Отправлен промпт фикса CI (попытка ${this.ciRetryCount})`);
        cx.notify();
      } finally {
        if (this.runSeq === seq) {
          this.sendingPrompt = false;
        }
      }
      return;
    }

    this.runSeq++;
    this.setState("error");
    this.statusReason = `Исчерпан лимит попыток фикса CI (${maxRetries}): ${ci.summary}`;
    this.addLog("error", this.statusReason);
    notify({
      title: "Orca: CI не исправлен",
      body: this.statusReason,
      level: "error",
      action: { name: "pane.focus", args: { terminal: runCtx.terminal } },
    });
    playSound("blocked");
    cx.notify();
  }

  async markItemStatusOnDisk(item, status, on) {
    const epic = item.epic;
    const task = item.task;
    const nextText = task
      ? updateTaskStatus(epic.rawText, task.lineIndex, status)
      : updateEpicStatus(epic.rawText, status);

    if (nextText === epic.rawText) return;

    try {
      await writeTextFile(epic.filePath, nextText, epic.rawText);
    } catch {
      const freshRaw = await readTextFile(epic.filePath, { on }).catch(() => null);
      if (freshRaw === null) {
        throw new Error(`Не удалось перечитать ${epic.filePath}`);
      }
      const freshEpic = parseEpicFile(epic.filename, freshRaw, epic.filePath);
      let freshTask = null;
      if (task) {
        freshTask =
          freshEpic.tasks.find((t) => t.hasExplicitId && t.id === task.id) ??
          freshEpic.tasks.find((t) => t.title === task.title) ??
          freshEpic.tasks[task.index] ??
          null;
        if (!freshTask) return;
      }
      const retryText = freshTask
        ? updateTaskStatus(freshRaw, freshTask.lineIndex, status)
        : updateEpicStatus(freshRaw, status);
      if (retryText === freshRaw) return;
      await writeTextFile(epic.filePath, retryText, freshRaw);
    }
  }

  async markItemDoneOnDisk(item, on) {
    return this.markItemStatusOnDisk(item, "done", on);
  }

  async markDoneAndAdvance(seq, cx) {
    const runCtx = this.boundRun;
    const item = this.currentItem;
    if (!runCtx || !item) return;

    this.setState("advancing");
    cx.notify();

    const doneLabel = item.task ? `${item.epic.id} · ${item.task.id}` : item.epic.id;
    await this.markItemDoneOnDisk(item, runCtx.on);
    if (this.runSeq !== seq) return;

    this.addLog("success", `Отмечено выполненным: ${doneLabel}`);

    await this.reloadEpicsForDir(runCtx.backlogDir, runCtx.on);
    if (this.runSeq !== seq) return;

    this.ciRetryCount = 0;
    this.reviewRetryCount = 0;
    this.reviewProgress = null;
    this.ciInfo = null;
    this.nextCiCheckAt = null;
    this.lastVerdict = null;
    this.statusReason = null;

    const next = this.pickNextAvailableItem();
    if (!next) {
      this.completeBacklog(cx);
      return;
    }

    this.currentItem = next;
    const nextLabel = next.task ? `${next.epic.id} · ${next.task.id}` : next.epic.id;
    await this.markItemStatusOnDisk(next, "in_progress", runCtx.on).catch(() => {});
    await this.reloadEpicsForDir(runCtx.backlogDir, runCtx.on).catch(() => {});
    if (this.runSeq !== seq) return;

    const activeNext = this.currentItem ?? next;
    const prompt = buildAgentPrompt(activeNext.epic, activeNext.task, runCtx.projectRoot);
    const sendRes = await hc(["send", runCtx.terminal, prompt]).catch((e) => ({
      code: 1,
      stderr: String(e),
    }));
    if (this.runSeq !== seq) return;

    if (sendRes.code !== 0) {
      this.failRun(
        `Не удалось отправить следующую задачу в ${runCtx.terminal}: ${sendRes.stderr || "ошибка hc send"}`,
        cx,
      );
      return;
    }

    this.sentAt = Date.now();
    this.lastAgentStatus = this.readTerminalAgentStatus(runCtx.terminal);
    this.sawWorkingSinceSend = this.lastAgentStatus === "working";
    this.idleSince = null;
    this.setState("watching");
    this.addLog("info", `Запущена следующая задача: ${nextLabel}`);
    cx.notify();
  }

  completeBacklog(cx) {
    this.runSeq++;
    this.sendingPrompt = false;
    this.boundRun = null;
    this.currentItem = null;
    this.skippedKeys.clear();
    this.ciRetryCount = 0;
    this.reviewRetryCount = 0;
    this.reviewProgress = null;
    this.ciInfo = null;
    this.nextCiCheckAt = null;
    this.lastVerdict = null;
    this.statusReason = null;
    this.pausedFromState = null;
    this.sentAt = 0;
    this.sawWorkingSinceSend = false;
    this.idleSince = null;
    this.lastAgentStatus = null;
    this.setState("idle");
    this.addLog("success", "Весь бэклог выполнен!");
    notify({
      title: "Orca: бэклог выполнен",
      body: "Все открытые задачи завершены",
      level: "success",
    });
    playSound("done");
    cx.notify();
  }

  onKeyDown(e, cx) {
    if (e.key === "escape") {
      if (this.sessionPickerOpen) {
        this.sessionPickerOpen = false;
        cx.stop_propagation();
        cx.notify();
      } else if (this.settingsOpen) {
        this.toggleSettings(cx);
        cx.stop_propagation();
      }
    }
  }

  render(cx) {
    if (!checking() && this.state === "idle") {
      const ctx = this.resolveContext();
      if (ctx.key !== this.contextKey) {
        this.refresh(cx, true);
      }
    }

    const t = theme();
    return v_flex()
      .id("orca-root")
      .size_full()
      .min_h(0)
      .min_w(0)
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        const z = Number(settings()?.zoom) || 1;
        const logical = { width: size.width / z, height: size.height / z };
        if (
          !this.size ||
          Math.abs(this.size.width - logical.width) > 2 ||
          Math.abs(this.size.height - logical.height) > 2
        ) {
          this.size = logical;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => this.onKeyDown(e, cx))
      .child(renderHeader(this, t))
      .child(renderSessionAndBacklog(this, t))
      .child(renderPipelineStrip(this, t))
      .child(renderQueueAndLog(this, t))
      .child(renderFooterAndSettings(this, t));
  }
}
