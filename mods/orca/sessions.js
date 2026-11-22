// Pure per-agent Orca session state helpers.
// Zero Herdr host/UI imports and zero Node APIs so it runs in both Herdr and bun test.

export const ORCA_ACTIVE_STATES = new Set([
  "watching",
  "classifying",
  "waiting_ci",
  "fixing_ci",
  "advancing",
]);

export const ORCA_SPINNING_STATES = new Set([
  "watching",
  "classifying",
  "fixing_ci",
  "advancing",
]);

export function createSessionState(terminal, defaults = {}) {
  return {
    terminal,
    spaceId: defaults.spaceId ?? null,
    on: defaults.on ?? null,
    readOnly: Boolean(defaults.on),
    state: "idle",
    pausedFromState: null,
    statusReason: null,
    lastVerdict: null,
    backlogDir: null,
    projectRoot: null,
    overrideFolder: null,
    contextKey: null,
    loading: false,
    epics: [],
    mode: defaults.mode === "epics" ? "epics" : "tasks",
    currentItem: null,
    skippedKeys: new Set(),
    ciRetryCount: 0,
    reviewRetryCount: 0,
    reviewProgress: null,
    ciInfo: null,
    nextCiCheckAt: null,
    ciChecking: false,
    runSeq: 0,
    sendingPrompt: false,
    sentAt: 0,
    sawWorkingSinceSend: false,
    idleSince: null,
    lastAgentStatus: null,
    boundRun: null,
    logs: [],
  };
}

export function getOrCreateSession(sessionsMap, terminal, defaults = {}) {
  if (!terminal) return null;
  let session = sessionsMap.get(terminal);
  if (!session) {
    session = createSessionState(terminal, defaults);
    sessionsMap.set(terminal, session);
  }
  return session;
}

export function getSessionOrcaState(orcaUi, address) {
  if (!orcaUi || !address) return null;
  if (orcaUi.sessions && typeof orcaUi.sessions === "object") {
    return orcaUi.sessions[address] ?? null;
  }
  if (orcaUi.terminal === address) {
    return orcaUi;
  }
  return null;
}

export function summarizeOrcaUi(orcaUi) {
  if (!orcaUi || typeof orcaUi !== "object") {
    return {
      activeCount: 0,
      waitingCiCount: 0,
      alertCount: 0,
      spinning: false,
      waitingCi: false,
      alert: false,
    };
  }

  const entries =
    orcaUi.sessions && typeof orcaUi.sessions === "object"
      ? Object.values(orcaUi.sessions)
      : orcaUi.state
        ? [orcaUi]
        : [];

  let activeCount = 0;
  let waitingCiCount = 0;
  let alertCount = 0;
  let spinning = false;

  for (const entry of entries) {
    const st = entry?.state;
    if (!st || st === "idle") continue;
    if (ORCA_ACTIVE_STATES.has(st)) activeCount += 1;
    if (ORCA_SPINNING_STATES.has(st)) spinning = true;
    if (st === "waiting_ci") waitingCiCount += 1;
    if (st === "paused" || st === "error") alertCount += 1;
  }

  return {
    activeCount,
    waitingCiCount,
    alertCount,
    spinning,
    waitingCi: waitingCiCount > 0,
    alert: alertCount > 0,
  };
}

export function buildOrcaUiSnapshot(sessionsMap, selectedTerminal, settings, statusLabelFn) {
  const maxCiRetries = settings?.maxCiRetries ?? 3;
  const reviewMode = settings?.reviewMode ?? "reviewer";
  const sessions = {};
  let activeCount = 0;
  let waitingCiCount = 0;
  let alertCount = 0;

  for (const [addr, s] of sessionsMap.entries()) {
    if (!s || s.state === "idle") continue;
    const currentLabel = s.currentItem
      ? s.currentItem.task
        ? `${s.currentItem.epic?.id ?? ""} · ${s.currentItem.task.id}`
        : s.currentItem.epic?.id ?? null
      : null;
    const label = typeof statusLabelFn === "function" ? statusLabelFn(s.state) : s.state;
    sessions[addr] = {
      state: s.state,
      label,
      spaceId: s.boundRun?.spaceId ?? s.spaceId ?? null,
      terminal: addr,
      ciRetryCount: s.ciRetryCount ?? 0,
      maxCiRetries,
      reviewMode,
      currentLabel,
    };
    if (ORCA_ACTIVE_STATES.has(s.state)) activeCount += 1;
    if (s.state === "waiting_ci") waitingCiCount += 1;
    if (s.state === "paused" || s.state === "error") alertCount += 1;
  }

  const selected = selectedTerminal ? sessionsMap.get(selectedTerminal) ?? null : null;
  const selectedState = selected?.state ?? "idle";
  const selectedLabel =
    typeof statusLabelFn === "function" ? statusLabelFn(selectedState) : selectedState;

  return {
    state: selectedState,
    label: selectedLabel,
    spaceId: selected?.boundRun?.spaceId ?? selected?.spaceId ?? null,
    terminal: selectedTerminal ?? null,
    ciRetryCount: selected?.ciRetryCount ?? 0,
    maxCiRetries,
    reviewMode,
    activeCount,
    waitingCiCount,
    alertCount,
    sessions,
  };
}
