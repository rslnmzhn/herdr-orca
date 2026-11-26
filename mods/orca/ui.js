import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, Scrollbar } from "gpui-base";
import { COLUMNS } from "./parser.js";
import {
  BLOCKING_REVIEW_CHECKS,
  OPTIONAL_REVIEW_CHECKS,
  getMaxOptionalReviewScore,
  normalizeOptionalReviewChecks,
} from "./classifier.js";

const COLUMN_LABELS = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));

export function alpha(hex, aa) {
  if (typeof hex !== "string" || !hex.startsWith("#")) return hex;
  const base = hex.length === 9 ? hex.slice(0, 7) : hex;
  return base.length === 7 ? `${base}${aa}` : hex;
}

export function statusMeta(t, state) {
  switch (state) {
    case "watching":
      return {
        label: "Наблюдение",
        color: t.working ?? t.accent,
        icon: "spinner",
        spinning: true,
        pulsing: false,
      };
    case "classifying":
      return {
        label: "Классификация",
        color: t.ansi5 ?? t.accent,
        icon: "spinner",
        spinning: true,
        pulsing: false,
      };
    case "waiting_ci":
      return {
        label: "Ожидание CI",
        color: t.ansi3 ?? t.working ?? t.accent,
        icon: "clock",
        spinning: false,
        pulsing: true,
      };
    case "fixing_ci":
      return {
        label: "Фикс CI",
        color: t.working ?? t.ansi3 ?? t.accent,
        icon: "spinner",
        spinning: true,
        pulsing: false,
      };
    case "advancing":
      return {
        label: "Следующая задача",
        color: t.done ?? t.ansi2,
        icon: "spinner",
        spinning: true,
        pulsing: false,
      };
    case "paused":
      return {
        label: "Пауза",
        color: t.ansi3 ?? t.muted,
        icon: "pause",
        spinning: false,
        pulsing: false,
      };
    case "error":
      return {
        label: "Ошибка",
        color: t.blocked ?? t.ansi1,
        icon: "blocked",
        spinning: false,
        pulsing: false,
      };
    case "idle":
    default:
      return {
        label: "Ожидание",
        color: t.muted ?? t.dim,
        icon: "orca",
        spinning: false,
        pulsing: false,
      };
  }
}

function priorityColor(t, priority) {
  switch (priority) {
    case "P0":
      return t.blocked ?? t.ansi1;
    case "P1":
      return t.working ?? t.ansi3;
    case "P2":
      return t.accent ?? t.ansi4;
    case "P3":
      return t.dim ?? t.muted;
    default:
      return t.dim ?? t.muted;
  }
}

function sessionStatusColor(t, status) {
  switch (status) {
    case "working":
      return t.working ?? t.accent;
    case "blocked":
      return t.blocked ?? t.ansi1;
    case "done":
      return t.done ?? t.ansi2;
    default:
      return t.muted ?? t.dim;
  }
}

function badge(text, fg, bg, border = null) {
  return h_flex()
    .flex_none()
    .h(18)
    .px(6)
    .items_center()
    .rounded(5)
    .bg(bg)
    .when(Boolean(border), (el) => el.border_1().border_color(border))
    .text_size(10.5)
    .font_semibold()
    .text_color(fg)
    .child(text);
}

function iconButton(id, iconName, tip, onClick, t, opts = {}) {
  const size = opts.size ?? 24;
  const iconSize = opts.iconSize ?? 13;
  const fg = opts.color ?? t.muted;
  return div()
    .id(id)
    .size(size)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(6)
    .text_color(fg)
    .cursor_pointer()
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .child(
      svg(`mods/orca/icons/${iconName}.svg`)
        .size(iconSize)
        .when(Boolean(opts.spin), (el) => el.spin(opts.spin)),
    );
}

function pillButton(id, label, active, onClick, t, opts = {}) {
  const disabled = Boolean(opts.disabled);
  const fg = disabled ? (opts.fg ?? t.dim) : active ? (opts.activeFg ?? t.foreground) : (opts.fg ?? t.muted);
  const bg = active ? (opts.activeBg ?? t.selected) : (opts.bg ?? t.chrome);
  const border = active ? (opts.activeBorder ?? t.border) : (opts.border ?? t.border);
  return h_flex()
    .id(id)
    .h(opts.height ?? 26)
    .px(opts.px ?? 9)
    .gap(5)
    .flex_none()
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(border)
    .bg(bg)
    .text_size(opts.textSize ?? 11.5)
    .when(active, (el) => el.font_medium())
    .text_color(fg)
    .when(disabled, (el) => el.opacity(0.5))
    .when(!disabled, (el) =>
      el
        .cursor_pointer()
        .hover((s) => s.bg(active ? bg : t.hover).text_color(t.foreground))
        .on_click((e, cx) => {
          cx.stop_propagation();
          onClick(e, cx);
        }),
    )
    .when(Boolean(opts.tip), (el) => el.tooltip(opts.tip))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .when(Boolean(opts.icon), (el) =>
      el.child(
        svg(`mods/orca/icons/${opts.icon}.svg`)
          .size(opts.iconSize ?? 12)
          .flex_none()
          .when(Boolean(opts.spin), (s) => s.spin(opts.spin)),
      ),
    )
    .child(label);
}

function solidButton(id, label, iconName, onClick, t, opts = {}) {
  return h_flex()
    .id(id)
    .h(opts.height ?? 26)
    .px(opts.px ?? 10)
    .gap(5)
    .flex_none()
    .items_center()
    .rounded(6)
    .bg(opts.bg ?? t.solid)
    .text_size(opts.textSize ?? 11.5)
    .font_medium()
    .text_color(opts.fg ?? t.solid_foreground)
    .cursor_pointer()
    .when(Boolean(opts.tip), (el) => el.tooltip(opts.tip))
    .hover((s) => s.opacity(0.88))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((e, cx) => {
      cx.stop_propagation();
      onClick(e, cx);
    })
    .when(Boolean(iconName), (el) => el.child(svg(`mods/orca/icons/${iconName}.svg`).size(12).flex_none()))
    .child(label);
}

