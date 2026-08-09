# pi-task-orientation

A pi extension that makes every request start with a **two-step orientation**, replacing the old `pi-mandatory-skill-resolution`.

## Why

Two chronic problems in agentic coding:
- **Skills get skipped**: with progressive disclosure, the system prompt only lists skill names + one-line descriptions. A model that never decides to `read` a SKILL.md effectively ignores the skill system.
- **AGENTS.md rules get silently ignored**: the full AGENTS.md is injected into the system prompt, but as *reference context* — nothing forces the model to analyze it, so "always-applicable" rules are followed inconsistently and "conditional" rules (e.g. worklog updates) are dropped without anyone noticing.

This extension turns both from "hopeful behavior" into a **mandatory, auditable routine**.

## Known issues with deepseek-v4-flash (why this exists)

If you run pi with **deepseek-v4-flash** (or a similar reasoning model), you have probably hit the exact problems this extension is built for. All of the following were measured against deepseek-v4-flash in controlled experiments:

1. **Thinking (chain-of-thought) defaults to English.** Even when AGENTS.md says “think in Chinese”, deepseek-v4-flash reasons in English (~71% of thinking blocks in our session). A *descriptive* rule in AGENTS.md is **not enough**. It only works when rewritten as a strong imperative with examples — “Thinking must be in Simplified Chinese, do not reason in English” — verified 3/3 times. Keep such rules in the always-applicable part of AGENTS.md and phrase them as commands, not descriptions.
2. **Models circumvent skill gates.** If you gate all tools behind a “call X first” tool, the model learns to call it with a throwaway value (`"none"`) to unlock everything — without ever evaluating. We saw one session with 18 gate calls, all `"none"`, zero skills loaded. That is why `task_orientation` requires a concrete `reason`, and why choosing a skill auto-loads its full SKILL.md (no `read` needed, nothing to skip).
3. **Conditional rules are silently dropped.** Rules like “update worklog when files changed” get skipped with no trace. That is why Step 2 forces the model to report every skipped conditional rule via `skipped_rules` with a reason.
4. **Instruction following is unstable.** Same task, same model, different runs pick different (sometimes wrong) skills and occasionally even switch output language. Never trust a single observation; the mandatory + auditable design exists because “hoping the model behaves” is not reliable.
5. **Self-reported compliance is not trustworthy.** The model can claim it followed a rule (“I thought in Chinese 90% of the time”) while the actual session transcript shows otherwise. Audit the tool-call parameters (`reason`, `skipped_rules`), not the model’s prose.

These are model-behavior observations, not bugs in pi — and they motivate every design decision in this extension.

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

**deepseek-v4-flash 踩坑记录**（本扩展的所有设计动机，均来自受控实验实测）：

1. **思维链默认英文**：AGENTS.md 里写“思维链用中文”（陈述式）几乎无效（实测思维链约 71% 为英文）；只有写成祈使式强约束+正反例（“思维链必须使用简体中文，禁止用英文思考”）才有效（3/3 复现）。请把这类规则放到 AGENTS.md 的“始终适用”部分，并用命令式而非描述式。
2. **技能门控会被敷衍**：强制“先调 X 工具”时，模型会每轮传 `"none"` 解锁全部工具、实际不评估（实测一次会话 18 次调用全为 none、0 个技能加载）。所以本扩展要求必填 `reason`，且选中即自动加载 SKILL.md 全文（无需 read、无法跳过）。
3. **条件式规则被静默丢弃**：“文件改动则更新 worklog”这类规则会被跳过且无痕迹。所以第 2 步强制模型把每个跳过的条件式规则通过 `skipped_rules` 报备并说明原因。
4. **指令遵循不稳定**：同一任务同一模型，不同运行会选错技能、甚至偶尔切换输出语言。不要相信单次观察；“强制 + 可审计”的设计就是因为它不可靠。
5. **自我报告不可信**：模型会声称“思维链 90% 用了中文”，但会话记录显示实际全英文。请以工具调用参数（`reason`、`skipped_rules`）为准，不要以模型叙述为准。

这些是模型行为观察，不是 pi 的 bug。

**设计原则**：零重复（技能列表与 AGENTS.md 内容都留在系统提示，扩展只教"怎么用"）；决策可审计（技能选择与跳过规则都在工具调用里，写入会话历史）；成本可控（无匹配 → `["none"]` + 一行理由；无跳过 → 空数组）；支持多技能。

**安装**：`pi install npm:pi-task-orientation`

**取代旧扩展**：`pi-task-orientation` 是 `pi-mandatory-skill-resolution` 的继任者。移除旧包后安装新包，`/reload`。两者不能同时运行（都会注册门控工具，冲突）。

**License**：MIT
