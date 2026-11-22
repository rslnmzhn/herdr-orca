import { describe, expect, test } from "bun:test";
import {
  resolveStartAction,
  resolveCompletedCiAction,
  shouldRunAutoCompact,
} from "../mods/orca/guards.js";

describe("resolveStartAction", () => {
  test("blocks start when selected session is blocked", () => {
    expect(resolveStartAction("blocked")).toBe("block");
  });

  test("attaches without sending prompt when selected session is already working", () => {
    expect(resolveStartAction("working")).toBe("attach");
  });

  test("dispatches prompt when selected session is idle, done, or unknown", () => {
    expect(resolveStartAction("idle")).toBe("dispatch");
    expect(resolveStartAction("done")).toBe("dispatch");
    expect(resolveStartAction(null)).toBe("dispatch");
    expect(resolveStartAction(undefined)).toBe("dispatch");
  });
});

describe("resolveCompletedCiAction", () => {
  test("waits for CI when CI state is pending", () => {
    expect(resolveCompletedCiAction("pending")).toBe("wait_ci");
  });

  test("triggers CI failure handling when CI state is failure", () => {
    expect(resolveCompletedCiAction("failure")).toBe("fix_ci");
  });

  test("marks item done when CI state is success, none, error, or absent", () => {
    expect(resolveCompletedCiAction("success")).toBe("mark_done");
    expect(resolveCompletedCiAction("none")).toBe("mark_done");
    expect(resolveCompletedCiAction("error")).toBe("mark_done");
    expect(resolveCompletedCiAction(null)).toBe("mark_done");
    expect(resolveCompletedCiAction(undefined)).toBe("mark_done");
  });
});

describe("shouldRunAutoCompact", () => {
  test("runs /compact only when autoCompact is enabled and a next item exists", () => {
    expect(shouldRunAutoCompact(true, true)).toBe(true);
    expect(shouldRunAutoCompact(true, false)).toBe(false);
    expect(shouldRunAutoCompact(false, true)).toBe(false);
    expect(shouldRunAutoCompact(undefined, true)).toBe(false);
  });
});
