import { describe, expect, test } from "bun:test";
import { parseEpicFile, listQueueItems, pickNextQueueItem } from "../mods/orca/parser.js";

describe("orca queue selection", () => {
  const epic1 = parseEpicFile(
    "001-auth.md",
    "# EPIC-001 — Auth\n\n**Status:** [-] IN PROGRESS\n\n**Priority:** P1\n\n## Задачи\n\n- [x] TASK-001.1 Done\n- [ ] TASK-001.2 Login\n- [!] TASK-001.3 Blocked\n",
    "C:/repo/backlog/001-auth.md",
  );
  const epic2 = parseEpicFile(
    "002-hotfix.md",
    "# EPIC-002 — Hotfix\n\n**Status:** [ ] TODO\n\n**Priority:** P0\n\n## Задачи\n\n- [ ] TASK-002.1 Fix crash\n",
    "C:/repo/backlog/002-hotfix.md",
  );
  const epic3 = parseEpicFile(
    "003-done.md",
    "# EPIC-003 — Done\n\n**Status:** [x] DONE\n\n**Priority:** P0\n\n## Задачи\n\n- [x] TASK-003.1 Shipped\n",
    "C:/repo/backlog/003-done.md",
  );

  test("listQueueItems sorts by priority P0..P3 then epic number and skips done/blocked", () => {
    const items = listQueueItems([epic1, epic2, epic3], "tasks");
    expect(items.map((i) => i.task.id)).toEqual(["TASK-002.1", "TASK-001.2"]);
  });

  test("pickNextQueueItem respects scopeEpicFile and epics mode", () => {
    expect(pickNextQueueItem([epic1, epic2, epic3], "tasks", epic1.filePath)?.task.id).toBe("TASK-001.2");
    expect(pickNextQueueItem([epic1, epic2, epic3], "epics")?.epic.id).toBe("EPIC-002");
    expect(pickNextQueueItem([epic3], "epics")).toBeNull();
  });

  test("prefers in_progress tasks before todo tasks within the same epic", () => {
    const epicMixed = parseEpicFile(
      "004-mixed.md",
      "# EPIC-004 — Mixed\n\n**Status:** [-] IN PROGRESS\n\n**Priority:** P1\n\n## Задачи\n\n- [ ] TASK-004.1 First todo\n- [-] TASK-004.2 Active task\n- [ ] TASK-004.3 Second todo\n",
      "C:/repo/backlog/004-mixed.md",
    );
    const items = listQueueItems([epicMixed], "tasks");
    expect(items.map((i) => i.task.id)).toEqual(["TASK-004.2", "TASK-004.1", "TASK-004.3"]);
  });

  test("skips blocked epics even if they contain todo tasks, and orders unprioritized epics last", () => {
    const blockedEpic = parseEpicFile(
      "005-blocked.md",
      "# EPIC-005 — Blocked\n\n**Status:** [!] BLOCKED\n\n**Priority:** P0\n\n## Задачи\n\n- [ ] TASK-005.1 Waiting\n",
      "C:/repo/backlog/005-blocked.md",
    );
    const noPriorityEpic = parseEpicFile(
      "006-noprio.md",
      "# EPIC-006 — No Priority\n\n**Status:** [ ] TODO\n\n## Задачи\n\n- [ ] TASK-006.1 Later\n",
      "C:/repo/backlog/006-noprio.md",
    );
    const items = listQueueItems([noPriorityEpic, blockedEpic, epic1], "tasks");
    expect(items.map((i) => i.task.id)).toEqual(["TASK-001.2", "TASK-006.1"]);
  });

  test("handles empty or null epics list and scopeEpicFile with no match", () => {
    expect(listQueueItems([], "tasks")).toEqual([]);
    expect(listQueueItems(null, "tasks")).toEqual([]);
    expect(pickNextQueueItem([], "tasks")).toBeNull();
    expect(pickNextQueueItem([epic1, epic2], "tasks", "C:/repo/backlog/missing.md")).toBeNull();
  });
});
