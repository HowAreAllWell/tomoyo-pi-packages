# pi-mandatory-skill-resolution

A pi extension that forces the model to assess and load skills **before** using any other tool.

## Why

Pi's skills use **progressive disclosure**: the system prompt only lists each skill's name/description/location, and the model is expected to call `read` on the SKILL.md itself. Small/fast models (e.g. deepseek-v4-flash) frequently skip that step — they never load the skill, so skills end up unused.

## How it works

Judgment stays with the model (semantic understanding); enforcement stays with the harness (cannot be skipped).

1. Registers a custom tool `resolve_skill(skillName | "none")`.
2. A `tool_call` gate blocks **every other tool** (read, bash, edit, write, subagent, web_search, ...) until `resolve_skill` has been called this turn. Blocked calls come back as tool errors, so the model is forced to comply.
3. On a match, `resolve_skill` returns the full SKILL.md inline — the model cannot "forget" to load it.
4. Each turn, `before_agent_start` resets the gate and injects the skill list (`name — description`) into the conversation.

## Install

```bash
pi install npm:pi-mandatory-skill-resolution
```

## Behavior

- Every new request requires a `resolve_skill` call first (semantic judgment, not keyword matching).
- The injected skill list only includes skills the model is allowed to invoke: skills marked `disable-model-invocation: true` are filtered out (matching pi's own `formatSkillsForPrompt` filter) and remain usable only via `/skill:name`.
- When no skills are available (e.g. `--no-skills`), the gate is disabled automatically.

## Development

```bash
npx tsc --noEmit --strict --esModuleInterop --skipLibCheck \
  --module nodenext --moduleResolution nodenext --target es2022 \
  extensions/mandatory-skill-resolution.ts
```

## License

MIT

---

## 中文说明

**这是什么**：一个 pi 扩展，强制模型在调用任何其他工具之前评估并加载 skill。解决小/快速模型（如 deepseek-v4-flash）跳过 skill 加载的问题——pi 的 skill 采用渐进式披露，完整 SKILL.md 需要模型主动 `read`，而小模型常常直接跳过，导致 skill 形同虚设。

**工作原理**：判断权交给模型（语义判断），强制权交给 harness（无法跳过）。注册 `resolve_skill(skillName | "none")` 工具，并用 `tool_call` 门控拦截其他所有工具——本轮未调用 `resolve_skill` 前，read/bash/edit/write/subagent 等一律被 block 并返回明确错误；匹配时直接返回完整 SKILL.md，模型无法"忘记"加载。

**安装**：`pi install npm:pi-mandatory-skill-resolution`

**细节**：
- 每轮新请求都要求先调 `resolve_skill` 做技能评估。
- 技能列表只含模型可自动调用的技能（`disable-model-invocation: true` 的被过滤，只能通过 `/skill:name` 显式调用）。
- 无 skill 可用时（如 `--no-skills`）门控自动关闭。
