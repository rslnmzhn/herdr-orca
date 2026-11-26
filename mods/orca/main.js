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
  appHome,
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
import {
  resolveStartAction,
  resolveCompletedCiAction,
  shouldRunAutoCompact,
} from "./guards.js";
import { createReviewerToolExecutor, buildReviewFixPrompt } from "./reviewer_tools.js";
import { checkOrcaUpdate, runOrcaUpdate } from "./updater.js";
import {
  ORCA_ACTIVE_STATES,
  createSessionState,
  getOrCreateSession,
  buildOrcaUiSnapshot,
} from "./sessions.js";
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
const STORAGE_UPDATE_SHA = "orca.updateSha";

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
  const autoCompact = Boolean(obj.autoCompact);
  const parsedPoll = Number(obj.ciPollMinutes);
  const ciPollMinutes = Number.isFinite(parsedPoll) && parsedPoll > 0 ? parsedPoll : 5;
  return {
    baseUrl,
    apiKey,
    model,
    maxCiRetries,
    maxReviewRetries,
    reviewMode,
    autoCompact,
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
    try {
      const parsed = JSON.parse(r.stdout || "[]");
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return null;
    }
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

    const savedMode = shared(STORAGE_MODE);
    this.defaultMode = savedMode === "epics" ? "epics" : "tasks";

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
    this.modelPickerOpen = false;
    this.modelFilter = "";
    this.updating = false;
    this.updateAvailable = false;
    this.checkingUpdate = false;
    this.updateCheckError = null;

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

    this.modelSearchInput = InputState.new({
      placeholder: "Фильтр моделей…",
    });
    this.modelSearchInput.on("change", (_e, cx) => {
      this.modelFilter = this.modelSearchInput.value();
      cx.notify();
    });

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

    this.sessions = new Map();
    this.fallbackSession = createSessionState(null, { mode: this.defaultMode });
    this.selectedTerminal = null;
    this.lastFocusedTerminal = null;
    this.sessionPickerOpen = false;

    this.dirWatches = new Map();
    this.fileWriteLocks = new Map();
    this._lastPublishedUiJson = null;

    if (checking()) return;

    this.syncSelectedTerminalWithFocus();
    this.publishUiState();
    this.refresh(cx, true);
    this.checkForUpdates(cx);

    cx.timer.every(1000, (cx) => this.onTick(cx));
    cx.timer.every(10000, (cx) => this.onBacklogTimer(cx));

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        const session = this.activeSession();
        if (cmd === "focus") {
          this.handle.focus();
        } else if (cmd === "start") {
          if (session.state === "paused") {
            this.resume(cx);
          } else if (session.state === "idle" || session.state === "error") {
            this.start(cx);
          }
        } else if (cmd === "pause") {
          if (this.isSessionActive(session)) {
            this.pause(cx);
          }
        } else if (cmd === "stop") {
          if (session.state !== "idle") {
            this.stop(cx);
          }
        } else if (cmd === "check-ci") {
          if (session.state === "waiting_ci") {
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
    for (const s of this.sessions.values()) {
      s.runSeq++;
    }
    this.stopAllWatches();
  }

  activeSession() {
    if (!this.selectedTerminal) return this.fallbackSession;
    return getOrCreateSession(this.sessions, this.selectedTerminal, {
      mode: this.defaultMode,
    });
  }

  isSessionActive(session) {
    return Boolean(session && ORCA_ACTIVE_STATES.has(session.state));
  }

  getCiPollMs() {
    const mins = Number(this.settings?.ciPollMinutes);
    return (Number.isFinite(mins) && mins > 0 ? mins : 5) * 60 * 1000;
  }

  addLog(session, level, text) {
    if (!session) return;
    const entry = {
      time: Date.now(),
      level: level || "info",
      text: String(text ?? ""),
    };
    session.logs = [entry, ...session.logs].slice(0, MAX_LOGS);
  }

  publishUiState() {
    const t = theme();
    const next = buildOrcaUiSnapshot(
      this.sessions,
      this.selectedTerminal,
      this.settings,
      (st) => statusMeta(t, st).label,
    );
    const serialized = JSON.stringify(next);
    if (serialized === this._lastPublishedUiJson) return;
    this._lastPublishedUiJson = serialized;
    setShared(STORAGE_UI, next);
  }

  setSessionState(session, nextState) {
    if (!session) return;
    session.state = nextState;
    this.publishUiState();
  }

  stopAllWatches() {
    for (const entry of this.dirWatches.values()) {
      entry.active = false;
      try {
        entry.handle?.cancel();
      } catch {}
    }
    this.dirWatches.clear();
  }

  syncWatches(cx) {
    const wantedDirs = new Set();
    for (const s of this.sessions.values()) {
      if (!s.backlogDir || s.on) continue;
      if (s.state !== "idle" || s.terminal === this.selectedTerminal) {
        wantedDirs.add(s.backlogDir);
      }
    }

    for (const [dir, entry] of this.dirWatches.entries()) {
      if (!wantedDirs.has(dir)) {
        entry.active = false;
        try {
          entry.handle?.cancel();
        } catch {}
        this.dirWatches.delete(dir);
      }
    }

    for (const dir of wantedDirs) {
      if (this.dirWatches.has(dir)) continue;
      const entry = { active: true, handle: null };
      this.dirWatches.set(dir, entry);
      cx.spawn(async (cx) => {
        while (entry.active && this.dirWatches.get(dir) === entry) {
          const watch = watchFolder(dir);
          entry.handle = watch;
          try {
            const changed = await watch;
            if (!entry.active || this.dirWatches.get(dir) !== entry) break;
            if (Array.isArray(changed) && changed.length === 0) break;
            await this.reloadSessionsForDir(dir, null);
            cx.notify();
          } catch {
            if (this.dirWatches.get(dir) === entry) {
              this.dirWatches.delete(dir);
            }
            break;
          }
        }
      });
    }
  }

  async reloadSessionsForDir(dir, on) {
    if (!dir) return;
    const files = await listMarkdownFiles(dir, on);
    if (!files) return;
    const loaded = await this.loadEpicsFromFiles(dir, files, on);
    for (const s of this.sessions.values()) {
      const sDir = s.boundRun?.backlogDir ?? s.backlogDir;
      const sOn = s.boundRun ? s.boundRun.on : s.on;
      if (sDir === dir && (sOn ?? null) === (on ?? null)) {
        s.epics = loaded;
        this.syncCurrentItemWithEpics(s);
      }
    }
  }

  findTerminalMeta(address) {
    const allSpaces = spaces() ?? [];
    const allPanes = panes() ?? [];
    const allAgents = agents() ?? [];
    const allTerminals = terminals() ?? [];

    const spaceById = new Map(allSpaces.map((s) => [s.id, s]));
    const spaceByTab = new Map();
    for (const s of allSpaces) {
      for (const tab of s.tabs ?? []) {
        spaceByTab.set(tab.id, s);
      }
    }

    const term = address ? allTerminals.find((t) => t.address === address) ?? null : null;
    const pane = address ? allPanes.find((p) => p.terminal === address) ?? null : null;
    const agent = address ? allAgents.find((a) => a.address === address) ?? null : null;
    const space =
      (agent?.space ? spaceById.get(agent.space) : null) ??
      (pane?.tab ? spaceByTab.get(pane.tab) : null) ??
      allSpaces.find((s) => s.active) ??
      null;

    const cwd = pane?.cwd || term?.cwd || space?.folder || null;
    const on = space?.machine ?? null;
    return { term, pane, agent, space, cwd: normPath(cwd), on };
  }

  resolveSessionContext(session) {
    const meta = this.findTerminalMeta(session?.terminal);
    const space = meta.space;
    const on = meta.on;
    const spaceKey = space?.id ?? "__global__";
    const termKey = session?.terminal ? `term:${session.terminal}` : null;

    const sharedFolders = shared(STORAGE_FOLDERS);
    if (sharedFolders && typeof sharedFolders === "object" && !Array.isArray(sharedFolders)) {
      this.spaceFolders = sharedFolders;
    }

    const overrideFolder = session?.overrideFolder ? normPath(session.overrideFolder) : null;
    const propFolder = normPath(props()?.folder);
    const manualDir =
      (termKey ? normPath(this.spaceFolders[termKey]) : null) ||
      normPath(this.spaceFolders[spaceKey]);

    const key = JSON.stringify([
      session?.terminal ?? null,
      spaceKey,
      on,
      overrideFolder,
      propFolder,
      manualDir,
      meta.cwd,
    ]);

    return {
      space,
      spaceKey,
      termKey,
      on,
      overrideFolder,
      propFolder,
      manualDir,
      paneCwd: meta.cwd,
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

  async reloadEpicsForSession(session, dir, on) {
    if (!session || !dir) return;
    const files = await listMarkdownFiles(dir, on);
    if (!files) return;
    const loaded = await this.loadEpicsFromFiles(dir, files, on);
    session.epics = loaded;
    this.syncCurrentItemWithEpics(session);
  }

  syncCurrentItemWithEpics(session) {
    if (!session?.currentItem) return;
    const prevEpic = session.currentItem.epic;
    const prevTask = session.currentItem.task;
    const freshEpic = session.epics.find((e) => e.filePath === prevEpic?.filePath) ?? null;
    if (!freshEpic) {
      if (session.state === "idle") session.currentItem = null;
      return;
    }
    if (!prevTask) {
      if (session.state === "idle" && (freshEpic.status === "done" || freshEpic.status === "blocked")) {
        session.currentItem = null;
      } else {
        session.currentItem = { epic: freshEpic, task: null };
      }
      return;
    }
    const freshTask =
      freshEpic.tasks.find((t) => t.hasExplicitId && t.id === prevTask.id) ??
      freshEpic.tasks.find((t) => t.lineIndex === prevTask.lineIndex) ??
      freshEpic.tasks.find((t) => t.title === prevTask.title) ??
      null;
    if (!freshTask) {
      if (session.state === "idle") session.currentItem = null;
      return;
    }
    if (session.state === "idle" && (freshTask.status === "done" || freshTask.status === "blocked")) {
      session.currentItem = null;
      return;
    }
    session.currentItem = { epic: freshEpic, task: freshTask };
  }

  onBacklogTimer(cx) {
    this.refresh(cx, false);
  }

  refreshBacklog(cx) {
    this.refresh(cx, true);
  }

  refresh(cx, force = false) {
    this.syncSelectedTerminalWithFocus();
    const session = this.activeSession();
    if (!session.terminal) {
      this.publishUiState();
      cx.notify();
      return;
    }
    this.refreshSession(session, cx, force);
  }

  refreshSession(session, cx, force = false) {
    if (!session || !session.terminal) return;

    if (session.boundRun) {
      if (session.loading && !force) return;
      const runDir = session.boundRun.backlogDir;
      const runOn = session.boundRun.on;
      if (!runDir) return;
      session.loading = true;
      cx.spawn(async (cx) => {
        try {
          await this.reloadEpicsForSession(session, runDir, runOn);
        } finally {
          session.loading = false;
          cx.notify();
        }
      });
      return;
    }

    const ctx = this.resolveSessionContext(session);
    const contextChanged = ctx.key !== session.contextKey;
    if (contextChanged) {
      session.contextKey = ctx.key;
      session.spaceId = ctx.space?.id ?? null;
      session.on = ctx.on;
      session.readOnly = Boolean(ctx.on);
      session.currentItem = null;
    }
    if (session.loading && !force && !contextChanged) return;

    const expectedKey = ctx.key;
    session.loading = true;
    cx.spawn(async (cx) => {
      try {
        const detected = await this.detectBacklogDir(ctx);
        if (session.boundRun || session.contextKey !== expectedKey) return;

        session.backlogDir = detected.backlogDir;
        session.projectRoot = detected.projectRoot;

        if (!detected.backlogDir) {
          session.epics = [];
          session.currentItem = null;
        } else {
          const loaded = await this.loadEpicsFromFiles(
            detected.backlogDir,
            detected.files,
            ctx.on,
          );
          if (session.boundRun || session.contextKey !== expectedKey) return;
          session.epics = loaded;
          this.syncCurrentItemWithEpics(session);
        }

        this.syncWatches(cx);
        this.publishUiState();
      } finally {
        if (!session.boundRun && session.contextKey === expectedKey) {
          session.loading = false;
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
    const activeSpaceId = allSpaces.find((s) => s.active)?.id ?? null;

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

      const isAgent = Boolean(agent || term.program?.agent);
      const orcaSession = this.sessions.get(term.address) ?? null;
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
        orcaState: orcaSession?.state ?? "idle",
        isAgent,
        inActiveSpace: Boolean(activeSpaceId && space?.id === activeSpaceId),
        isFocused: f?.terminal === term.address || Boolean(agent?.focused || pane?.focused),
        spaceName: space?.name ?? "",
        spaceId: space?.id ?? null,
      });
    }

    choices.sort((a, b) => {
      const aActive = a.orcaState !== "idle" ? 1 : 0;
      const bActive = b.orcaState !== "idle" ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      if (a.inActiveSpace !== b.inActiveSpace) return a.inActiveSpace ? -1 : 1;
      if (a.isAgent !== b.isAgent) return a.isAgent ? -1 : 1;
      if (a.isFocused !== b.isFocused) return a.isFocused ? -1 : 1;
      return a.address.localeCompare(b.address);
    });

    return choices;
  }

  getActiveSessions() {
    const choices = this.getSessionChoices();
    const choiceByAddr = new Map(choices.map((c) => [c.address, c]));
    const list = [];
    for (const s of this.sessions.values()) {
      if (!s || s.state === "idle") continue;
      const c = choiceByAddr.get(s.terminal);
      list.push({
        terminal: s.terminal,
        label: c?.label ?? s.terminal,
        programName: c?.programName ?? s.terminal,
        state: s.state,
        isActive: ORCA_ACTIVE_STATES.has(s.state),
      });
    }
    list.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.terminal.localeCompare(b.terminal);
    });
    return list;
  }

  syncSelectedTerminalWithFocus() {
    const f = focused();
    const focusedTerm = f?.terminal ?? null;
    if (focusedTerm && focusedTerm !== this.lastFocusedTerminal) {
      this.lastFocusedTerminal = focusedTerm;
      if (this.isTerminalLive(focusedTerm)) {
        this.selectedTerminal = focusedTerm;
        getOrCreateSession(this.sessions, focusedTerm, { mode: this.defaultMode });
        return;
      }
    }

    if (this.selectedTerminal && this.isTerminalLive(this.selectedTerminal)) {
      getOrCreateSession(this.sessions, this.selectedTerminal, { mode: this.defaultMode });
      return;
    }

    const choices = this.getSessionChoices();
    if (choices.length === 0) {
      this.selectedTerminal = null;
      return;
    }
    const preferred =
      choices.find((c) => c.inActiveSpace && c.isAgent && c.isFocused) ??
      choices.find((c) => c.inActiveSpace && c.isAgent) ??
      choices.find((c) => c.inActiveSpace) ??
      choices.find((c) => c.isAgent) ??
      choices[0];
    this.selectedTerminal = preferred?.address ?? null;
    if (this.selectedTerminal) {
      getOrCreateSession(this.sessions, this.selectedTerminal, { mode: this.defaultMode });
    }
  }

  toggleSessionPicker(cx) {
    this.sessionPickerOpen = !this.sessionPickerOpen;
    cx.notify();
  }

  selectTerminal(address, cx) {
    if (!address) return;
    this.selectedTerminal = address;
    this.sessionPickerOpen = false;
    const session = getOrCreateSession(this.sessions, address, { mode: this.defaultMode });
    this.publishUiState();
    this.refreshSession(session, cx, true);
    cx.notify();
  }

  chooseFolder(cx) {
    const session = this.activeSession();
    if (!session.terminal) {
      notify({ title: "Выберите сессию агента", level: "warning" });
      return;
    }
    if (session.state !== "idle" && session.state !== "error") {
      notify({
        title: "Остановите Orca для этой сессии перед сменой папки",
        level: "warning",
      });
      return;
    }
    if (session.on) {
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

      const ctx = this.resolveSessionContext(session);
      session.overrideFolder = targetDir;
      const sharedCurrent = shared(STORAGE_FOLDERS);
      const base =
        sharedCurrent && typeof sharedCurrent === "object" && !Array.isArray(sharedCurrent)
          ? sharedCurrent
          : this.spaceFolders;
      const nextFolders = { ...base };
      if (ctx.termKey) nextFolders[ctx.termKey] = targetDir;
      nextFolders[ctx.spaceKey] = targetDir;
      this.spaceFolders = nextFolders;
      setShared(STORAGE_FOLDERS, this.spaceFolders);
      this.refreshSession(session, cx, true);
    });
  }

  setMode(mode, cx) {
    const nextMode = mode === "epics" ? "epics" : "tasks";
    const session = this.activeSession();
    this.defaultMode = nextMode;
    setShared(STORAGE_MODE, nextMode);
    if (session.mode === nextMode) return;
    session.mode = nextMode;
    if (session.state === "idle") {
      session.currentItem = null;
    }
    cx.notify();
  }

  setReviewMode(mode, cx) {
    const nextMode = mode === "auto" ? "auto" : "reviewer";
    if (this.settings.reviewMode === nextMode) return;
    this.settings = { ...this.settings, reviewMode: nextMode };
    setShared(STORAGE_SETTINGS, this.settings);
    this.publishUiState();
    this.addLog(
      this.activeSession(),
      "info",
      nextMode === "reviewer"
        ? "Включён режим Ревьювер (проверка кода, diff и тестов)"
        : "Включён режим Авто (быстрая отправка задач)",
    );
    cx.notify();
  }

  toggleAutoCompact(cx) {
    const next = !this.settings.autoCompact;
    this.settings = { ...this.settings, autoCompact: next };
    setShared(STORAGE_SETTINGS, this.settings);
    this.addLog(
      this.activeSession(),
      "info",
      next
        ? "Автокомпакт включён (/compact перед каждой новой задачей)"
        : "Автокомпакт выключен",
    );
    cx.notify();
  }

  getQueueItems(session = this.activeSession()) {
    return listQueueItems(session?.epics ?? [], session?.mode ?? this.defaultMode);
  }

  pickNextAvailableItem(session) {
    const items = this.getQueueItems(session);
    for (const item of items) {
      const key = queueItemKey(item);
      if (key && !session.skippedKeys.has(key)) {
        return item;
      }
    }
    return pickNextQueueItem(session.epics, session.mode);
  }

  focusQueueItem(item, cx) {
    if (!item) return;
    const session = this.activeSession();
    if (session.state === "idle" || session.state === "paused" || session.state === "error") {
      session.currentItem = item;
      const label = item.task ? `${item.epic.id} · ${item.task.id}` : item.epic.id;
      this.addLog(session, "info", `Выбрана задача: ${label}`);
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
    this.modelPickerOpen = false;
    this.modelFilter = "";
    this.modelSearchInput.set_value("");
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

  toggleModelPicker(cx) {
    if (!this.availableModels?.length) return;
    this.modelPickerOpen = !this.modelPickerOpen;
    if (this.modelPickerOpen) {
      this.modelFilter = "";
      this.modelSearchInput.set_value("");
    }
    cx.notify();
  }

  selectModel(modelId, cx) {
    this.modelInput.set_value(modelId);
    this.modelPickerOpen = false;
    this.modelFilter = "";
    this.modelSearchInput.set_value("");
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
    this.modelPickerOpen = false;
    this.modelFilter = "";
    this.modelSearchInput.set_value("");
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
    this.modelPickerOpen = false;
    this.modelFilter = "";
    this.modelSearchInput.set_value("");
    this.publishUiState();
    this.handle.focus();

    notify({
      title: "Настройки Orca сохранены",
      body: model ? `Модель: ${model}` : normalizedUrl,
      level: "success",
    });
    cx.notify();
  }

  checkForUpdates(cx) {
    if (this.checkingUpdate || this.updating) return;
    this.checkingUpdate = true;
    this.updateCheckError = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const knownSha = shared(STORAGE_UPDATE_SHA);
        const res = await checkOrcaUpdate({
          appHomeDir: appHome(),
          knownSha: typeof knownSha === "string" ? knownSha : null,
          execFn: exec,
          readTextFileFn: readTextFile,
          platform: window()?.platform ?? "windows",
        });
        if (res.ok) {
          this.updateAvailable = Boolean(res.available);
          this.updateCheckError = null;
          if (res.syncedSha) {
            setShared(STORAGE_UPDATE_SHA, res.syncedSha);
          }
        } else {
          this.updateAvailable = false;
          this.updateCheckError = res.error || "Не удалось проверить обновления";
        }
      } catch (err) {
        this.updateAvailable = false;
        this.updateCheckError = String(err?.message ?? err);
      } finally {
        this.checkingUpdate = false;
        cx.notify();
      }
    });
  }

  updateOrca(cx) {
    if (this.updating || !this.updateAvailable) return;
    this.updating = true;
    const session = this.activeSession();
    this.addLog(session, "info", "Запуск обновления Orca…");
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const res = await runOrcaUpdate({
          appHomeDir: appHome(),
          settings: this.settings,
          execFn: exec,
          readTextFileFn: readTextFile,
          writeTextFileFn: writeTextFile,
          fetchFn: fetch,
          platform: window()?.platform ?? "windows",
          onProgress: (msg) => {
            this.addLog(this.activeSession(), "info", msg);
            cx.notify();
          },
        });
        const target = this.activeSession();
        if (res.ok) {
          this.updateAvailable = false;
          if (res.remoteSha) {
            setShared(STORAGE_UPDATE_SHA, res.remoteSha);
          }
          this.addLog(target, "success", res.message || "Orca обновлён");
          notify({ title: "Orca", body: res.message || "Orca обновлён", level: "success" });
          playSound("done");
        } else {
          this.addLog(target, "error", res.error || "Не удалось обновить Orca");
          notify({ title: "Ошибка обновления Orca", body: res.error || "Не удалось обновить Orca", level: "error" });
          playSound("blocked");
        }
      } catch (err) {
        const msg = String(err?.message ?? err);
        this.addLog(this.activeSession(), "error", `Ошибка обновления: ${msg}`);
        notify({ title: "Ошибка обновления Orca", body: msg, level: "error" });
        playSound("blocked");
      } finally {
        this.updating = false;
        cx.notify();
      }
    });
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

  failRun(session, reason, cx) {
    if (!session) return;
    session.runSeq++;
    session.sendingPrompt = false;
    session.idleSince = null;
    session.nextCiCheckAt = null;
    session.reviewProgress = null;
    session.statusReason = reason;
    this.setSessionState(session, "error");
    this.addLog(session, "error", reason);
    notify({
      title: `Orca (${session.terminal}): ошибка`,
      body: reason,
      level: "error",
      ...(session.terminal
        ? { action: { name: "pane.focus", args: { terminal: session.terminal } } }
        : {}),
    });
    playSound("blocked");
    cx.notify();
  }

  start(cx) {
    this.syncSelectedTerminalWithFocus();
    const session = this.activeSession();
    if (!session.terminal || !this.isTerminalLive(session.terminal)) {
      session.statusReason = "Выберите живую сессию агента";
      notify({
        title: "Сессия не выбрана",
        body: session.statusReason,
        level: "warning",
      });
      cx.notify();
      return;
    }
    if (this.isSessionActive(session)) return;

    session.boundRun = null;
    session.sendingPrompt = false;

    const baseUrl = normalizeBaseUrl(this.settings?.baseUrl);
    const model = this.settings?.model?.trim();
    if (!baseUrl || !model) {
      this.settingsOpen = true;
      session.statusReason = "Укажите Base URL и модель классификатора в настройках";
      notify({
        title: "Настройте классификатор",
        body: session.statusReason,
        level: "warning",
      });
      cx.notify();
      return;
    }

    if (!session.backlogDir) {
      session.statusReason = "Папка backlog не найдена";
      notify({
        title: "Бэклог не найден",
        body: "Выберите папку backlog перед запуском",
        level: "warning",
      });
      cx.notify();
      return;
    }

    if (session.readOnly) {
      session.statusReason = "Удалённый бэклог в режиме только чтения";
      notify({
        title: "Только чтение",
        body: "Запись статусов на удалённую машину не поддерживается",
        level: "warning",
      });
      cx.notify();
      return;
    }

    session.skippedKeys.clear();
    const queue = this.getQueueItems(session);
    const chosen =
      session.currentItem && queue.some((q) => queueItemKey(q) === queueItemKey(session.currentItem))
        ? session.currentItem
        : this.pickNextAvailableItem(session);

    if (!chosen) {
      this.completeBacklog(session, cx);
      return;
    }

    const agentStatus = this.readTerminalAgentStatus(session.terminal);
    const startAction = resolveStartAction(agentStatus);
    if (startAction === "block") {
      session.statusReason = "Агент в выбранной сессии ожидает ответа пользователя (blocked)";
      this.addLog(session, "warn", session.statusReason);
      notify({
        title: `Orca (${session.terminal}): требуется внимание`,
        body: session.statusReason,
        level: "warning",
        action: { name: "pane.focus", args: { terminal: session.terminal } },
      });
      playSound("blocked");
      cx.notify();
      return;
    }

    const meta = this.findTerminalMeta(session.terminal);
    session.boundRun = {
      spaceId: meta.space?.id ?? session.spaceId ?? null,
      terminal: session.terminal,
      backlogDir: session.backlogDir,
      projectRoot: session.projectRoot || parentDir(session.backlogDir) || meta.space?.folder || null,
      on: session.on ?? null,
    };
    session.currentItem = chosen;
    session.ciRetryCount = 0;
    session.reviewRetryCount = 0;
    session.reviewProgress = null;
    session.ciInfo = null;
    session.nextCiCheckAt = null;
    session.lastVerdict = null;
    session.statusReason = null;
    session.pausedFromState = null;
    this.sessionPickerOpen = false;
    this.syncWatches(cx);

    if (startAction === "attach") {
      session.sentAt = Date.now();
      session.sawWorkingSinceSend = true;
      session.lastAgentStatus = "working";
      session.idleSince = null;
      this.setSessionState(session, "watching");
      this.addLog(
        session,
        "info",
        `Подключено к активной сессии ${session.terminal} (ожидание завершения хода)`,
      );
      cx.notify();
      return;
    }

    this.dispatchCurrentItem(session, cx);
  }

  reviewCurrentTurn(cx) {
    this.syncSelectedTerminalWithFocus();
    const session = this.activeSession();
    if (!session.terminal || !this.isTerminalLive(session.terminal)) {
      session.statusReason = "Выберите живую сессию агента";
      notify({
        title: "Сессия не выбрана",
        body: session.statusReason,
        level: "warning",
      });
      cx.notify();
      return;
    }
    if (this.isSessionActive(session)) return;

    const baseUrl = normalizeBaseUrl(this.settings?.baseUrl);
    const model = this.settings?.model?.trim();
    if (!baseUrl || !model) {
      this.settingsOpen = true;
      session.statusReason = "Укажите Base URL и модель классификатора в настройках";
      notify({
        title: "Настройте классификатор",
        body: session.statusReason,
        level: "warning",
      });
      cx.notify();
      return;
    }

    const meta = this.findTerminalMeta(session.terminal);
    session.boundRun = {
      spaceId: meta.space?.id ?? session.spaceId ?? null,
      terminal: session.terminal,
      backlogDir: null,
      projectRoot: session.projectRoot || meta.cwd || meta.space?.folder || null,
      on: session.on ?? meta.on ?? null,
      standaloneReview: true,
    };
    session.currentItem = null;
    session.ciRetryCount = 0;
    session.reviewRetryCount = 0;
    session.reviewProgress = null;
    session.ciInfo = null;
    session.nextCiCheckAt = null;
    session.lastVerdict = null;
    session.statusReason = null;
    session.pausedFromState = null;
    this.sessionPickerOpen = false;
    this.syncWatches(cx);

    this.classifyCurrentTurn(session, cx);
  }

  dispatchCurrentItem(session, cx) {
    const runCtx = session?.boundRun;
    const item = session?.currentItem;
    if (!runCtx || !item) return;

    const seq = ++session.runSeq;
    const label = item.task ? `${item.epic.id} · ${item.task.id}` : item.epic.id;
    const prompt = buildAgentPrompt(item.epic, item.task, runCtx.projectRoot);

    session.sendingPrompt = true;
    this.setSessionState(session, "advancing");
    session.statusReason = null;
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        await this.markItemStatusOnDisk(item, "in_progress", runCtx.on).catch(() => {});
        await this.reloadEpicsForSession(session, runCtx.backlogDir, runCtx.on).catch(() => {});
        if (session.runSeq !== seq) return;

        const res = await hc(["send", runCtx.terminal, prompt]).catch((e) => ({
          code: 1,
          stderr: String(e),
        }));
        if (session.runSeq !== seq) return;

        if (res.code !== 0) {
          this.failRun(
            session,
            `Не удалось отправить задачу в ${runCtx.terminal}: ${res.stderr || "ошибка hc send"}`,
            cx,
          );
          return;
        }

        session.sentAt = Date.now();
        session.lastAgentStatus = this.readTerminalAgentStatus(runCtx.terminal);
        session.sawWorkingSinceSend = session.lastAgentStatus === "working";
        session.idleSince = null;
        this.setSessionState(session, "watching");
        this.addLog(session, "info", `Запущена задача ${label} в ${runCtx.terminal}`);
        cx.notify();
      } finally {
        if (session.runSeq === seq) {
          session.sendingPrompt = false;
        }
      }
    });
  }

  pause(cx) {
    const session = this.activeSession();
    if (!this.isSessionActive(session)) return;
    session.pausedFromState = session.state;
    session.runSeq++;
    session.sendingPrompt = false;
    session.idleSince = null;
    session.nextCiCheckAt = null;
    session.reviewProgress = null;
    this.setSessionState(session, "paused");
    session.statusReason = "Цикл поставлен на паузу";
    this.addLog(session, "warn", "Цикл поставлен на паузу");
    cx.notify();
  }

  resume(cx) {
    const session = this.activeSession();
    if (session.state !== "paused") return;
    if (!session.boundRun || !this.isTerminalLive(session.boundRun.terminal)) {
      this.failRun(session, "Целевой терминал больше не активен", cx);
      return;
    }

    session.runSeq++;
    session.statusReason = null;
    session.idleSince = null;

    if (session.pausedFromState === "waiting_ci") {
      session.pausedFromState = null;
      this.setSessionState(session, "waiting_ci");
      this.addLog(session, "info", "Возобновлено ожидание CI");
      this.runCiCheck(session, cx);
      return;
    }

    session.pausedFromState = null;
    if (session.currentItem || session.boundRun?.standaloneReview) {
      session.sentAt = Date.now();
      session.lastAgentStatus = this.readTerminalAgentStatus(session.boundRun.terminal);
      session.sawWorkingSinceSend = session.lastAgentStatus === "working";
      this.setSessionState(session, "watching");
      this.addLog(session, "info", "Наблюдение возобновлено");
      cx.notify();
    } else {
      this.start(cx);
    }
  }

  stop(cx) {
    const session = this.activeSession();
    if (!session.terminal) return;
    session.runSeq++;
    session.sendingPrompt = false;
    session.boundRun = null;
    session.currentItem = null;
    session.skippedKeys.clear();
    session.ciRetryCount = 0;
    session.reviewRetryCount = 0;
    session.reviewProgress = null;
    session.ciInfo = null;
    session.nextCiCheckAt = null;
    session.lastVerdict = null;
    session.statusReason = null;
    session.pausedFromState = null;
    session.sentAt = 0;
    session.sawWorkingSinceSend = false;
    session.idleSince = null;
    session.lastAgentStatus = null;
    this.setSessionState(session, "idle");
    this.addLog(session, "info", "Цикл остановлен");
    this.syncWatches(cx);
    this.refreshSession(session, cx, true);
    cx.notify();
  }

  skipCurrent(cx) {
    const session = this.activeSession();
    if (!session.boundRun) return;
    if (session.boundRun.standaloneReview || !session.currentItem) {
      this.stop(cx);
      return;
    }
    const key = queueItemKey(session.currentItem);
    if (key) session.skippedKeys.add(key);

    const label = session.currentItem.task
      ? `${session.currentItem.epic.id} · ${session.currentItem.task.id}`
      : session.currentItem.epic.id;
    this.addLog(session, "warn", `Пропущена задача ${label}`);

    session.ciRetryCount = 0;
    session.reviewRetryCount = 0;
    session.reviewProgress = null;
    session.ciInfo = null;
    session.nextCiCheckAt = null;
    session.lastVerdict = null;
    session.statusReason = null;
    session.pausedFromState = null;
    session.idleSince = null;

    const items = this.getQueueItems(session);
    const hasUnskipped = items.some((item) => {
      const k = queueItemKey(item);
      return k && !session.skippedKeys.has(k);
    });
    if (!hasUnskipped && items.length > 1) {
      session.skippedKeys.clear();
      if (key) session.skippedKeys.add(key);
    }

    const next = this.pickNextAvailableItem(session);
    if (!next) {
      this.completeBacklog(session, cx);
      return;
    }
    session.currentItem = next;
    this.dispatchCurrentItem(session, cx);
  }

  onTick(cx) {
    let shouldNotify = false;

    for (const [addr, session] of [...this.sessions.entries()]) {
      if (
        session.state === "idle" &&
        addr !== this.selectedTerminal &&
        session.logs.length === 0 &&
        !this.isTerminalLive(addr)
      ) {
        this.sessions.delete(addr);
        continue;
      }

      if (session.state === "waiting_ci") {
        if (session.nextCiCheckAt && Date.now() >= session.nextCiCheckAt && !session.ciChecking) {
          this.runCiCheck(session, cx);
        } else if (addr === this.selectedTerminal) {
          shouldNotify = true;
        }
        continue;
      }

      if (session.state !== "watching" && session.state !== "fixing_ci") {
        continue;
      }
      if (session.sendingPrompt) {
        continue;
      }

      const terminal = session.boundRun?.terminal ?? session.terminal;
      if (!terminal || !this.isTerminalLive(terminal)) {
        this.failRun(session, `Терминал ${terminal ?? ""} завершился или недоступен`, cx);
        continue;
      }

      const status = this.readTerminalAgentStatus(terminal);
      if (status === "blocked") {
        session.pausedFromState = session.state;
        session.runSeq++;
        session.idleSince = null;
        this.setSessionState(session, "paused");
        session.statusReason = "Агент ожидает ответа пользователя (blocked)";
        this.addLog(session, "warn", session.statusReason);
        notify({
          title: `Orca (${terminal}): требуется внимание`,
          body: session.statusReason,
          level: "warning",
          action: { name: "pane.focus", args: { terminal } },
        });
        playSound("blocked");
        shouldNotify = true;
        continue;
      }

      if (status === "working") {
        session.sawWorkingSinceSend = true;
        session.idleSince = null;
        session.lastAgentStatus = "working";
        continue;
      }

      const elapsedSinceSend = Date.now() - (session.sentAt || 0);
      if (!session.sawWorkingSinceSend && elapsedSinceSend < SENT_GRACE_MS) {
        continue;
      }

      if (status === "idle" || status === "done") {
        if (!session.idleSince) {
          session.idleSince = Date.now();
        } else if (Date.now() - session.idleSince >= IDLE_DEBOUNCE_MS) {
          session.idleSince = null;
          session.lastAgentStatus = status;
          this.classifyCurrentTurn(session, cx);
        }
      }
    }

    if (shouldNotify) {
      cx.notify();
    }
  }

  classifyCurrentTurn(session, cx) {
    const runCtx = session?.boundRun;
    const item = session?.currentItem ?? null;
    if (!runCtx || (!item && !runCtx.standaloneReview)) return;

    const isReviewer =
      Boolean(runCtx.standaloneReview) ||
      (this.settings?.reviewMode ?? "reviewer") === "reviewer";
    const seq = ++session.runSeq;
    session.reviewProgress = isReviewer ? "Сбор фактов…" : null;
    this.setSessionState(session, "classifying");
    session.statusReason = null;
    this.addLog(
      session,
      "info",
      runCtx.standaloneReview
        ? "Ревью текущего ответа агента…"
        : isReviewer
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
        if (session.runSeq !== seq) return;
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
          if (session.runSeq !== seq) return;
          if (stRes?.code === 0) gitStatus = stRes.stdout.trim();
          if (logRes?.code === 0) gitLog = logRes.stdout.trim();

          if (isReviewer) {
            const [unstagedRes, stagedRes] = await Promise.all([
              exec("git", ["diff"], { cwd: runCtx.projectRoot, on: runCtx.on }).catch(() => null),
              exec("git", ["diff", "--cached"], { cwd: runCtx.projectRoot, on: runCtx.on }).catch(
                () => null,
              ),
            ]);
            if (session.runSeq !== seq) return;
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
              if (session.runSeq !== seq) return;
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
          if (session.runSeq !== seq) return;
        }

        const ciSummary =
          ci.state !== "none" && ci.state !== "error" ? ci.summary : "";
        if (ci.state !== "none" && ci.state !== "error") {
          session.ciInfo = ci;
        }

        const toolExecutor = isReviewer
          ? createReviewerToolExecutor({
              projectRoot: runCtx.projectRoot,
              terminal: runCtx.terminal,
              on: runCtx.on,
              epicFilePath: item?.epic?.filePath ?? null,
              execFn: exec,
              hcFn: hc,
              readTextFileFn: readTextFile,
            })
          : null;

        const onProgress = isReviewer
          ? (stepText) => {
              if (session.runSeq !== seq) return;
              session.reviewProgress = stepText;
              this.addLog(session, "info", `Ревьювер: ${stepText}`);
              cx.notify();
            }
          : null;

        const verdict = await classifySessionTurn(
          this.settings,
          {
            reviewMode: isReviewer ? "reviewer" : "auto",
            epic: item?.epic ?? null,
            task: item?.task ?? null,
            terminalTail,
            gitStatus,
            gitLog,
            gitDiff,
            ciSummary,
          },
          fetch,
          toolExecutor,
          onProgress,
          {
            waitOnError: true,
            sleepFn: (ms) => cx.sleep(ms),
            timeoutFn: (ms) => cx.sleep(ms),
            shouldAbort: () => session.runSeq !== seq,
            onRetry: ({ attempt, delayMs, reason }) => {
              if (session.runSeq !== seq) return;
              const sec = Math.max(1, Math.round(delayMs / 1000));
              session.reviewProgress = `Повтор #${attempt} (${sec}с)…`;
              session.statusReason = `Ожидание ответа модели (попытка ${attempt}): ${reason}`;
              this.addLog(
                session,
                "warn",
                `Запрос не прошёл (${reason}) — повтор #${attempt} через ${sec}с`,
              );
              cx.notify();
            },
          },
        );
        if (session.runSeq !== seq) return;

        session.reviewProgress = null;
        session.lastVerdict = verdict;
        this.addLog(session, "info", `Вердикт: ${verdict.verdict} — ${verdict.reason}`);
        if (Array.isArray(verdict.evidence) && verdict.evidence.length > 0) {
          this.addLog(session, "info", `Факты: ${verdict.evidence.slice(0, 3).join(" | ")}`);
        }

        if (verdict.verdict === "completed") {
          const ciAction = resolveCompletedCiAction(ci.state);
          if (ciAction === "wait_ci") {
            session.ciInfo = ci;
            this.enterWaitingCi(session, ci.summary || "CI ещё выполняется — ожидание завершения", cx);
            return;
          }
          if (ciAction === "fix_ci") {
            session.ciInfo = ci;
            await this.handleCiFailure(session, runCtx, item, ci, seq, cx);
            return;
          }
          if (runCtx.standaloneReview) {
            this.completeStandaloneReview(session, verdict.reason, cx);
            return;
          }
          await this.markDoneAndAdvance(session, seq, cx);
          return;
        }

        if (verdict.verdict === "needs_fix") {
          await this.handleReviewFailure(session, runCtx, item, verdict, seq, cx);
          return;
        }

        if (verdict.verdict === "waiting_ci") {
          session.ciInfo =
            ci.state !== "none"
              ? ci
              : {
                  state: "pending",
                  summary: verdict.reason || "Ожидание CI",
                  branch: ci.branch ?? null,
                };
          this.enterWaitingCi(session, verdict.reason || "Ожидание завершения CI", cx);
          return;
        }

        session.pausedFromState = "watching";
        this.setSessionState(session, "paused");
        session.statusReason =
          verdict.reason ||
          (verdict.verdict === "failed"
            ? "Агент завершился с ошибкой"
            : "Требуется участие пользователя");
        this.addLog(session, verdict.verdict === "failed" ? "error" : "warn", session.statusReason);
        notify({
          title:
            verdict.verdict === "failed"
              ? `Orca (${runCtx.terminal}): ошибка агента`
              : `Orca (${runCtx.terminal}): требуется ответ`,
          body: session.statusReason,
          level: verdict.verdict === "failed" ? "error" : "warning",
          action: { name: "pane.focus", args: { terminal: runCtx.terminal } },
        });
        playSound("blocked");
        cx.notify();
      } catch (err) {
        if (session.runSeq !== seq) return;
        session.reviewProgress = null;
        const msg = String(err?.message ?? err);
        this.failRun(session, `Ошибка классификации: ${msg}`, cx);
      }
    });
  }

  async handleReviewFailure(session, runCtx, item, verdict, seq, cx) {
    const maxRetries = this.settings?.maxReviewRetries ?? 3;
    const issues = Array.isArray(verdict?.issues) ? verdict.issues.filter(Boolean) : [];
    const summary = issues[0] || verdict?.reason || "Ревьювер отклонил выполнение";

    if (shouldRetryCi(session.reviewRetryCount, maxRetries)) {
      session.reviewRetryCount += 1;
      session.sendingPrompt = true;
      this.setSessionState(session, "advancing");
      session.statusReason = `Ревью: возврат на доработку (${summary})`;
      const maxLabel = maxRetries === 0 ? "∞" : String(maxRetries);
      this.addLog(
        session,
        "warn",
        `Ревью отклонено (попытка ${session.reviewRetryCount}/${maxLabel}): ${summary}`,
      );
      cx.notify();

      try {
        const fixPrompt = buildReviewFixPrompt(
          item?.epic ?? null,
          item?.task ?? null,
          verdict,
          session.reviewRetryCount,
          maxRetries,
        );
        const sendRes = await hc(["send", runCtx.terminal, fixPrompt]).catch((e) => ({
          code: 1,
          stderr: String(e),
        }));
        if (session.runSeq !== seq) return;

        if (sendRes.code !== 0) {
          session.sendingPrompt = false;
          this.failRun(
            session,
            `Не удалось отправить замечания ревью в ${runCtx.terminal}: ${sendRes.stderr || "ошибка hc send"}`,
            cx,
          );
          return;
        }

        session.sentAt = Date.now();
        session.lastAgentStatus = this.readTerminalAgentStatus(runCtx.terminal);
        session.sawWorkingSinceSend = session.lastAgentStatus === "working";
        session.idleSince = null;
        session.sendingPrompt = false;
        this.setSessionState(session, "watching");
        this.addLog(session, "info", `Отправлены замечания ревью (попытка ${session.reviewRetryCount})`);
        cx.notify();
      } finally {
        if (session.runSeq === seq) {
          session.sendingPrompt = false;
        }
      }
      return;
    }

    session.runSeq++;
    this.setSessionState(session, "error");
    session.statusReason = `Исчерпан лимит попыток ревью (${maxRetries}): ${summary}`;
    this.addLog(session, "error", session.statusReason);
    notify({
      title: `Orca (${runCtx.terminal}): ревью не пройдено`,
      body: session.statusReason,
      level: "error",
      action: { name: "pane.focus", args: { terminal: runCtx.terminal } },
    });
    playSound("blocked");
    cx.notify();
  }

  enterWaitingCi(session, reason, cx) {
    const pollMs = this.getCiPollMs();
    session.nextCiCheckAt = Date.now() + pollMs;
    session.statusReason = reason || null;
    this.setSessionState(session, "waiting_ci");
    this.addLog(
      session,
      "info",
      `Ожидание CI (следующая проверка через ${Math.round(pollMs / 60000)} мин)`,
    );
    cx.notify();
  }

  checkCiNow(cx) {
    const session = this.activeSession();
    if (session.state !== "waiting_ci" || session.ciChecking) return;
    this.runCiCheck(session, cx);
  }

  runCiCheck(session, cx) {
    if (!session || session.ciChecking) return;
    const runCtx = session.boundRun;
    const item = session.currentItem ?? null;
    if (!runCtx || (!item && !runCtx.standaloneReview)) return;

    if (!runCtx.projectRoot) {
      session.pausedFromState = "waiting_ci";
      session.runSeq++;
      this.setSessionState(session, "paused");
      session.statusReason = "Не определён корень проекта для проверки CI";
      this.addLog(session, "error", session.statusReason);
      notify({ title: `Orca (${runCtx.terminal}): ошибка CI`, body: session.statusReason, level: "warning" });
      playSound("blocked");
      cx.notify();
      return;
    }

    session.ciChecking = true;
    const seq = session.runSeq;
    session.nextCiCheckAt = null;
    this.addLog(session, "info", "Проверка статуса GitHub CI…");
    cx.notify();

    cx.spawn(async (cx) => {
      try {
        const ci = await checkGithubCiStatus(runCtx.projectRoot, runCtx.on, exec);
        if (session.runSeq !== seq) return;
        session.ciInfo = ci;

        if (ci.state === "success") {
          this.addLog(session, "success", ci.summary || "CI прошёл успешно");
          await this.markDoneAndAdvance(session, seq, cx);
          return;
        }

        if (ci.state === "pending") {
          session.nextCiCheckAt = Date.now() + this.getCiPollMs();
          session.statusReason = ci.summary || "CI ещё выполняется";
          this.addLog(
            session,
            "info",
            `${session.statusReason} — следующая проверка через ${this.settings.ciPollMinutes || 5} мин`,
          );
          return;
        }

        if (ci.state === "failure") {
          await this.handleCiFailure(session, runCtx, item, ci, seq, cx);
          return;
        }

        session.pausedFromState = "waiting_ci";
        session.runSeq++;
        this.setSessionState(session, "paused");
        session.statusReason = ci.summary || "Не удалось получить статус CI";
        this.addLog(session, "error", session.statusReason);
        notify({
          title: `Orca (${runCtx.terminal}): ошибка проверки CI`,
          body: session.statusReason,
          level: "warning",
        });
        playSound("blocked");
      } catch (err) {
        if (session.runSeq !== seq) return;
        session.pausedFromState = "waiting_ci";
        session.runSeq++;
        this.setSessionState(session, "paused");
        session.statusReason = `Ошибка проверки CI: ${String(err?.message ?? err)}`;
        this.addLog(session, "error", session.statusReason);
        notify({
          title: `Orca (${runCtx.terminal}): ошибка проверки CI`,
          body: session.statusReason,
          level: "error",
        });
        playSound("blocked");
      } finally {
        session.ciChecking = false;
        if (session.runSeq === seq) {
          session.sendingPrompt = false;
        }
        cx.notify();
      }
    });
  }

  async handleCiFailure(session, runCtx, item, ci, seq, cx) {
    const maxRetries = this.settings?.maxCiRetries ?? 3;
    if (shouldRetryCi(session.ciRetryCount, maxRetries)) {
      session.ciRetryCount += 1;
      session.sendingPrompt = true;
      this.setSessionState(session, "fixing_ci");
      session.statusReason = ci.summary || "CI упал — отправка логов агенту";
      const maxLabel = maxRetries === 0 ? "∞" : String(maxRetries);
      this.addLog(
        session,
        "warn",
        `CI упал (попытка ${session.ciRetryCount}/${maxLabel}): ${ci.summary}`,
      );
      cx.notify();

      try {
        const logTail = await fetchFailedCiLogs(
          runCtx.projectRoot,
          ci.failedRunId,
          runCtx.on,
          exec,
        );
        if (session.runSeq !== seq) return;

        const fixPrompt = buildCiFixPrompt(
          item?.epic ?? null,
          item?.task ?? null,
          ci,
          logTail,
          session.ciRetryCount,
          maxRetries,
        );
        const sendRes = await hc(["send", runCtx.terminal, fixPrompt]).catch((e) => ({
          code: 1,
          stderr: String(e),
        }));
        if (session.runSeq !== seq) return;

        if (sendRes.code !== 0) {
          session.sendingPrompt = false;
          this.failRun(
            session,
            `Не удалось отправить фикс CI в ${runCtx.terminal}: ${sendRes.stderr || "ошибка hc send"}`,
            cx,
          );
          return;
        }

        session.sentAt = Date.now();
        session.lastAgentStatus = this.readTerminalAgentStatus(runCtx.terminal);
        session.sawWorkingSinceSend = session.lastAgentStatus === "working";
        session.idleSince = null;
        session.sendingPrompt = false;
        this.setSessionState(session, "watching");
        this.addLog(session, "info", `Отправлен промпт фикса CI (попытка ${session.ciRetryCount})`);
        cx.notify();
      } finally {
        if (session.runSeq === seq) {
          session.sendingPrompt = false;
        }
      }
      return;
    }

    session.runSeq++;
    this.setSessionState(session, "error");
    session.statusReason = `Исчерпан лимит попыток фикса CI (${maxRetries}): ${ci.summary}`;
    this.addLog(session, "error", session.statusReason);
    notify({
      title: `Orca (${runCtx.terminal}): CI не исправлен`,
      body: session.statusReason,
      level: "error",
      action: { name: "pane.focus", args: { terminal: runCtx.terminal } },
    });
    playSound("blocked");
    cx.notify();
  }

  withFileLock(filePath, fn) {
    const prev = this.fileWriteLocks.get(filePath) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const settled = next.catch(() => {});
    this.fileWriteLocks.set(filePath, settled);
    return next;
  }

  async markItemStatusOnDisk(item, status, on) {
    const epic = item.epic;
    const task = item.task;
    return this.withFileLock(epic.filePath, async () => {
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
    });
  }

  async markItemDoneOnDisk(item, on) {
    return this.markItemStatusOnDisk(item, "done", on);
  }

  async markDoneAndAdvance(session, seq, cx) {
    const runCtx = session?.boundRun;
    const item = session?.currentItem ?? null;
    if (!runCtx) return;
    if (runCtx.standaloneReview) {
      this.completeStandaloneReview(session, session.ciInfo?.summary || "CI прошёл успешно", cx);
      return;
    }
    if (!item) return;

    this.setSessionState(session, "advancing");
    cx.notify();

    const doneLabel = item.task ? `${item.epic.id} · ${item.task.id}` : item.epic.id;
    await this.markItemDoneOnDisk(item, runCtx.on);
    if (session.runSeq !== seq) return;

    this.addLog(session, "success", `Отмечено выполненным: ${doneLabel}`);

    await this.reloadEpicsForSession(session, runCtx.backlogDir, runCtx.on);
    if (session.runSeq !== seq) return;

    session.ciRetryCount = 0;
    session.reviewRetryCount = 0;
    session.reviewProgress = null;
    session.ciInfo = null;
    session.nextCiCheckAt = null;
    session.lastVerdict = null;
    session.statusReason = null;

    const next = this.pickNextAvailableItem(session);
    if (!next) {
      this.completeBacklog(session, cx);
      return;
    }

    session.currentItem = next;
    const nextLabel = next.task ? `${next.epic.id} · ${next.task.id}` : next.epic.id;
    session.sendingPrompt = true;
    try {
      if (shouldRunAutoCompact(this.settings?.autoCompact, next)) {
        session.statusReason = "Компакт сессии (/compact)…";
        this.addLog(session, "info", `Автокомпакт: отправка /compact в ${runCtx.terminal}…`);
        cx.notify();

        const compactRes = await hc(["send", runCtx.terminal, "/compact"]).catch((e) => ({
          code: 1,
          stderr: String(e),
        }));
        if (session.runSeq !== seq) return;

        if (compactRes.code !== 0) {
          this.failRun(
            session,
            `Не удалось отправить /compact в ${runCtx.terminal}: ${compactRes.stderr || "ошибка hc send"}`,
            cx,
          );
          return;
        }

        let sawCompactWorking = false;
        for (let i = 0; i < 10; i++) {
          await cx.sleep(300);
          if (session.runSeq !== seq) return;
          if (this.readTerminalAgentStatus(runCtx.terminal) === "working") {
            sawCompactWorking = true;
            break;
          }
        }

        if (sawCompactWorking) {
          await hc(["wait", runCtx.terminal, "--timeout", "120", "--json"]).catch(() => null);
          if (session.runSeq !== seq) return;
        } else {
          await cx.sleep(1000);
          if (session.runSeq !== seq) return;
        }

        session.statusReason = null;
        this.addLog(session, "info", "Автокомпакт завершён");
      }

      await this.markItemStatusOnDisk(next, "in_progress", runCtx.on).catch(() => {});
      await this.reloadEpicsForSession(session, runCtx.backlogDir, runCtx.on).catch(() => {});
      if (session.runSeq !== seq) return;

      const activeNext = session.currentItem ?? next;
      const prompt = buildAgentPrompt(activeNext.epic, activeNext.task, runCtx.projectRoot);
      const sendRes = await hc(["send", runCtx.terminal, prompt]).catch((e) => ({
        code: 1,
        stderr: String(e),
      }));
      if (session.runSeq !== seq) return;

      if (sendRes.code !== 0) {
        this.failRun(
          session,
          `Не удалось отправить следующую задачу в ${runCtx.terminal}: ${sendRes.stderr || "ошибка hc send"}`,
          cx,
        );
        return;
      }

      session.sentAt = Date.now();
      session.lastAgentStatus = this.readTerminalAgentStatus(runCtx.terminal);
      session.sawWorkingSinceSend = session.lastAgentStatus === "working";
      session.idleSince = null;
      this.setSessionState(session, "watching");
      this.addLog(session, "info", `Запущена следующая задача: ${nextLabel}`);
      cx.notify();
    } finally {
      if (session.runSeq === seq) {
        session.sendingPrompt = false;
      }
    }
  }

  completeStandaloneReview(session, reason, cx) {
    if (!session) return;
    const terminal = session.boundRun?.terminal ?? session.terminal;
    session.runSeq++;
    session.sendingPrompt = false;
    session.boundRun = null;
    session.currentItem = null;
    session.ciRetryCount = 0;
    session.reviewRetryCount = 0;
    session.reviewProgress = null;
    session.ciInfo = null;
    session.nextCiCheckAt = null;
    session.statusReason = reason || "Ревью пройдено";
    session.pausedFromState = null;
    session.sentAt = 0;
    session.sawWorkingSinceSend = false;
    session.idleSince = null;
    session.lastAgentStatus = null;
    this.setSessionState(session, "idle");
    this.syncWatches(cx);
    this.addLog(session, "success", `Ревью пройдено: ${session.statusReason}`);
    notify({
      title: `Orca (${terminal}): ревью пройдено`,
      body: session.statusReason,
      level: "success",
      ...(terminal ? { action: { name: "pane.focus", args: { terminal } } } : {}),
    });
    playSound("done");
    cx.notify();
  }

  completeBacklog(session, cx) {
    if (!session) return;
    session.runSeq++;
    session.sendingPrompt = false;
    session.boundRun = null;
    session.currentItem = null;
    session.skippedKeys.clear();
    session.ciRetryCount = 0;
    session.reviewRetryCount = 0;
    session.reviewProgress = null;
    session.ciInfo = null;
    session.nextCiCheckAt = null;
    session.lastVerdict = null;
    session.statusReason = null;
    session.pausedFromState = null;
    session.sentAt = 0;
    session.sawWorkingSinceSend = false;
    session.idleSince = null;
    session.lastAgentStatus = null;
    this.setSessionState(session, "idle");
    this.syncWatches(cx);
    this.addLog(session, "success", "Весь бэклог выполнен!");
    notify({
      title: `Orca (${session.terminal}): бэклог выполнен`,
      body: "Все открытые задачи завершены",
      level: "success",
      ...(session.terminal
        ? { action: { name: "pane.focus", args: { terminal: session.terminal } } }
        : {}),
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
      } else if (this.modelPickerOpen) {
        this.modelPickerOpen = false;
        cx.stop_propagation();
        cx.notify();
      } else if (this.settingsOpen) {
        this.toggleSettings(cx);
        cx.stop_propagation();
      }
    }
  }

  render(cx) {
    if (!checking()) {
      const prevSelected = this.selectedTerminal;
      this.syncSelectedTerminalWithFocus();
      const session = this.activeSession();
      if (session.terminal) {
        const ctx = this.resolveSessionContext(session);
        if (
          prevSelected !== this.selectedTerminal ||
          (session.state === "idle" && ctx.key !== session.contextKey)
        ) {
          this.refreshSession(session, cx, true);
        }
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
