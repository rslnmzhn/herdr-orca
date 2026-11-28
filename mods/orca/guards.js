// Pure state-machine guard helpers for Orca.
// Zero Herdr host/UI imports and zero Node APIs so it runs in both Herdr and bun test.

export function resolveStartAction(agentStatus) {
  if (agentStatus === "blocked") return "block";
  if (agentStatus === "working") return "attach";
  return "dispatch";
}

export function resolveCompletedCiAction(ciState) {
  if (ciState === "pending") return "wait_ci";
  if (ciState === "failure") return "fix_ci";
  return "mark_done";
}

export function shouldRunAutoCompact(autoCompact, hasNextItem) {
  return Boolean(autoCompact) && Boolean(hasNextItem);
}

export function shouldAutoResumePaused(autoResumeMode, agentStatus) {
  if (autoResumeMode === "blocked") {
    return agentStatus === "working" || agentStatus === "done";
  }
  if (autoResumeMode === "needs_user") {
    return agentStatus === "working";
  }
  return false;
}
