# pi-task-orientation

A pi extension that turns "orientation" from a one-shot startup ritual into a **continuous task loop**, built for weak reasoning models (e.g. deepseek-v4-flash) that ignore soft instructions. **v2** replaces the v1 `task_orientation` tool with a gated `plan()` + a live `task_todo()` list, mid-task checkpoints, and a next-request continuation nudge.

## Why

Two chronic problems in agentic coding:
- **Skills get skipped**: with progressive disclosure, the system prompt only lists skill names + one-line descriptions. A model that never decides to `read` a SKILL.md effectively ignores the skill system.
- **AGENTS.md rules get silently ignored**: the full AGENTS.md is injected into the system prompt, but as *reference context* — nothing forces the model to analyze it, so "always-applicable" rules are followed inconsistently and "conditional" rules (e.g. worklog updates) are dropped without anyone noticing.

v1 forced a *one-shot* orientation at the start of every request. It worked, but every new message re-armed the gate, and the gate could be gamed with `["none"]`. v2 fixes both: the gate now fires **once per task**, and the unlock action *is* the deliverable (a real plan — there is no cheap "none" escape).

## How it works

```
┌─ Instruction  before_agent_start   new task → arm gate + inject plan() directive
│                                     continuation → no gate + inject continue nudge
├─ Enforcement  tool_call            block every tool until plan() is called
├─ Delivery     plan()               skills + AGENTS.md analysis + execution checklist
├─ Execution    (free)               task_todo() keeps the checklist live; load_skill mid-task
├─ Observation  turn_end + context   compact checkpoint: status line + update/AGENTS.md nudge
└─ Continuation  agent_end            archives completed lists; leftovers continue at the next request
```

### The state machine (gate = once per task, not per message)

```
before_agent_start:
  activeTodo == null or all terminated → NEW TASK: arm gate, inject plan() directive
  otherwise                             → CONTINUATION: no gate, inject continue nudge
```

- `activeTodo` lives in the extension's state and in every `plan()`/`task_todo()` tool-result `details` (branch-safe; survives `/fork`).
- On `session_start` / `session_tree` / `session_compact` the state is rebuilt from session history, so a mid-task `/compact` or `/reload` does not lose the checklist.
- On task completion the final list is archived via `appendEntry` (audit trail).

### plan() — the gated mandatory first step

Called before any other tool on a fresh task. Three deliverables in one call:

```ts
plan({
  skills: ["code-review"],        // matching skills, or [] — /skill: loaded ones are auto-skipped
  reason: "covers the review part",
  skipped_rules: [{ rule: "worklog update", reason: "no files changed yet" }], // or []
  todos: [
    { title: "read the diff", status: "in_progress" }, // at most one in_progress
    { title: "review per skill", status: "pending" }
  ],
})
```

- **Skills**: chosen SKILL.md files are injected in full (no `read` needed, cannot be skipped). Already-loaded skills (manual `/skill:name`) are never re-injected.
- **AGENTS.md rules are BINDING**: lack of forceful wording does not downgrade a rule. Conditional rules are recorded via `skipped_rules` and re-checked at checkpoints when they become triggered (e.g. after modifying files).
- **Todos** must be a real execution checklist — there is no throwaway value like `"none"`; the cheapest way to unlock the gate is to produce a genuine plan.

### task_todo() — live updates during execution

```ts
task_todo({ action: "update", id: 3, status: "done" })
task_todo({ action: "update", id: 3, status: "blocked" })
task_todo({ action: "add", title: "also fix the README", status: "pending" })
task_todo({ action: "load_skill", skills: ["diagnosing-bugs"] })
```