function shortFolderLabel(dir) {
  if (!dir) return "Выбрать папку…";
  const parts = String(dir).replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/") || dir;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

function formatCountdown(nextCiCheckAt) {
  if (!nextCiCheckAt || typeof nextCiCheckAt !== "number") return "00:00";
  const diffSec = Math.max(0, Math.ceil((nextCiCheckAt - Date.now()) / 1000));
  const mins = Math.floor(diffSec / 60);
  const secs = diffSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatLogTime(time) {
  if (!time) return "";
  if (typeof time === "string") return time;
  const d = new Date(time);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function logLevelColor(t, level) {
  switch (level) {
    case "error":
      return t.blocked ?? t.ansi1;
    case "warn":
      return t.working ?? t.ansi3;
    case "success":
    case "done":
      return t.done ?? t.ansi2;
    default:
      return t.muted ?? t.dim;
  }
}

export function renderHeader(view, t) {
  const s = view.activeSession?.() ?? view;
  const meta = statusMeta(t, s.state);
  const isSpinning =
    s.state === "watching" ||
    s.state === "classifying" ||
    s.state === "advancing" ||
    s.state === "fixing_ci";
  const isWaitingCi = s.state === "waiting_ci";
  const isActive = isSpinning || isWaitingCi;
  const isPaused = s.state === "paused";
  const activeCount = view.getActiveSessions?.().filter((x) => x.isActive).length ?? (isActive ? 1 : 0);

  return h_flex()
    .id("orca-header")
    .flex_none()
    .flex_wrap()
    .px(12)
    .py(8)
    .gap(8)
    .items_center()
    .bg(t.chrome)
    .border_b(1)
    .border_color(t.border)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .child(
          svg("mods/orca/icons/orca.svg")
            .size(16)
            .flex_none()
            .text_color(isActive || activeCount > 0 ? meta.color : t.accent)
            .when(isActive || activeCount > 0, (el) => el.loop("opacity", { from: 0.55, to: 1, period: 1200 })),
        )
        .child(div().text_size(13.5).font_semibold().text_color(t.foreground).child("Orca"))
        .child(
          h_flex()
            .flex_none()
            .h(20)
            .px(7)
            .gap(5)
            .items_center()
            .rounded(5)
            .bg(alpha(meta.color, "20"))
            .border_1()
            .border_color(alpha(meta.color, "55"))
            .when(meta.spinning || meta.pulsing, (el) =>
              el.child(
                svg(`mods/orca/icons/${meta.icon}.svg`)
                  .size(11)
                  .flex_none()
                  .text_color(meta.color)
                  .when(meta.spinning, (sp) => sp.spin(1100))
                  .when(meta.pulsing, (sp) => sp.loop("opacity", { from: 0.35, to: 1, period: 1100 })),
              ),
            )
            .child(div().text_size(10.5).font_semibold().text_color(meta.color).child(meta.label)),
        )
        .when(activeCount > 1, (el) =>
          el.child(badge(`${activeCount} активн.`, t.accent, alpha(t.accent, "1e"))),
        ),
    )
    .child(div().flex_1())
    .child(
      h_flex()
        .flex_wrap()
        .gap(6)
        .items_center()
        .when(s.state === "idle" || s.state === "error", (el) =>
          el
            .child(
              pillButton("orca-btn-review-now", "Ревью", false, (_e, cx) => view.reviewCurrentTurn(cx), t, {
                icon: "eye",
                tip: "Проверить текущий ответ агента без бэклога",
              }),
            )
            .child(
              solidButton("orca-btn-start", "Старт", "play", (_e, cx) => view.start(cx), t, {
                tip: "Запустить цикл Orca для выбранного агента",
              }),
            ),
        )
        .when(isPaused, (el) =>
          el.child(
            solidButton("orca-btn-resume", "Продолжить", "play", (_e, cx) => view.resume(cx), t, {
              tip: "Возобновить цикл Orca для выбранного агента",
            }),
          ),
        )
        .when(isActive, (el) =>
          el.child(
            pillButton("orca-btn-pause", "Пауза", false, (_e, cx) => view.pause(cx), t, {
              icon: "pause",
              tip: "Поставить цикл на паузу",
            }),
          ),
        )
        .when(isActive || isPaused, (el) =>
          el
            .when(!s.boundRun?.standaloneReview, (b) =>
              b.child(
                pillButton("orca-btn-skip", "Пропустить", false, (_e, cx) => view.skipCurrent(cx), t, {
                  icon: "skip",
                  tip: "Пропустить текущую задачу и перейти к следующей",
                }),
              ),
            )
            .child(
              pillButton("orca-btn-stop", "Стоп", false, (_e, cx) => view.stop(cx), t, {
                icon: "x",
                fg: t.blocked ?? t.ansi1,
                border: alpha(t.blocked ?? t.ansi1, "55"),
                tip: "Остановить цикл Orca для выбранного агента",
              }),
            ),
        ),
    );
}

export function renderSessionAndBacklog(view, t) {
  const s = view.activeSession?.() ?? view;
  const choices = view.getSessionChoices?.() ?? [];
  const activeSessions = view.getActiveSessions?.() ?? [];
  const selected = choices.find((c) => c.address === view.selectedTerminal) ?? null;
  const selectedColor = selected ? sessionStatusColor(t, selected.status) : t.dim;
  const autoCompact = Boolean(view.settings?.autoCompact);

  return v_flex()
    .id("orca-session-backlog")
    .flex_none()
    .px(12)
    .py(8)
    .gap(8)
    .bg(t.surface)
    .border_b(1)
    .border_color(t.border)
    .when(activeSessions.length > 0, (el) =>
      el.child(
        h_flex()
          .id("orca-active-sessions")
          .flex_wrap()
          .gap(5)
          .items_center()
          .children(
            activeSessions.map((item, idx) => {
              const isCurrent = item.terminal === view.selectedTerminal;
              const meta = statusMeta(t, item.state);
              return h_flex()
                .id(`orca-active-sess-${idx}`)
                .h(22)
                .px(7)
                .gap(5)
                .flex_none()
                .items_center()
                .rounded(5)
                .border_1()
                .border_color(isCurrent ? meta.color : alpha(meta.color, "55"))
                .bg(isCurrent ? alpha(meta.color, "24") : t.background)
                .cursor_pointer()
                .tooltip(`${item.label} (${item.terminal}) — ${meta.label}`)
                .hover((st) => st.bg(alpha(meta.color, "20")))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => view.selectTerminal(item.terminal, cx))
                .when(meta.spinning, (sp) =>
                  sp.child(svg("mods/orca/icons/spinner.svg").size(10).flex_none().text_color(meta.color).spin(1100)),
                )
                .when(!meta.spinning, (sp) =>
                  sp.child(
                    div()
                      .size(6)
                      .rounded(3)
                      .flex_none()
                      .bg(meta.color)
                      .when(meta.pulsing, (p) => p.loop("opacity", { from: 0.35, to: 1, period: 1100 })),
                  ),
                )
                .child(
                  div()
                    .text_size(10.5)
                    .when(isCurrent, (st) => st.font_semibold())
                    .text_color(isCurrent ? t.foreground : t.muted)
                    .child(`${item.programName || item.terminal} · ${item.terminal}`),
                )
                .child(div().text_size(10).text_color(meta.color).child(meta.label));
            }),
          ),
      ),
    )
    .child(
      h_flex()
        .flex_wrap()
        .gap(6)
        .items_center()
        .child(
          h_flex()
            .id("orca-session-btn")
            .h(26)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(6)
            .border_1()
            .border_color(view.sessionPickerOpen ? t.accent : t.border)
            .bg(t.background)
            .text_size(11.5)
            .text_color(selected ? t.foreground : t.accent)
            .cursor_pointer()
            .tooltip(selected ? `${selected.label} (${selected.address})` : "Выбрать целевую сессию агента")
            .hover((st) => st.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => view.toggleSessionPicker(cx))
            .child(svg("mods/orca/icons/terminal.svg").size(12).flex_none().text_color(t.muted))
            .when(Boolean(selected), (el) =>
              el.child(div().size(6).rounded(3).flex_none().bg(selectedColor)),
            )
            .child(
              div()
                .max_w(190)
                .truncate()
                .child(selected ? `${selected.programName || selected.label} · ${selected.address}` : "Выбрать сессию…"),
            )
            .child(
              svg(`mods/orca/icons/${view.sessionPickerOpen ? "chevron-down" : "chevron-right"}.svg`)
                .size(11)
                .flex_none()
                .text_color(t.dim),
            ),
        )
        .child(
          h_flex()
            .id("orca-folder-btn")
            .h(26)
            .px(8)
            .gap(6)
            .items_center()
            .rounded(6)
            .border_1()
            .border_color(t.border)
            .bg(t.background)
            .text_size(11.5)
            .text_color(s.backlogDir ? t.muted : t.accent)
            .cursor_pointer()
            .tooltip(
              s.backlogDir
                ? `${s.on ? `[${s.on}] ` : ""}${s.backlogDir}`
                : "Выбрать папку backlog",
            )
            .hover((st) => st.bg(t.hover).text_color(t.foreground))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => view.chooseFolder(cx))
            .child(svg("mods/orca/icons/folder.svg").size(12).flex_none())
            .child(div().max_w(170).truncate().child(shortFolderLabel(s.backlogDir))),
        )
        .when(Boolean(s.on), (el) =>
          el.child(badge(s.on, t.accent, alpha(t.accent, "20"))),
        )
        .when(s.readOnly, (el) =>
          el.child(badge("Только чтение", t.working ?? t.ansi3, alpha(t.working ?? t.ansi3, "20"))),
        )
        .child(div().flex_1())
        .child(
          h_flex()
            .flex_wrap()
            .gap(4)
            .items_center()
            .child(
              pillButton(
                "orca-review-auto",
                "Авто",
                (view.settings?.reviewMode ?? "reviewer") === "auto",
                (_e, cx) => view.setReviewMode("auto", cx),
                t,
                {
                  height: 24,
                  px: 8,
                  textSize: 11,
                  tip: "Режим Авто: быстрая проверка завершения хода и отправка следующей задачи",
                },
              ),
            )
            .child(
              pillButton(
                "orca-review-reviewer",
                "Ревьювер",
                (view.settings?.reviewMode ?? "reviewer") === "reviewer",
                (_e, cx) => view.setReviewMode("reviewer", cx),
                t,
                {
                  height: 24,
                  px: 8,
                  textSize: 11,
                  activeFg: t.accent,
                  activeBg: alpha(t.accent, "20"),
                  activeBorder: alpha(t.accent, "66"),
                  tip: "Режим Ревьювер: проверяет diff, файлы и тесты через инструменты и возвращает на доработку при фальсификации",
                },
              ),
            )
            .child(div().w(1).h(14).mx(2).bg(t.border))
            .child(
              pillButton(
                "orca-mode-tasks",
                "Задачи",
                s.mode === "tasks",
                (_e, cx) => view.setMode("tasks", cx),
                t,
                { height: 24, px: 8, textSize: 11 },
              ),
            )
            .child(
              pillButton(
                "orca-mode-epics",
                "Эпики",
                s.mode === "epics",
                (_e, cx) => view.setMode("epics", cx),
                t,
                { height: 24, px: 8, textSize: 11 },
              ),
            )
            .child(
              iconButton(
                "orca-refresh-backlog",
                "refresh",
                "Обновить бэклог",
                (_e, cx) => view.refreshBacklog(cx),
                t,
                { size: 24, iconSize: 12 },
              ),
            )
            .child(
              h_flex()
                .id("orca-autocompact-chk")
                .h(24)
                .px(7)
                .gap(5)
                .flex_none()
                .items_center()
                .rounded(6)
                .border_1()
                .border_color(autoCompact ? alpha(t.accent, "66") : t.border)
                .bg(autoCompact ? alpha(t.accent, "18") : t.chrome)
                .cursor_pointer()
                .tooltip("После каждой выполненной задачи отправлять /compact перед следующей")
                .hover((st) => st.bg(t.hover))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => view.toggleAutoCompact(cx))
                .child(
                  h_flex()
                    .size(13)
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .rounded(3)
                    .border_1()
                    .border_color(autoCompact ? t.accent : t.input)
                    .bg(autoCompact ? t.accent : t.background)
                    .when(autoCompact, (el) =>
                      el.child(svg("mods/orca/icons/check.svg").size(9).text_color(t.solid_foreground)),
                    ),
                )
                .child(
                  div()
                    .text_size(11)
                    .when(autoCompact, (el) => el.font_medium())
                    .text_color(autoCompact ? t.foreground : t.muted)
                    .child("Автокомпакт"),
                ),
            ),
        ),
    )
    .when(view.sessionPickerOpen, (el) =>
      el.child(
        v_flex()
          .id("orca-session-list")
          .p(6)
          .gap(3)
          .rounded(8)
          .border_1()
          .border_color(t.border)
          .bg(t.background)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .when(choices.length === 0, (empty) =>
            empty.child(
              div()
                .px(8)
                .py(6)
                .text_size(11.5)
                .text_color(t.dim)
                .child("Нет доступных терминалов или агентов"),
            ),
          )
          .children(
            choices.map((choice, idx) => {
              const isSelected = choice.address === view.selectedTerminal;
              const dotColor = sessionStatusColor(t, choice.status);
              const orcaState = choice.orcaState;
              const orcaMeta = orcaState && orcaState !== "idle" ? statusMeta(t, orcaState) : null;
              return h_flex()
                .id(`orca-sess-opt-${idx}`)
                .h(28)
                .px(8)
                .gap(7)
                .items_center()
                .rounded(6)
                .bg(isSelected ? t.selected : t.background)
                .cursor_pointer()
                .hover((st) => st.bg(isSelected ? t.selected : t.hover))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => view.selectTerminal(choice.address, cx))
                .child(div().size(7).rounded(4).flex_none().bg(dotColor))
                .child(
                  div()
                    .flex_1()
                    .min_w(0)
                    .truncate()
                    .text_size(12)
                    .when(isSelected, (st) => st.font_medium())
                    .text_color(t.foreground)
                    .child(choice.label || choice.programName || choice.address),
                )
                .when(Boolean(orcaMeta), (b) =>
                  b.child(badge(orcaMeta.label, orcaMeta.color, alpha(orcaMeta.color, "20"))),
                )
                .when(choice.isAgent, (b) =>
                  b.child(badge("Агент", t.accent, alpha(t.accent, "1e"))),
                )
                .when(Boolean(choice.spaceName), (b) =>
                  b.child(badge(choice.spaceName, t.muted, t.raised)),
                )
                .child(div().text_size(11).text_color(t.dim).child(choice.address));
            }),
          ),
      ),
    );
}

