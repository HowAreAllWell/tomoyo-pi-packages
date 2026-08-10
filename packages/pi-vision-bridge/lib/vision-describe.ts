/**
 * vision-describe — 视觉引擎深模块
 *
 * 把图片文件描述为文本，供纯文本主模型（如 DeepSeek V4 Flash）"看图"。
 *
 * 接口（Interface）：
 *   describeImage(path, options?) → Promise<DescribeResult>
 *   createVisionCache() → VisionCache
 *
 * 调用方只需知道：给一个图片路径 + 可选问题，得到描述文本或明确的失败原因。
 * 内部隐藏：读文件、MIME 识别、大小检查、内容哈希缓存、HTTP 调用、
 *           think 块剥离、超时、失败降级。
 *
 * 本模块不依赖 pi 的任何 API，是纯逻辑模块；HTTP 端点和 key 可注入，
 * 便于跨 seam 测试（本地 stub server）。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MODEL = "minimax-m3";
const DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"] as const;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const DEFAULT_PROMPT =
  "Describe this image in detail for a text-only AI that cannot see it. " +
  "Transcribe ALL visible text accurately (exact wording, numbers, filenames, " +
  "line numbers, error messages). Describe layout regions, colors, shapes, UI " +
  "elements, and any status/state. Be precise and structured.";

export interface DescribeImageOptions {
  /** 视觉模型 id，默认 minimax-m3 */
  model?: string;
  /** OpenAI 兼容 base url，默认 opencode-go */
  baseUrl?: string;
  /** API key，默认从 ~/.pi/agent/auth.json 读 opencode-go */
  apiKey?: string;
  /** 单次调用超时 ms，默认 60000 */
  timeoutMs?: number;
  /** 图片字节上限，默认 10MB */
  maxBytes?: number;
  /** 可选的具体问题（如"这个按钮什么颜色""报错内容是什么"） */
  question?: string;
  signal?: AbortSignal;
}

export type DescribeResult =
  | { ok: true; description: string; fromCache: boolean }
  | { ok: false; error: string };

/** 描述缓存：同一图片内容只调一次视觉模型 */
export interface VisionCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

export function createVisionCache(): VisionCache {
  const store = new Map<string, string>();
  return {
    get(key) {
      return store.get(key);
    },
    set(key, value) {
      store.set(key, value);
    },
  };
}

/** 模块级默认缓存：同一进程内共享（自动层与工具层共用，避免重复调用） */
const defaultCache = createVisionCache();

/** 内部可注入项（供测试与替换），不属于对外接口 */
export interface VisionDescribeInternals {
  cache?: VisionCache;
}

export async function describeImage(
  path: string,
  options: DescribeImageOptions = {},
  internals: VisionDescribeInternals = {},
): Promise<DescribeResult> {
  try {
    const ext = extensionOf(path);
    if (!ext) {
      return { ok: false, error: `Not a recognized image file: ${path}` };
    }

    const fileStat = await stat(path);
    if (!fileStat.isFile()) {
      return { ok: false, error: `Not a file: ${path}` };
    }
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (fileStat.size > maxBytes) {
      return {
        ok: false,
        error: `Image too large: ${fileStat.size} bytes (limit ${maxBytes})`,
      };
    }

    const bytes = await readFile(path);
    const hash = createHash("sha1").update(bytes).digest("hex");
    const cache = internals.cache ?? defaultCache;
    const cached = cache.get(hash);
    if (cached !== undefined) {
      return { ok: true, description: cached, fromCache: true };
    }

    const description = await callVisionApi(bytes, MIME_BY_EXT[ext], options);
    cache.set(hash, description);
    return { ok: true, description, fromCache: false };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 同步读取某图片的已缓存描述（未描述过或未命中返回 undefined）。
 * 不发起任何外部调用，用于“零阻塞”场景：预取完成后调用方可立即拿到描述。
 */
export function peekDescribe(path: string, internals: VisionDescribeInternals = {}): string | undefined {
  const cache = internals.cache ?? defaultCache;
  let hash: string;
  try {
    hash = createHash("sha1").update(readFileSync(path)).digest("hex");
  } catch {
    return undefined;
  }
  return cache.get(hash);
}

// ============================================================================
// 实现内部（不属于对外接口，可自由替换）
// ============================================================================

function extensionOf(path: string): string | undefined {
  const lower = path.toLowerCase();
  for (const ext of IMAGE_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext;
  }
  return undefined;
}

async function callVisionApi(
  bytes: Uint8Array,
  mimeType: string,
  options: DescribeImageOptions,
): Promise<string> {
  const baseUrl = options.baseUrl ?? process.env.PI_VISION_BASE_URL ?? DEFAULT_BASE_URL;
  const model = options.model ?? process.env.PI_VISION_MODEL ?? DEFAULT_MODEL;
  const apiKey = options.apiKey ?? (await resolveApiKey());
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  const text = options.question ?? DEFAULT_PROMPT;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Vision request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener("abort", () => controller.abort(options.signal?.reason), { once: true });
  }

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 800,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Vision API ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data?.choices?.[0]?.message?.content ?? "";
    const cleaned = stripThinkBlocks(content);
    if (!cleaned) {
      throw new Error("Vision API returned an empty description");
    }
    return cleaned;
  } finally {
    clearTimeout(timer);
  }
}

/** 剥离 MiniMax 等模型返回的 <think>…</think> 推理块 */
function stripThinkBlocks(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function resolveApiKey(): Promise<string> {
  const fromEnv = process.env.PI_VISION_API_KEY;
  if (fromEnv) return fromEnv;

  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const authPath = join(agentDir, "auth.json");
  try {
    const raw = await readFile(authPath, "utf8");
    const data = JSON.parse(raw) as Record<string, { key?: string } | undefined>;
    const key = data?.["opencode-go"]?.key;
    if (typeof key === "string" && key.length > 0) return key;
  } catch {
    // fall through to error
  }
  throw new Error(
    "Cannot resolve vision API key. Set PI_VISION_API_KEY or provide apiKey, " +
      "or ensure ~/.pi/agent/auth.json has opencode-go.key.",
  );
}
