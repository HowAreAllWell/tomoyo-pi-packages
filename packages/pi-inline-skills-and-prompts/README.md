# pi-inline-skills-and-prompts

A pi extension that lets you invoke skills and prompts **inline** inside your message, without switching to `/command` input.

## Why

Pi commands (skills, prompts) are normally entered in command mode (starting with `/`). When you're mid-message and realize "this is exactly the job of that skill", you'd have to abandon the line, run the command, and lose context. This extension lets you type `$` anywhere in a message, fuzzy-complete a skill/prompt name, and have it inserted as a command — all without leaving the current line.

## How it works

Registers an autocomplete provider (triggered by `$`) on session start:

1. Typing `$` (at line start or after whitespace) opens a completion list of **skill** and **prompt** commands (`pi.getCommands()` filtered by `source === "skill" | "prompt"`).
2. The list is fuzzy-filtered against `name + description`; empty query shows all of them.
3. Accepting a completion rewrites the current line: it moves the `$token` out of the text and prepends the `/command`, then feeds the rest of the line to that command — e.g. typing `summarize this $code-review` becomes `/code-review summarize this`.
4. Falls back to the default provider when `$` is not being completed, and passes through `shouldTriggerFileCompletion`.

## Install

```bash
pi install npm:pi-inline-skills-and-prompts
```

## Behavior

- Only skills/prompts are offered; slash commands from other sources are left alone.
- No matches → no completion, default behavior untouched.
- Existing completions (files, etc.) are preserved via fallback to the current provider.

## Development

```bash
npx tsc --noEmit --strict --esModuleInterop --skipLibCheck \
  --module nodenext --moduleResolution nodenext --target es2022 \
  extensions/inline-skills-and-prompts.ts
```

## License

MIT

---

## 中文说明

**这是什么**：一个 pi 扩展，让你能在消息正文里**内联**调用 skill 和 prompt，不用切到 `/` 命令模式。输入 `$` 即可模糊补全技能/提示词名，选中的命令会被插入到当前行。

**工作原理**：会话启动时注册一个以 `$` 触发的自动补全提供器：

1. 在行首或空白后输入 `$`，弹出 skill 和 prompt 命令列表（通过 `pi.getCommands()` 按 `source` 过滤）。
2. 列表按「名称 + 描述」模糊过滤；空查询时列出全部。
3. 选中补全后改写当前行：把 `$token` 从正文中取出，在最前面拼上 `/命令`，并把行内剩余文字作为该命令的输入。例如输入 `summarize this $code-review` 会变成 `/code-review summarize this`。
4. 非 `$` 场景回退到默认补全，文件补全（`shouldTriggerFileCompletion`）照常透传。

**安装**：`pi install npm:pi-inline-skills-and-prompts`

**License**：MIT