function renderPipelineStage(id, label, stageState, t, opts = {}) {
  const isActive = stageState === "active";
  const isDone = stageState === "done";
  const fg = isActive ? (opts.color ?? t.accent) : isDone ? (t.done ?? t.ansi2) : t.dim;
  const bg = isActive
    ? alpha(opts.color ?? t.accent, "1c")
    : isDone
      ? alpha(t.done ?? t.ansi2, "14")
      : t.background;
  const border = isActive
    ? alpha(opts.color ?? t.accent, "66")
    : isDone
      ? alpha(t.done ?? t.ansi2, "44")
      : t.border;

  return h_flex()
    .id(id)
    .h(24)
    .px(8)
    .gap(5)
    .flex_none()
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(border)
    .bg(bg)
    .child(
      isActive && opts.spinning
        ? svg("mods/orca/icons/spinner.svg").size(11).flex_none().text_color(fg).spin(1100)
        : isDone
          ? svg("mods/orca/icons/check.svg").size(11).flex_none().text_color(fg)
          : div()
              .size(6)
              .rounded(3)
              .flex_none()
              .bg(fg)
              .when(isActive, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1100 })),
    )
    .child(
      div()
        .text_size(11)
        .when(isActive, (el) => el.font_semibold())
        .text_color(isActive || isDone ? t.foreground : t.muted)
        .child(label),
    )
    .when(isActive, (el) =>
      el.child(
        div()
          .w(14)
          .text_size(11)
          .font_semibold()
          .text_color(fg)
          .frames(["·", "··", "···"], 450),
      ),
    );
}