Enforces two rules: **at most one item `in_progress`** (the model must close the current item before opening another), and **statuses follow the situation** (finished → done, superseded or unneeded → cancelled, cannot proceed now → blocked, no longer blocked → pending, new work → new items — per `task_todo`'s status rules). `load_skill` injects a new skill's full instructions mid-task without re-arming the gate.

### Checkpoints (turn_end → context)

After every execution turn, a compact status line is injected before the next LLM call:

```
[checkpoint] Done: 2 · In progress: #3 "implement login API" · Pending: 2 (next: #4 "write tests")
- Something completed or changed? Call task_todo to update it (or load_skill for a new skill).
- Did an AGENTS.md conditional rule trigger? Apply it now or add it to the todos.
- Otherwise just continue — no action needed.
```

Old orientation messages are pruned from context so only the latest stays; checkpoints are injected per-LLM-call and do not pollute session history.

### agent_end continuation (no end-check)

`agent_end` always calls the completion archive: a list that is fully `done`/`cancelled` is archived and cleared (next request starts a new task), otherwise the list is kept and the next user message enters **continuation mode** — the injected continuation nudge asks the model to update the todos per the current state and the new message, then continue. Leftover `in_progress`/`pending`/`blocked` items are resolved there, not by a forced end-of-request round.

## Known issues with deepseek-v4-flash (why this exists)

Measured against deepseek-v4-flash in controlled experiments:

1. **Thinking (chain-of-thought) defaults to English.** Even when AGENTS.md says "think in Chinese", deepseek-v4-flash reasons in English (~71% of thinking blocks in our session). A *descriptive* rule is **not enough** — it only works as a strong imperative with examples. Phrase such rules as commands, and the BINDING wording in the plan() directive makes ignoring them a conscious act.
2. **Models circumvent soft gates.** If a gate has a cheap legal exit (e.g. `task_orientation(["none"])`), the model learns to take it every time — one session had 18 gate calls, all `"none"`, zero skills loaded. v2's `plan()` has **no** cheap exit: the mandatory `reason`, `skipped_rules`, and a real `todos` list make the unlock action equal to the deliverable.
3. **Soft reminders get dropped.** That is why the start is a hard gate, the end is a hard check, and the middle is *frequent* (every turn) rather than one-shot — a reminder the model sees every turn is much harder to ignore than a directive it saw once.

## Design principles

- **Gate = once per task**: only a fresh task (or a finished one) re-arms the gate; "continue" messages do not.
- **Unlock = deliverable**: the cheapest legal plan() is a genuine plan, not a token call.
- **State owned by the harness**: `activeTodo` lives in extension state and tool-result `details` — the model edits via tools, the harness persists, echoes, and reconstructs across `/compact` / `/reload` / `/fork`.
- **Hard at both ends, free in the middle**: start gate + end check are the two mechanically-detectable anchors; in between, no per-tool interference, only per-turn nudges.
- **Auditable**: skill choices, AGENTS.md `skipped_rules`, and the archived todo list are all recorded in session history.
- **Generic, not special-cased**: the extension never names specific skills or rules (no hardcoded "diagnosing-bugs" or "worklog"); everything is derived from `<available_skills>` and the project's AGENTS.md.

## Manual skills (`/skill:name`)

- **Visible skill**: content is already in the user message; `plan()` skips re-injection automatically, and the model may still add *other* matching skills.
- **Invisible skill** (`disable-model-invocation`): also already in context via `/skill:` expansion; the gate only requires one `plan()` call (with `[]` or other skills), then execution is free. No extra friction beyond that single orientation call.

## Known limitations (v1)

- A model can still produce a hollow `todos` list to open the gate. The counterweights are the mandatory `reason`/`skipped_rules`, the checkpoint echo (a fake plan is visibly wrong), and the audit trail. A "confirm the plan" approval step is a planned v3 enhancement.
- Re-planning on continuation messages is model-voluntary (no gate) — by design, to keep the gate rare.
- "Todos all terminated but a conditional rule (e.g. worklog) was forgotten" is not mechanically catchable; it relies on the BINDING wording and checkpoint nudges.
- In the armed window a weak model may still try 1–2 other tools before calling `plan()`; each attempt is one blocked round-trip.

## Install

```bash
pi install npm:pi-task-orientation
```

or copy `extensions/task-orientation.ts` into `~/.pi/agent/extensions/` and `/reload`.

## Migration from v1

`pi-task-orientation@2` supersedes `@1`. The `task_orientation` tool is gone; the system prompt directive now points to `plan()` / `task_todo()`.

1. Update to `2.0.0` (`pi install npm:pi-task-orientation@2` or replace the local file).
2. `/reload`.
3. Existing sessions are compatible — v2 reconstructs task state from session history.

## Development

```bash
# strict type check (uses types-shim.d.ts + tsconfig.check.json for local resolution)
npx -y -p typescript tsc -p tsconfig.check.json

# syntax/transpile check (what the pi runtime does)
npx -y esbuild extensions/task-orientation.ts --bundle --format=esm --platform=node \
  --external:@earendil-works/* --external:typebox --outfile=/tmp/to-check.js
```

## License

MIT

---

## 中文说明

**这是什么**：一个让"定向"从一次性仪式变成**持续任务循环**的 pi 扩展。v2 用门控的 `plan()`（技能 + AGENTS.md 分析 + 执行清单三合一）取代 v1 的 `task_orientation`，新增 `task_todo()` 执行期更新、turn-end 检查点、agent-end 收尾兜底。

**核心改进**：
- **门控从"每条消息"降到"每个任务"**：只有新任务（或任务完成后的下一条消息）才武装门控；"继续"类消息不武装，直接延续。
- **解锁 = 交付物**：`plan()` 没有 `["none"]` 这种廉价出口——最便宜的解锁就是写出一份真实清单。堵死了 v1 README 记录的"18 次全 none"绕过。
- **两端硬、中间自由**：起点 plan 硬门控 + 终点条件硬收尾（todo 未终结或 plan 从未调用时，只续跑一轮）；执行期不干预工具，只靠每 turn 的紧凑检查点软提醒。
- **状态 harness 持有**：清单存在扩展状态与工具结果 `details`，跨 `/compact` `/reload` `/fork` 可重建；任务完成时 `appendEntry` 存档审计。
- **通用不特化**：不点名任何具体技能或规则（不硬编码"diagnosing-bugs"、"worklog"），一切从 `<available_skills>` 与项目 AGENTS.md 动态推导。

**手动 `/skill:name`**：可见技能与不可见技能都因 `/skill:` 展开而全文已在上下文，`plan()` 自动跳过重复注入；不可见技能也只多付一次 plan 调用的代价即可自由执行。

**已知限制（v1）**：空洞 todo 仍能解锁（靠 reason/skipped_rules 必填、检查点回显反噬与审计兜底，人工"确认计划"步骤列入 v3）；延续模式的重排是软约束；"todo 全终结但漏了条件规则"机械上抓不到，靠 BINDING 措辞与检查点提醒。

**从 v1 迁移**：工具 `task_orientation` 已移除，升级到 2.0.0 后 `/reload` 即可；v2 会从会话历史重建任务状态，旧会话兼容。
