# pi-mandatory-skill-resolution

强制模型在调用任何其他工具之前评估并加载 skill 的 pi 扩展。

## 为什么需要它

pi 的 skill 使用**渐进式披露**：system prompt 里只列出 skill 的 name/description/location，完整 SKILL.md 需要模型主动调用 `read` 去读。小模型/快速模型（如 deepseek-v4-flash）经常跳过这一步——从不主动加载 skill，导致 skill 形同虚设。

## 原理

判断权交给模型，强制权交给 harness：

1. 注册自定义工具 `resolve_skill(skillName | "none")`。
2. `tool_call` 门控：模型调用**除 `resolve_skill` 外任何工具**前，必须先调用 `resolve_skill`；否则调用被 block 并返回明确错误。
3. 匹配时 `resolve_skill` 直接返回完整 SKILL.md（模型无法"忘记"加载）；传 `"none"` 则正常继续。
4. 每轮 `before_agent_start` 重置门控 + 注入带描述的技能列表。

## 安装

```bash
# 本地路径
pi install /path/to/tomoyo-pi-packages/packages/pi-mandatory-skill-resolution

# npm（发布后）
pi install npm:pi-mandatory-skill-resolution

# git（发布后）
pi install git:github.com/tomoyo/tomoyo-pi-packages
```

## 行为

- 每轮新请求，模型必须先调 `resolve_skill` 做一次技能评估（语义判断，非关键词匹配）。
- 每轮注入的技能列表：`name — description`，只含**可被模型调用**的 skill（过滤 `disable-model-invocation`）。
- 被禁用的 skill 只能通过 `/skill:name` 显式调用，不参与强制评估。
- 无 skill 可用时（如 `--no-skills`）门控自动关闭。

## 开发

```bash
# 类型检查
npx tsc --noEmit --strict --esModuleInterop --skipLibCheck \
  --module nodenext --moduleResolution nodenext --target es2022 \
  extensions/mandatory-skill-resolution.ts
```

## License

MIT