export function renderPipelineStrip(view, t) {
  const s = view.activeSession?.() ?? view;
  const state = s.state;
  const meta = statusMeta(t, state);

  let stage1 = "pending";
  let stage2 = "pending";
  let stage3 = "pending";

  if (state === "watching" || state === "fixing_ci") {
    stage1 = "active";
  } else if (state === "classifying") {
    stage1 = "done";
    stage2 = "active";
  } else if (state === "waiting_ci" || state === "advancing") {
    stage1 = "done";
    stage2 = "done";
    stage3 = "active";
  }

  const item = s.currentItem;
  const epic = item?.epic ?? null;
  const task = item?.task ?? null;
  const maxRetries = view.settings?.maxCiRetries ?? 3;
  const retryLimitLabel = maxRetries === 0 ? "∞" : String(maxRetries);
  const retryCount = s.ciRetryCount ?? 0;
  const isReviewerMode = (view.settings?.reviewMode ?? "reviewer") === "reviewer";
  const maxReviewRetries = view.settings?.maxReviewRetries ?? 3;
  const reviewLimitLabel = maxReviewRetries === 0 ? "∞" : String(maxReviewRetries);
  const reviewRetryCount = s.reviewRetryCount ?? 0;
  const showCiRow = state === "waiting_ci" || state === "fixing_ci" || Boolean(s.ciInfo);

  return v_flex()
    .id("orca-pipeline")
    .flex_none()
    .px(12)
    .py(9)
    .gap(8)
    .bg(t.background)
    .border_b(1)
    .border_color(t.border)
    .child(
      h_flex()
        .flex_wrap()
        .gap(6)
        .items_center()
        .child(
          renderPipelineStage("orca-stage-agent", "Агент", stage1, t, {
            color: meta.color,
            spinning: state === "watching" || state === "fixing_ci",
          }),
        )
        .child(svg("mods/orca/icons/chevron-right.svg").size(11).flex_none().text_color(t.dim))
        .child(
          renderPipelineStage(
            "orca-stage-classifier",
            isReviewerMode || s.boundRun?.standaloneReview ? "Ревьювер" : "Классификатор",
            stage2,
            t,
            {
              color: meta.color,
              spinning: state === "classifying",
            },
          ),
        )
        .child(svg("mods/orca/icons/chevron-right.svg").size(11).flex_none().text_color(t.dim))
        .child(
          renderPipelineStage("orca-stage-ci", "CI / Done", stage3, t, {
            color: meta.color,
            spinning: state === "advancing",
          }),
        )
        .when(state === "classifying" && Boolean(s.reviewProgress), (el) =>
          el.child(
            badge(
              s.reviewProgress,
              t.ansi5 ?? t.accent,
              alpha(t.ansi5 ?? t.accent, "1e"),
            ),
          ),
        )
        .when(reviewRetryCount > 0, (el) =>
          el.child(
            badge(
              `Ревью ${reviewRetryCount}/${reviewLimitLabel}`,
              t.working ?? t.ansi3,
              alpha(t.working ?? t.ansi3, "20"),
            ),
          ),
        )
        .when(Boolean(s.lastVerdict), (el) =>
          el.child(
            h_flex()
              .ml(4)
              .gap(5)
              .items_center()
              .child(
                badge(
                  String(s.lastVerdict.verdict || "").toUpperCase(),
                  s.lastVerdict.verdict === "needs_fix" ? (t.working ?? t.ansi3) : t.accent,
                  alpha(s.lastVerdict.verdict === "needs_fix" ? (t.working ?? t.ansi3) : t.accent, "1e"),
                ),
              )
              .when(Boolean(s.lastVerdict.review), (r) =>
                r.child(
                  badge(
                    s.lastVerdict.review.selectedMax > 0
                      ? `${s.lastVerdict.review.earned}/${s.lastVerdict.review.applicableMax} б.`
                      : "Блокеры",
                    s.lastVerdict.review.passed ? (t.done ?? t.ansi2) : (t.working ?? t.ansi3),
                    alpha(s.lastVerdict.review.passed ? (t.done ?? t.ansi2) : (t.working ?? t.ansi3), "1c"),
                  ),
                ),
              )
              .when(Boolean(s.lastVerdict.reason), (r) =>
                r.child(
                  div()
                    .max_w(220)
                    .truncate()
                    .text_size(11)
                    .text_color(t.muted)
                    .child(s.lastVerdict.reason),
                ),
              ),
          ),
        ),
    )
    .child(
      h_flex()
        .px(9)
        .py(7)
        .gap(7)
        .items_center()
        .rounded(7)
        .border_1()
        .border_color(item ? t.border : alpha(t.border, "88"))
        .bg(t.surface)
        .when(Boolean(item), (el) =>
          el
            .when(Boolean(epic?.priority), (b) =>
              b.child(
                badge(
                  epic.priority,
                  priorityColor(t, epic.priority),
                  alpha(priorityColor(t, epic.priority), "20"),
                ),
              ),
            )
            .child(
              div()
                .flex_none()
                .text_size(11.5)
                .font_semibold()
                .text_color(t.accent)
                .child(task ? task.id : epic.id),
            )
            .when(Boolean(task && epic?.id), (b) =>
              b.child(badge(epic.id, t.muted, t.raised)),
            )
            .child(
              div()
                .flex_1()
                .min_w(0)
                .truncate()
                .text_size(12)
                .font_medium()
                .text_color(t.foreground)
                .child(task ? task.title : epic.title),
            )
            .when(Boolean(task?.status && COLUMN_LABELS[task.status]), (b) =>
              b.child(badge(COLUMN_LABELS[task.status], t.muted, t.raised)),
            ),
        )
        .when(!item, (el) =>
          el.child(
            div()
              .text_size(11.5)
              .text_color(t.dim)
              .child(
                s.boundRun?.standaloneReview
                  ? "Ревью текущего ответа (без бэклога)"
                  : "Текущая задача не выбрана",
              ),
          ),
        ),
    )
    .when(showCiRow, (el) =>
      el.child(
        h_flex()
          .flex_wrap()
          .px(9)
          .py(6)
          .gap(8)
          .items_center()
          .rounded(7)
          .border_1()
          .border_color(alpha(t.ansi3 ?? t.working ?? t.accent, "55"))
          .bg(alpha(t.ansi3 ?? t.working ?? t.accent, "12"))
          .child(
            svg("mods/orca/icons/clock.svg")
              .size(12)
              .flex_none()
              .text_color(t.ansi3 ?? t.working ?? t.accent)
              .when(state === "waiting_ci", (sp) =>
                sp.loop("opacity", { from: 0.35, to: 1, period: 1100 }),
              ),
          )
          .when(Boolean(s.ciInfo?.branch), (b) =>
            b.child(badge(s.ciInfo.branch, t.foreground, t.raised)),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11.5)
              .text_color(t.foreground)
              .child(s.ciInfo?.summary || s.ciInfo?.state || "Проверка CI"),
          )
          .when(state === "waiting_ci" && Boolean(s.nextCiCheckAt), (c) =>
            c.child(
              badge(
                formatCountdown(s.nextCiCheckAt),
                t.ansi3 ?? t.working ?? t.accent,
                alpha(t.ansi3 ?? t.working ?? t.accent, "22"),
              ),
            ),
          )
          .child(
            badge(
              `Попытка ${retryCount}/${retryLimitLabel}`,
              t.muted,
              t.raised,
            ),
          )
          .when(state === "waiting_ci", (b) =>
            b.child(
              pillButton(
                "orca-check-ci-now",
                "Проверить CI",
                false,
                (_e, cx) => view.checkCiNow(cx),
                t,
                { icon: "refresh", height: 22, px: 8, textSize: 11 },
              ),
            ),
          ),
      ),
    )
    .when(Boolean(s.statusReason), (el) => {
      const isErr = state === "error";
      const bannerColor = isErr ? (t.blocked ?? t.ansi1) : t.muted;
      return el.child(
        h_flex()
          .px(9)
          .py(6)
          .gap(6)
          .items_center()
          .rounded(6)
          .border_1()
          .border_color(isErr ? alpha(bannerColor, "55") : t.border)
          .bg(isErr ? alpha(bannerColor, "18") : t.surface)
          .when(isErr, (b) =>
            b.child(svg("mods/orca/icons/blocked.svg").size(12).flex_none().text_color(bannerColor)),
          )
          .child(
            div()
              .flex_1()
              .min_w(0)
              .text_size(11.5)
              .text_color(isErr ? bannerColor : t.muted)
              .child(s.statusReason),
          ),
      );
    });
}

