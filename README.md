# tomoyo-pi-packages

个人维护的 pi 工具 monorepo。只收录**可独立发布**的 pi 资源：extensions / skills / prompts / themes。每个工具一个子包，位于 `packages/` 下。

## 收录原则

- 只收可独立安装、独立发布的工具（有明确边界、可测试、别人能直接用）。
- 调研笔记、踩坑记录、过程性内容**不收**进本仓库（放个人笔记/博客）。
- 每个子包必须：可 `pi install`、有 README（用途/原理/安装/行为）、有 LICENSE、通过类型检查。

## 目录

| 包 | 说明 | 安装 |
|---|---|---|
| ~~[pi-mandatory-skill-resolution](packages/pi-mandatory-skill-resolution/)~~ | 已被 pi-task-orientation 取代（旧版单技能评估，无 AGENTS.md 规则分析） | — |
| [pi-task-orientation](packages/pi-task-orientation/) | 每轮任务开始前两步定向：强制技能评估（多选/理由）+ 逐条分析 AGENTS.md 规则（跳过项+原因传回工具参数）。取代 pi-mandatory-skill-resolution | `pi install npm:pi-task-orientation` |
| [pi-inline-skills-and-prompts](packages/pi-inline-skills-and-prompts/) | 消息正文内联 `$` 补全并插入 skill / prompt 命令，不用切到 `/` 命令模式 | `pi install npm:pi-inline-skills-and-prompts` |

## 开发

```bash
# 类型检查某个子包
cd packages/pi-mandatory-skill-resolution
npx tsc --noEmit --strict --esModuleInterop --skipLibCheck \
  --module nodenext --moduleResolution nodenext --target es2022 \
  extensions/mandatory-skill-resolution.ts

# 本地安装验证
pi install ./packages/pi-task-orientation
```

## 发布

每个子包独立 `npm publish`（包名需唯一）。发布后自动出现在 [pi.dev/packages](https://pi.dev/packages)（要求 `keywords` 含 `pi-package`，本仓库子包均已声明）。

```bash
cd packages/<tool>
npm login
npm publish --access public
```

## License

MIT（见各子包 LICENSE）
