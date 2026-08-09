# pi-task-orientation

A pi extension that makes every request start with a **two-step orientation**, replacing the old `pi-mandatory-skill-resolution`.

## Why

Two chronic problems in agentic coding:
- **Skills get skipped**: with progressive disclosure, the system prompt only lists skill names + one-line descriptions. A model that never decides to `read` a SKILL.md effectively ignores the skill system.
- **AGENTS.md rules get silently ignored**: the full AGENTS.md is injected into the system prompt, but as *reference context* — nothing forces the model to analyze it, so "always-applicable" rules are followed inconsistently and "conditional" rules (e.g. worklog updates) are dropped without anyone noticing.

This extension turns both from "hopeful behavior" into a **mandatory, auditable routine**.

## How it works

At every new request (`before_agent_start`), the model receives two steps and must call the `task_orientation` tool before any other tool (gated):

**Step 1 · Skill assessment**
The model checks the `<available_skills>` list and passes ALL matching skill names — or `["none"]`. Each chosen skill's full SKILL.md is loaded into context immediately (no `read` needed, cannot be skipped). A required `reason` prevents mechanical "none" answers.

**Step 2 · Project rule analysis** (only injected when the project has an AGENTS.md)
The model must check EVERY rule in AGENTS.md one by one, apply always-applicable rules, and — for conditional rules whose condition this request does not meet — pass them to the `skipped_rules` parameter with a concrete reason. Nothing is silently dropped.

The tool accepts:

```ts
task_orientation({
  skills: ["code-review"],          // all matching skills, or ["none"]
  reason: "covers the review part", // concrete justification
  skipped_rules: [                  // conditional AGENTS.md rules not triggered
    { rule: "worklog update", reason: "no files changed" }
  ],                                // empty array if nothing skipped
})
```

Design principles:
- **Zero duplication**: the skill list stays in the system prompt (`<available_skills>`), and AGENTS.md stays in `<project_context>` — the extension only teaches *how to use* them, never re-injects their content.
- **Auditable decisions**: both "which skills" and "which conditional rules were skipped and why" are recorded in the tool call (session history), not just in free-form output.
- **Cost-aware**: no skills apply → `["none"]` + one-line reason; nothing skipped → empty array. No output bloat for well-behaved requests.
- **Multi-skill**: a request may match several skills; all are loaded.

## Install

```bash
pi install npm:pi-task-orientation
```

## Replacing pi-mandatory-skill-resolution

`pi-task-orientation` supersedes `pi-mandatory-skill-resolution`. If you previously installed the old package:

1. Remove `pi-mandatory-skill-resolution` from your settings (or remove its file from `~/.pi/agent/extensions/`).
2. Install `pi-task-orientation`.
3. `/reload`.

Both register a gating tool; running them together causes a conflict.

## Development

```bash
npx -y -p typescript tsc --noEmit --strict --esModuleInterop --skipLibCheck \
  --module nodenext --moduleResolution nodenext --target es2022 \
  extensions/task-orientation.ts
```

## License

MIT

---

## 中文说明

**这是什么**：一个 pi 扩展，让每个请求在开始前强制完成**两步骤定向**，取代旧的 `pi-mandatory-skill-resolution`。

**解决的两个问题**：
- **技能被跳过**：渐进式披露下，系统提示里只有技能名+一行描述，模型不主动 `read` SKILL.md 就等于无视技能系统。
- **AGENTS.md 规则被默默忽略**：AGENTS.md 全文虽然注入在系统提示里，但只是"参考上下文"——没有机制强制模型分析它，导致"始终适用"规则执行不一致、"条件式"规则（如 worklog 更新）被丢弃也无人察觉。

**工作方式**（每轮 `before_agent_start` 注入，所有其他工具被门控直到调用 `task_orientation`）：

- **第 1 步 · 技能评估**：对照 `<available_skills>` 列表，传入全部匹配的技能名（可多个），或 `["none"]`。选中的技能 SKILL.md 全文立即注入上下文（无需 read、无法跳过）。必填 `reason` 防机械敷衍。
- **第 2 步 · 项目规则分析**（仅项目有 AGENTS.md 时注入）：逐条检查 AGENTS.md 全部规则，始终适用的直接应用；本轮不触发条件式规则时，把"跳过项 + 具体原因"传入 `skipped_rules` 参数——不默默丢弃任何规则。

**设计原则**：零重复（技能列表与 AGENTS.md 内容都留在系统提示，扩展只教"怎么用"）；决策可审计（技能选择与跳过规则都在工具调用里，写入会话历史）；成本可控（无匹配 → `["none"]` + 一行理由；无跳过 → 空数组）；支持多技能。

**安装**：`pi install npm:pi-task-orientation`

**取代旧扩展**：`pi-task-orientation` 是 `pi-mandatory-skill-resolution` 的继任者。移除旧包后安装新包，`/reload`。两者不能同时运行（都会注册门控工具，冲突）。

**License**：MIT