function isSameQueueItem(a, b) {
  if (!a || !b) return false;
  if (a.epic?.filePath !== b.epic?.filePath) return false;
  const lineA = a.task?.lineIndex ?? null;
  const lineB = b.task?.lineIndex ?? null;
  return lineA === lineB;
}

export function renderQueueAndLog(view, t) {
  const s = view.activeSession?.() ?? view;
  const queueItems = view.getQueueItems?.() ?? [];
  const logs = s.logs ?? [];
  const wide = (view.size?.width ?? 0) >= 720;

  const queuePanel = v_flex()
    .id("orca-queue-panel")
    .flex_1()
    .min_h(0)
    .min_w(0)
    .bg(t.background)
    .when(wide, (el) => el.border_r(1).border_color(t.border))
    .when(!wide, (el) => el.border_b(1).border_color(t.border))
    .child(
      h_flex()
        .h(32)
        .flex_none()
        .px(12)
        .gap(6)
        .items_center()
        .bg(t.surface)
        .border_b(1)
        .border_color(t.border)
        .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child("Очередь"))
        .child(badge(String(queueItems.length), t.accent, alpha(t.accent, "1e")))
        .child(div().flex_1())
        .child(
          div()
            .text_size(10.5)
            .text_color(t.dim)
            .child(s.mode === "epics" ? "Эпики" : "Задачи"),
        ),
    )
    .child(
      div()
        .flex_1()
        .min_h(0)
        .relative()
        .child(
          div()
            .id("orca-queue-scroll")
            .absolute()
            .inset_0()
            .overflow_y_scroll()
            .child(
              v_flex()
                .w_full()
                .p(8)
                .gap(5)
                .when(queueItems.length === 0, (el) =>
                  el.child(
                    div()
                      .py(18)
                      .text_center()
                      .text_size(12)
                      .text_color(t.dim)
                      .child(s.backlogDir ? "Нет открытых задач в очереди" : "Выберите папку backlog"),
                  ),
                )
                .children(
                  queueItems.map((item, idx) => {
                    const { epic, task } = item;
                    const isCurrent = isSameQueueItem(item, s.currentItem);
                    const itemId = task ? task.id : epic.id;
                    const itemTitle = task ? task.title : epic.title;
                    return h_flex()
                      .id(`orca-q-${idx}-${epic.id}-${task?.lineIndex ?? "e"}`)
                      .px(9)
                      .py(7)
                      .gap(7)
                      .items_center()
                      .rounded(7)
                      .border_1()
                      .border_color(isCurrent ? t.accent : t.border)
                      .bg(isCurrent ? t.selected : t.surface)
                      .cursor_pointer()
                      .hover((s) => s.bg(isCurrent ? t.selected : t.hover))
                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                      .on_click((_e, cx) => {
                        if (typeof view.focusQueueItem === "function") {
                          view.focusQueueItem(item, cx);
                        }
                      })
                      .when(Boolean(epic.priority), (el) =>
                        el.child(
                          badge(
                            epic.priority,
                            priorityColor(t, epic.priority),
                            alpha(priorityColor(t, epic.priority), "20"),
                          ),
                        ),
                      )
                      .child(
                        div()
                          .flex_none()
                          .text_size(11)
                          .font_semibold()
                          .text_color(isCurrent ? t.accent : t.dim)
                          .child(itemId),
                      )
                      .when(Boolean(task && epic.id), (el) =>
                        el.child(badge(epic.id, t.muted, t.raised)),
                      )
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .truncate()
                          .text_size(12)
                          .when(isCurrent, (s) => s.font_medium())
                          .text_color(t.foreground)
                          .child(itemTitle),
                      )
                      .when(isCurrent, (el) =>
                        el
                          .child(badge("В работе", t.accent, alpha(t.accent, "20")))
                          .child(
                            iconButton(
                              `orca-q-skip-${idx}`,
                              "skip",
                              "Пропустить текущую задачу",
                              (_e, cx) => view.skipCurrent(cx),
                              t,
                              { size: 20, iconSize: 11 },
                            ),
                          ),
                      );
                  }),
                ),
            ),
        )
        .child(Scrollbar.vertical("orca-queue-scroll").absolute().inset_0()),
    );

  const logPanel = v_flex()
    .id("orca-log-panel")
    .flex_1()
    .min_h(0)
    .min_w(0)
    .bg(t.background)
    .child(
      h_flex()
        .h(32)
        .flex_none()
        .px(12)
        .gap(6)
        .items_center()
        .bg(t.surface)
        .border_b(1)
        .border_color(t.border)
        .child(div().text_size(11.5).font_semibold().text_color(t.foreground).child("Журнал"))
        .child(badge(String(logs.length), t.muted, t.raised)),
    )
    .child(
      div()
        .flex_1()
        .min_h(0)
        .relative()
        .child(
          div()
            .id("orca-log-scroll")
            .absolute()
            .inset_0()
            .overflow_y_scroll()
            .child(
              v_flex()
                .w_full()
                .p(8)
                .gap(4)
                .when(logs.length === 0, (el) =>
                  el.child(
                    div()
                      .py(18)
                      .text_center()
                      .text_size(12)
                      .text_color(t.dim)
                      .child("Событий пока нет"),
                  ),
                )
                .children(
                  logs.map((entry, idx) => {
                    const ts = formatLogTime(entry.time);
                    const color = logLevelColor(t, entry.level);
                    return h_flex()
                      .id(`orca-log-${idx}`)
                      .px(8)
                      .py(4)
                      .gap(8)
                      .items_start()
                      .rounded(5)
                      .bg(idx % 2 === 0 ? t.surface : t.background)
                      .when(Boolean(ts), (el) =>
                        el.child(
                          div()
                            .flex_none()
                            .text_size(10.5)
                            .text_color(t.dim)
                            .child(ts),
                        ),
                      )
                      .child(
                        div()
                          .flex_1()
                          .min_w(0)
                          .text_size(11.5)
                          .line_height("16px")
                          .text_color(entry.level === "error" || entry.level === "warn" ? color : t.foreground)
                          .child(entry.text ?? ""),
                      );
                  }),
                ),
            ),
        )
        .child(Scrollbar.vertical("orca-log-scroll").absolute().inset_0()),
    );

  return (wide ? h_flex() : v_flex())
    .id("orca-body")
    .flex_1()
    .min_h(0)
    .min_w(0)
    .child(queuePanel)
    .child(logPanel);
}

