# pi-vision-bridge-tomoyo

Give your **text-only model** (e.g. **DeepSeek V4 Flash**) real image understanding: images pasted into the chat and screenshots are described by a cheap vision model (default **MiniMax M3** via opencode.go) and fed to the main model as text.

Zero-blocking · zero-clutter · no redundant reads.

## Why

DeepSeek V4 Flash is officially text-only — no API path accepts image input. The industry-standard workaround (and the one DeepSeek's own Copilot integration recommends) is **vision-agent bridging**: route the image to a vision model, get a text description back, and hand the description to the text model.

This extension automates that bridge inside pi, tuned for good UX: no frozen UI on send, no giant transcripts polluting the chat, no double-reads by the model.

## How it works

Three cooperating layers, all sharing one vision engine and one content-hash cache:

1. **`input` hook — non-blocking prefetch.** When a message contains an image path, the extension immediately returns the message untouched (zero wait, zero injection) and kicks off a background vision description (fire-and-forget) that fills the cache.
2. **`before_agent_start` — inject or guide, zero block.** After your message is displayed and before the agent starts thinking, the extension synchronously reads the cache:
   - **cache hit** → the description is appended to this turn's **system prompt** (invisible in the chat UI), with an explicit note telling the model "already described — do NOT call describe_image again";
   - **cache miss** → a one-line guide is appended instead ("call `describe_image` to view this image"), while prefetch keeps running so the tool call will likely hit the cache.
3. **Tool layer — `describe_image(path, question?)`.** The model can call it on demand for fine-grained reading (error dialogs, UI, charts), optionally with a specific question. Cache hits return instantly.

**capability-aware**: if the main model already supports images (`model.input` includes `image`), every layer is bypassed — zero overhead, zero interference.

## Why not just "let the model call the tool itself"?

The model calling `describe_image` on its own **is** the primary path (and the guided path above is exactly that). But making it the *only* path would gamble the core feature on the model's initiative:

- Some models treat a pasted image path as a "suggestion" rather than an instruction and silently hallucinate the image content (pi issue #6373, #3429/#3110).
- The prefetch + injection layer guarantees the description is available to the model even when it never decides to call the tool — at **no extra cost**, because the cache makes a later tool call free.

So: **model autonomy first, deterministic fallback second, zero redundant cost.**

## Install

```bash
pi install npm:pi-vision-bridge-tomoyo
```

Requires an opencode.go subscription (`opencode-go.key` in `~/.pi/agent/auth.json`, or set `PI_VISION_API_KEY`).

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `PI_VISION_MODEL` | `minimax-m3` | Vision model id (any image-capable model on opencode.go, e.g. `mimo-v2.5`, `gpt-5.6-luna`) |
| `PI_VISION_BASE_URL` | `https://opencode.ai/zen/go/v1` | OpenAI-compatible endpoint |
| `PI_VISION_API_KEY` | read from auth.json | API key |
| `PI_VISION_AUTO_DESCRIBE` | `1` | Set `0` to disable the automatic layers (keep only the `describe_image` tool) |

## Model selection

Screened by cost × quality experiments against opencode.go pricing:

- **Default `minimax-m3`** ($0.30/$1.20 per 1M tokens): highest measured quality, low latency (~8s).
- **Budget `mimo-v2.5`** ($0.14/$0.28): nearly as good at half the price.
- Avoid `grok-4.5`, `kimi-k3`, `qwen3.8-max` (too expensive) and `glm-5.2` (accepts images but is actually text-only — a "fake accept").

## Verified

- 18 unit tests (cache hit, API failure fallback, timeout abort, oversized rejection, question passthrough, path extraction incl. Chinese full-width colon).
- Real end-to-end: a pasted screenshot of a build error is transcribed by MiniMax M3 and DeepSeek V4 Flash answers the error, file and line correctly.
- System-prompt-tail injection is actually read: with a ~1.1k-token system prompt and the description at the very end, DeepSeek V4 Flash reproduced all key facts from the description; without it, it honestly admitted it cannot see the image.
- Coexists with `pi-task-orientation`: in a live run the model first completes skill assessment, then calls `describe_image` — no deadlock, no interference.

## Development

```bash
# unit tests
node --experimental-strip-types --test test/*.test.ts

# type check
npx -y typescript tsc --noEmit -p tsconfig.check.json
```

## License

MIT

---

## 中文说明

为纯文本主模型（如 DeepSeek V4 Flash）补图像理解能力：粘贴进对话框的图片、以及模型需要查看的截图，都由一个廉价视觉模型（默认 MiniMax M3，走 opencode.go）转成文本描述后交给主模型。

**零阻塞 · 零污染 · 无重复读取**：

- 提交消息时后台预取图片描述（不卡界面、不往消息里塞内容）；
- agent 开始前把已就绪的描述注入系统提示（对话里不可见），未就绪则引导模型调用 `describe_image` 工具；
- 同一图片只描述一次（内容哈希缓存，自动层与工具层共享）。

主模型本身支持图像时自动旁路。视觉引擎默认 MiniMax M3，可用 `PI_VISION_MODEL` 切换（`mimo-v2.5` 更省钱）。
