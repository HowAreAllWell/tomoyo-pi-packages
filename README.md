# tomoyo-pi-packages

> Pi extensions that actually make a difference — each born from a real pain point, verified in real environments.

一套为 pi（coding agent）打造的高质量扩展集合。每个扩展都源于真实使用中的痛点（技能被跳过、项目规则被忽视、纯文本模型看不到图、命令切换繁琐……），并经过受控实验与真实环境验证。开箱即用，持续扩充。

## ✨ 亮点

| 包 | 特色 | 安装 |
|---|---|---|
| **[pi-vision-bridge](packages/pi-vision-bridge/)** | 为纯文本模型（如 **DeepSeek V4 Flash**）补上图像理解：粘贴进对话框的图片、需要查看的截图，由廉价视觉模型（**MiniMax M3**，走 opencode.go）转成文本描述交给主模型。**零阻塞 · 零污染 · 无重复读取**——提交时后台预取、agent 开始前注入系统提示或引导模型调 `describe_image` 工具，主模型支持图像时自动旁路。 | `pi install npm:pi-vision-bridge-tomoyo` |
| **[pi-task-orientation](packages/pi-task-orientation/)** | 每个请求前强制**两步骤定向**：① 技能评估——模型必须对照技能列表给出匹配项（可多选）或 `["none"]`，且必须附具体理由；② AGENTS.md 规则审查——逐条检查全部规则，始终适用的直接执行，条件式规则不触发时**必须报备跳过项与原因**。把「希望模型自觉」变成「强制、可审计、零成本默认」。 | `pi install npm:pi-task-orientation` |
| **[pi-inline-skills-and-prompts](packages/pi-inline-skills-and-prompts/)** | 消息正文里敲 `$` 即可内联补全技能/提示词命令，选中后自动把整行改写成 `/命令 内容`——写消息写到一半想召唤技能，不用切行、不用切模式。 | `pi install npm:pi-inline-skills-and-prompts` |

## 🎯 为什么值得用

### 所有扩展的通用原则

- **真实痛点驱动**：每个扩展都源自实际使用中踩过的坑，不造轮子、不做"看起来有用"的东西。
- **受控实验验证**：每个设计决策都经过受控实验与真实环境对比（含实测数据），不是拍脑袋。
- **开箱即用、零配置**：`pi install` 即可生效，默认行为合理，必要时可用环境变量调整。

### pi-task-orientation 专属的设计取向

以下原则属于 **pi-task-orientation** 这一个扩展，并非全仓库统一规则：

- **零重复注入**：技能列表与 AGENTS.md 内容都留在系统提示里，扩展只教模型「怎么用」，从不把同一内容塞两遍。
- **决策可审计**：技能选择、规则跳过、理由全部落在工具调用参数里，写入会话历史——事后可查，无法表演。
- **成本感知**：无技能匹配 → `["none"]` + 一行理由；无规则跳过 → 空数组。正常请求零额外开销，不拖慢、不膨胀。
- **不赌模型自觉**：该强制的地方（先评估再干活）用 harness 门控兜底，该判断的地方（选什么技能、哪些规则适用）留给模型——在「强制」和「自主」之间找到平衡。
- **真实环境验证**：含思维链语言、规则遵循率、门控敷衍率的实测数据。

## 📖 deepseek-v4-flash 相关经验

如果你在用 **deepseek-v4-flash**（或同类推理模型），下面这些内容值得一看：

**踩坑记录（主要来自 pi-task-orientation 的实测，详见其 README）：**

- **思维链默认英文**：AGENTS.md 写“思维链用中文”没用（实测约 71% 英文），必须写成祈使式强约束+正反例才生效。
- **技能门控会被敷衍**：强制“先评估再干活”时，模型会传 `"none"` 解锁后照样不评估（实测 18 次调用全 none、0 个技能加载）。
- **条件式规则被静默丢弃**：“改文件就更新 worklog”这类规则会被跳过且无痕迹。
- **指令遵循不稳定 + 自我报告不可信**：同样任务会选错技能、偶尔切语言；模型会声称遵守了但其实没有——要以工具参数为准，不要信叙述。

**另一个事实：deepseek-v4-flash 官方明示 text-only**——任何 API 路径都不接受图像输入。想让它在 pi 里"看图"，方案就是视觉代理桥接：[pi-vision-bridge](packages/pi-vision-bridge/) 帮你把这个桥接做成零阻塞、零污染、无重复读取的体验（详见其 README，含系统提示末尾注入有效性实验）。

## 目录

| 包 | 说明 |
|---|---|
| [pi-vision-bridge](packages/pi-vision-bridge/) | 纯文本模型的视觉桥接：粘贴即理解 + `describe_image` 工具按需读图 |
| [pi-task-orientation](packages/pi-task-orientation/) | 每轮任务两步定向：技能评估 + AGENTS.md 规则审查（取代 pi-mandatory-skill-resolution） |
| [pi-inline-skills-and-prompts](packages/pi-inline-skills-and-prompts/) | 消息正文 `$` 内联补全技能/提示词命令 |

## 安装

```bash
pi install npm:pi-vision-bridge-tomoyo
pi install npm:pi-task-orientation
pi install npm:pi-inline-skills-and-prompts
```

## 开发

```bash
# 类型检查某个子包
cd packages/pi-task-orientation
npx -y -p typescript tsc --noEmit --strict --esModuleInterop --skipLibCheck --moduleResolution bundler --module esnext --target es2022 extensions/*.ts

# pi-vision-bridge 单元测试
cd packages/pi-vision-bridge
node --experimental-strip-types --test test/*.test.ts
```