function renderInputBox(id, state, t, opts = {}) {
  return h_flex()
    .id(id)
    .h(28)
    .px(8)
    .gap(6)
    .items_center()
    .rounded(6)
    .border_1()
    .border_color(t.input)
    .bg(t.background)
    .when(Boolean(opts.flex1), (el) => el.flex_1().min_w(0))
    .when(Boolean(opts.w), (el) => el.w(opts.w))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(Input.new(state).flex_1().h_full().text_size(12).text_color(t.foreground))
    .when(Boolean(opts.trailing), (el) => el.child(opts.trailing));
}

export function renderFooterAndSettings(view, t) {
  const activeModel = view.settings?.model || "Модель не задана";
  const models = view.availableModels ?? [];
  const modelQuery = (view.modelFilter ?? "").trim().toLowerCase();
  const filteredModels = modelQuery
    ? models.filter((m) => m.toLowerCase().includes(modelQuery))
    : models;
  const selectedModel = view.modelInput ? view.modelInput.value().trim() : view.settings?.model;
  const maxDropdownH = Math.max(90, Math.min(180, Math.round(((view.size?.height ?? 800) - 360) * 0.5)));
  const dropdownListHeight = Math.min(maxDropdownH, Math.max(40, filteredModels.length * 28 + 12));
  const draftOptional = normalizeOptionalReviewChecks(
    view.draftOptionalChecks ?? view.settings?.optionalReviewChecks,
  );
  const draftOptionalSet = new Set(draftOptional);
  const maxOptionalScore = getMaxOptionalReviewScore(draftOptional);
  const blockingTip = BLOCKING_REVIEW_CHECKS.map((c) => `• ${c.label}`).join("\n");

  return v_flex()
    .id("orca-footer-wrap")
    .flex_none()
    .bg(t.chrome)
    .border_t(1)
    .border_color(t.border)
    .when(view.settingsOpen, (el) =>
      el.child(
        v_flex()
          .id("orca-settings-drawer")
          .p(12)
          .gap(10)
          .bg(t.surface)
          .border_b(1)
          .border_color(t.border)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(
            h_flex()
              .items_center()
              .justify_between()
              .child(div().text_size(12.5).font_semibold().text_color(t.foreground).child("Настройки классификатора и CI"))
              .child(
                iconButton(
                  "orca-settings-close",
                  "x",
                  "Закрыть настройки",
                  (_e, cx) => view.toggleSettings(cx),
                  t,
                  { size: 22, iconSize: 12 },
                ),
              ),
          )
          .child(
            h_flex()
              .flex_wrap()
              .gap(8)
              .child(
                v_flex()
                  .flex_1()
                  .min_w(200)
                  .gap(4)
                  .child(div().text_size(11).font_medium().text_color(t.muted).child("Base URL (/v1)"))
                  .child(renderInputBox("orca-input-baseurl", view.baseUrlInput, t)),
              )
              .child(
                v_flex()
                  .flex_1()
                  .min_w(180)
                  .gap(4)
                  .child(div().text_size(11).font_medium().text_color(t.muted).child("API Key (необязательно)"))
                  .child(
                    renderInputBox("orca-input-apikey", view.apiKeyInput, t, {
                      trailing: iconButton(
                        "orca-apikey-eye",
                        "eye",
                        view.apiKeyMasked ? "Показать ключ" : "Скрыть ключ",
                        (_e, cx) => view.toggleApiKeyMask(cx),
                        t,
                        { size: 20, iconSize: 12, color: view.apiKeyMasked ? t.dim : t.accent },
                      ),
                    }),
                  ),
              ),
          )
          .child(
            v_flex()
              .gap(5)
              .child(
                h_flex()
                  .gap(8)
                  .items_end()
                  .flex_wrap()
                  .child(
                    v_flex()
                      .flex_1()
                      .min_w(180)
                      .gap(4)
                      .child(div().text_size(11).font_medium().text_color(t.muted).child("Модель"))
                      .child(
                        renderInputBox("orca-input-model", view.modelInput, t, {
                          trailing:
                            models.length > 0
                              ? iconButton(
                                  "orca-model-dropdown-btn",
                                  view.modelPickerOpen ? "chevron-down" : "chevron-right",
                                  `Выбрать модель из списка (${models.length})`,
                                  (_e, cx) => view.toggleModelPicker(cx),
                                  t,
                                  {
                                    size: 20,
                                    iconSize: 12,
                                    color: view.modelPickerOpen ? t.accent : t.muted,
                                  },
                                )
                              : null,
                        }),
                      ),
                  )
                  .child(
                    pillButton(
                      "orca-fetch-models",
                      view.modelsLoading ? "Загрузка…" : "Загрузить модели",
                      false,
                      (_e, cx) => view.fetchModels(cx),
                      t,
                      {
                        icon: view.modelsLoading ? "spinner" : "refresh",
                        spin: view.modelsLoading ? 900 : 0,
                        height: 28,
                        px: 10,
                      },
                    ),
                  )
                  .child(
                    v_flex()
                      .w(135)
                      .gap(4)
                      .child(div().text_size(11).font_medium().text_color(t.muted).child("Попыток фикса CI"))
                      .child(renderInputBox("orca-input-retries", view.maxRetriesInput, t)),
                  )
                  .child(
                    v_flex()
                      .w(135)
                      .gap(4)
                      .child(div().text_size(11).font_medium().text_color(t.muted).child("Попыток ревью"))
                      .child(renderInputBox("orca-input-review-retries", view.maxReviewRetriesInput, t)),
                  ),
              )
              .when(models.length > 0, (el) =>
                el.child(
                  h_flex()
                    .id("orca-model-picker-toggle")
                    .h(26)
                    .px(8)
                    .gap(6)
                    .items_center()
                    .rounded(6)
                    .border_1()
                    .border_color(view.modelPickerOpen ? t.accent : t.border)
                    .bg(view.modelPickerOpen ? t.selected : t.background)
                    .text_size(11.5)
                    .text_color(view.modelPickerOpen ? t.foreground : t.muted)
                    .cursor_pointer()
                    .hover((s) => s.bg(t.hover).text_color(t.foreground))
                    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                    .on_click((_e, cx) => view.toggleModelPicker(cx))
                    .child(
                      div()
                        .flex_1()
                        .min_w(0)
                        .truncate()
                        .child(
                          selectedModel
                            ? `Выбрать модель (${models.length}): ${selectedModel}`
                            : `Выбрать модель из списка (${models.length})`,
                        ),
                    )
                    .child(
                      svg(`mods/orca/icons/${view.modelPickerOpen ? "chevron-down" : "chevron-right"}.svg`)
                        .size(11)
                        .flex_none()
                        .text_color(t.dim),
                    ),
                ),
              )
              .when(view.modelPickerOpen && models.length > 0, (el) =>
                el.child(
                  v_flex()
                    .id("orca-model-dropdown")
                    .rounded(8)
                    .border_1()
                    .border_color(t.border)
                    .bg(t.background)
                    .overflow_hidden()
                    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                    .when(models.length > 6, (box) =>
                      box.child(
                        div()
                          .p(6)
                          .border_b(1)
                          .border_color(t.border)
                          .child(renderInputBox("orca-model-search", view.modelSearchInput, t)),
                      ),
                    )
                    .child(
                      div()
                        .h(dropdownListHeight)
                        .w_full()
                        .relative()
                        .child(
                          div()
                            .id("orca-models-scroll")
                            .absolute()
                            .inset_0()
                            .overflow_y_scroll()
                            .child(
                              v_flex()
                                .w_full()
                                .p(5)
                                .gap(2)
                                .when(filteredModels.length === 0, (empty) =>
                                  empty.child(
                                    div()
                                      .px(8)
                                      .py(6)
                                      .text_size(11.5)
                                      .text_color(t.dim)
                                      .child("Модели не найдены"),
                                  ),
                                )
                                .children(
                                  filteredModels.map((modelId, idx) => {
                                    const isCurrent = modelId === selectedModel;
                                    return h_flex()
                                      .id(`orca-model-opt-${idx}`)
                                      .h(26)
                                      .px(8)
                                      .gap(6)
                                      .items_center()
                                      .rounded(5)
                                      .bg(isCurrent ? t.selected : t.background)
                                      .cursor_pointer()
                                      .hover((s) => s.bg(isCurrent ? t.selected : t.hover))
                                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                                      .on_click((_e, cx) => view.selectModel(modelId, cx))
                                      .child(
                                        div()
                                          .flex_1()
                                          .min_w(0)
                                          .truncate()
                                          .text_size(11.5)
                                          .when(isCurrent, (s) => s.font_medium())
                                          .text_color(isCurrent ? t.accent : t.foreground)
                                          .child(modelId),
                                      )
                                      .when(isCurrent, (chk) =>
                                        chk.child(
                                          svg("mods/orca/icons/check.svg")
                                            .size(11)
                                            .flex_none()
                                            .text_color(t.accent),
                                        ),
                                      );
                                  }),
                                ),
                            ),
                        )
                        .child(Scrollbar.vertical("orca-models-scroll").absolute().inset_0()),
                    ),
                ),
              )
              .child(
                h_flex()
                  .justify_end()
                  .child(
                    div()
                      .text_size(10.5)
                      .text_color(t.dim)
                      .child("0 = бесконечно, по умолчанию 3"),
                  ),
              )
              .child(
                v_flex()
                  .id("orca-review-strictness")
                  .p(8)
                  .gap(7)
                  .rounded(7)
                  .border_1()
                  .border_color(t.border)
                  .bg(t.background)
                  .child(
                    h_flex()
                      .flex_wrap()
                      .gap(8)
                      .items_center()
                      .justify_between()
                      .child(
                        h_flex()
                          .gap(6)
                          .items_center()
                          .flex_wrap()
                          .child(
                            div()
                              .text_size(11)
                              .font_semibold()
                              .text_color(t.foreground)
                              .child("Строгость ревью"),
                          )
                          .child(
                            h_flex()
                              .id("orca-blocking-min-badge")
                              .h(20)
                              .px(7)
                              .gap(4)
                              .items_center()
                              .rounded(5)
                              .border_1()
                              .border_color(alpha(t.accent, "44"))
                              .bg(alpha(t.accent, "14"))
                              .opacity(0.85)
                              .tooltip(`Минимум (всегда включено, нельзя отключить):\n${blockingTip}`)
                              .child(
                                svg("mods/orca/icons/check.svg")
                                  .size(10)
                                  .flex_none()
                                  .text_color(t.accent),
                              )
                              .child(
                                div()
                                  .text_size(10.5)
                                  .font_medium()
                                  .text_color(t.accent)
                                  .child(`Минимум: блокеры (${BLOCKING_REVIEW_CHECKS.length})`),
                              ),
                          ),
                      )
                      .child(
                        h_flex()
                          .gap(6)
                          .items_center()
                          .child(
                            div()
                              .text_size(11)
                              .text_color(t.muted)
                              .tooltip("Сколько баллов нужно набрать по выбранным чекбоксам (пусто = 15)")
                              .child("Порог баллов:"),
                          )
                          .child(
                            renderInputBox("orca-input-min-review-score", view.minReviewScoreInput, t, {
                              w: 64,
                            }),
                          )
                          .child(
                            div()
                              .text_size(10.5)
                              .text_color(t.dim)
                              .child(`из ${maxOptionalScore} (пусто = 15)`),
                          ),
                      ),
                  )
                  .child(
                    h_flex()
                      .flex_wrap()
                      .gap(5)
                      .children(
                        OPTIONAL_REVIEW_CHECKS.map((chk) => {
                          const checked = draftOptionalSet.has(chk.id);
                          return h_flex()
                            .id(`orca-opt-chk-${chk.id}`)
                            .h(22)
                            .px(7)
                            .gap(5)
                            .flex_none()
                            .items_center()
                            .rounded(5)
                            .border_1()
                            .border_color(checked ? alpha(t.accent, "66") : t.border)
                            .bg(checked ? alpha(t.accent, "16") : t.surface)
                            .cursor_pointer()
                            .tooltip(`${chk.label} (+${chk.weight} б.)`)
                            .hover((st) => st.bg(t.hover))
                            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                            .on_click((_e, cx) => view.toggleOptionalReviewCheck(chk.id, cx))
                            .child(
                              h_flex()
                                .size(12)
                                .flex_none()
                                .items_center()
                                .justify_center()
                                .rounded(3)
                                .border_1()
                                .border_color(checked ? t.accent : t.input)
                                .bg(checked ? t.accent : t.background)
                                .when(checked, (el) =>
                                  el.child(
                                    svg("mods/orca/icons/check.svg")
                                      .size(8)
                                      .text_color(t.solid_foreground),
                                  ),
                                ),
                            )
                            .child(
                              div()
                                .text_size(10.5)
                                .when(checked, (el) => el.font_medium())
                                .text_color(checked ? t.foreground : t.muted)
                                .child(`${chk.label} (+${chk.weight})`),
                            );
                        }),
                      ),
                  ),
              )
              .when(Boolean(view.modelsError), (err) =>
                err.child(
                  div()
                    .px(8)
                    .py(5)
                    .rounded(6)
                    .bg(alpha(t.blocked ?? t.ansi1, "18"))
                    .border_1()
                    .border_color(alpha(t.blocked ?? t.ansi1, "55"))
                    .text_size(11)
                    .text_color(t.blocked ?? t.ansi1)
                    .child(view.modelsError),
                ),
              ),
          )
          .child(
            h_flex()
              .gap(8)
              .items_center()
              .justify_end()
              .child(
                pillButton(
                  "orca-settings-cancel",
                  "Отмена",
                  false,
                  (_e, cx) => view.toggleSettings(cx),
                  t,
                  { height: 28, px: 10 },
                ),
              )
              .child(
                solidButton(
                  "orca-settings-save",
                  "Сохранить",
                  "check",
                  (_e, cx) => view.saveSettings(cx),
                  t,
                  { height: 28, px: 12 },
                ),
              ),
          ),
      ),
    )
    .child(
      h_flex()
        .id("orca-footer-bar")
        .h(36)
        .px(12)
        .gap(8)
        .items_center()
        .child(
          pillButton(
            "orca-settings-btn",
            "Настройки",
            view.settingsOpen,
            (_e, cx) => view.toggleSettings(cx),
            t,
            { icon: "settings", height: 24, px: 8, textSize: 11.5 },
          ),
        )
        .child(
          badge(
            (view.settings?.reviewMode ?? "reviewer") === "reviewer" ? "Ревьювер" : "Авто",
            (view.settings?.reviewMode ?? "reviewer") === "reviewer" ? (t.ansi5 ?? t.accent) : t.muted,
            (view.settings?.reviewMode ?? "reviewer") === "reviewer"
              ? alpha(t.ansi5 ?? t.accent, "1c")
              : t.raised,
          ),
        )
        .child(badge(activeModel, t.accent, alpha(t.accent, "1c")))
        .when(Boolean(view.settings?.baseUrl), (el) =>
          el.child(
            div()
              .flex_1()
              .min_w(0)
              .truncate()
              .text_size(11)
              .text_color(t.dim)
              .child(view.settings.baseUrl),
          ),
        )
        .when(!view.settings?.baseUrl, (el) => el.child(div().flex_1()))
        .child(
          (() => {
            const canUpdate = Boolean(view.updateAvailable) && !view.updating;
            const updateTip = view.updating
              ? "Выполняется обновление Orca…"
              : view.checkingUpdate
                ? "Проверка обновлений Orca…"
                : view.updateAvailable
                  ? "Доступно обновление Orca — нажмите, чтобы обновить"
                  : view.updateCheckError
                    ? `Не удалось проверить обновления: ${view.updateCheckError}`
                    : "Установлена актуальная версия Orca";
            return pillButton(
              "orca-update-btn",
              view.updating ? "Обновление…" : "Обновить",
              canUpdate,
              (_e, cx) => view.updateOrca(cx),
              t,
              {
                icon: view.updating ? "spinner" : "download",
                spin: view.updating ? 900 : 0,
                height: 24,
                px: 8,
                textSize: 11.5,
                disabled: !canUpdate,
                activeFg: t.accent,
                activeBg: alpha(t.accent, "1c"),
                activeBorder: alpha(t.accent, "66"),
                tip: updateTip,
              },
            );
          })(),
        ),
    );
}
