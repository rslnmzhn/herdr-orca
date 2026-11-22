import { describe, expect, test } from "bun:test";
import {
  ORCA_ACTIVE_STATES,
  createSessionState,
  getOrCreateSession,
  getSessionOrcaState,
  summarizeOrcaUi,
  buildOrcaUiSnapshot,
} from "../mods/orca/sessions.js";

describe("orca multi-session state helpers", () => {
  test("createSessionState initializes isolated per-terminal state", () => {
    const s1 = createSessionState("t1", { spaceId: "sp1", mode: "epics" });
    const s2 = createSessionState("t2", { spaceId: "sp2", on: "vps" });

    expect(s1.terminal).toBe("t1");
    expect(s1.spaceId).toBe("sp1");
    expect(s1.mode).toBe("epics");
    expect(s1.state).toBe("idle");
    expect(s1.readOnly).toBe(false);

    expect(s2.terminal).toBe("t2");
    expect(s2.on).toBe("vps");
    expect(s2.readOnly).toBe(true);
    expect(s2.mode).toBe("tasks");

    s1.skippedKeys.add("a");
    s1.logs.push({ time: 1, level: "info", text: "hi" });
    expect(s2.skippedKeys.size).toBe(0);
    expect(s2.logs).toEqual([]);
  });

  test("getOrCreateSession reuses existing session and isolates multiple agents", () => {
    const map = new Map();
    const a = getOrCreateSession(map, "t1", { spaceId: "sp1" });
    a.state = "watching";
    a.runSeq = 4;

    const b = getOrCreateSession(map, "t2", { spaceId: "sp2" });
    expect(b.state).toBe("idle");
    expect(b.runSeq).toBe(0);

    const aAgain = getOrCreateSession(map, "t1");
    expect(aAgain).toBe(a);
    expect(aAgain.state).toBe("watching");
    expect(aAgain.runSeq).toBe(4);
  });

  test("buildOrcaUiSnapshot publishes per-agent sessions and aggregate counts", () => {
    const map = new Map();
    const s1 = getOrCreateSession(map, "t1", { spaceId: "sp1" });
    s1.state = "watching";
    s1.currentItem = { epic: { id: "EPIC-001" }, task: { id: "TASK-001.1" } };

    const s2 = getOrCreateSession(map, "t2", { spaceId: "sp2" });
    s2.state = "waiting_ci";
    s2.ciRetryCount = 1;
    s2.currentItem = { epic: { id: "EPIC-002" }, task: null };

    const s3 = getOrCreateSession(map, "t3", { spaceId: "sp3" });
    s3.state = "paused";

    const s4 = getOrCreateSession(map, "t4", { spaceId: "sp4" });
    s4.state = "idle";

    const snap = buildOrcaUiSnapshot(
      map,
      "t1",
      { maxCiRetries: 3, reviewMode: "reviewer" },
      (st) => st.toUpperCase(),
    );

    expect(snap.terminal).toBe("t1");
    expect(snap.state).toBe("watching");
    expect(snap.activeCount).toBe(2);
    expect(snap.waitingCiCount).toBe(1);
    expect(snap.alertCount).toBe(1);

    expect(Object.keys(snap.sessions).sort()).toEqual(["t1", "t2", "t3"]);
    expect(snap.sessions.t1.currentLabel).toBe("EPIC-001 · TASK-001.1");
    expect(snap.sessions.t2.state).toBe("waiting_ci");
    expect(snap.sessions.t2.ciRetryCount).toBe(1);
    expect(snap.sessions.t3.state).toBe("paused");
    expect(snap.sessions.t4).toBeUndefined();
  });

  test("getSessionOrcaState resolves per-agent state and falls back to legacy single-session shape", () => {
    const multi = {
      terminal: "t1",
      state: "watching",
      sessions: {
        t1: { terminal: "t1", state: "watching" },
        t2: { terminal: "t2", state: "classifying" },
      },
    };
    expect(getSessionOrcaState(multi, "t1")?.state).toBe("watching");
    expect(getSessionOrcaState(multi, "t2")?.state).toBe("classifying");
    expect(getSessionOrcaState(multi, "t9")).toBeNull();

    const legacy = { terminal: "t5", state: "waiting_ci" };
    expect(getSessionOrcaState(legacy, "t5")?.state).toBe("waiting_ci");
    expect(getSessionOrcaState(legacy, "t1")).toBeNull();
  });

  test("summarizeOrcaUi aggregates spinning, waitingCi, and alert across all sessions", () => {
    const summary = summarizeOrcaUi({
      state: "idle",
      activeCount: 2,
      waitingCiCount: 1,
      alertCount: 1,
      sessions: {
        t1: { state: "classifying" },
        t2: { state: "waiting_ci" },
        t3: { state: "error" },
      },
    });
    expect(summary.activeCount).toBe(2);
    expect(summary.spinning).toBe(true);
    expect(summary.waitingCi).toBe(true);
    expect(summary.alert).toBe(true);
    expect(ORCA_ACTIVE_STATES.has("classifying")).toBe(true);
  });
});
