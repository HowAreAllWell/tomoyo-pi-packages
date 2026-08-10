/**
 * pi-vision-bridge — 为纯文本主模型（如 DeepSeek V4 Flash）补视觉能力
 *
 * 设计目标（零阻塞 · 零污染 · 无重复读取）：
 *  1. input hook：检测到图片路径后，立即返回原消息（不阻塞提交、不注入任何
 *     内容），同时在后台启动视觉描述预取（fire-and-forget，填充缓存）。
 *  2. before_agent_start（用户消息已显示、agent 开始前）：同步读缓存——
 *     · 命中：把图片描述注入 system prompt（不显示在用户消息里），并明确
 *       告知模型"已描述，无需重复调用 describe_image"；
 *     · 未命中：注入一行引导（提示模型调用 describe_image 工具），继续后台预取，
 *       模型调用工具时大概率缓存命中、快速返回。
 *  3. 工具层：describe_image 工具，模型按需精细看图（缓存命中时零成本）。
 *
 * capability-aware：主模型 input 含 "image" 时全部旁路（图像可直传，无需桥接）。
 *
 * 视觉引擎：默认 MiniMax M3（opencode-go chat/completions），可通过环境变量覆盖：
 *   PI_VISION_MODEL / PI_VISION_BASE_URL / PI_VISION_API_KEY / PI_VISION_AUTO_DESCRIBE
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { describeImage, peekDescribe } from "../lib/vision-describe.ts";
import { extractImagePaths } from "../lib/image-paths.ts";

const DESCRIBE_PARAMS = Type.Object({
  path: Type.String({
    description:
      "Absolute or relative path to the image/screenshot file (png, jpg, gif, webp, bmp).",
  }),
  question: Type.Optional(
    Type.String({
      description:
        "Optional specific question about the image (e.g. what color is the button, what does the error say, what are the chart values).",
    }),
  ),
});

export default function (pi: ExtensionAPI): void {
  // ------------------------------------------------------------------
  // 工具层：describe_image —— 模型按需读截图/图片
  // ------------------------------------------------------------------
  pi.registerTool({
    name: "describe_image",
    label: "Describe Image",
    description:
      "Describe the content of an image/screenshot file as text, for models that " +
      "cannot receive image input directly (e.g. DeepSeek V4 Flash). Use when the " +
      "user pasted an image, shared a screenshot, or you need to understand visual " +
      "content (error dialogs, UI layouts, charts, diagrams). If the image content " +
      "has already been described in the system prompt, do not call this again. " +
      "Pass an optional question to focus the description.",
    parameters: DESCRIBE_PARAMS,
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      if (isVisionCapable(ctx)) {
        return {
          content: [
            {
              type: "text",
              text: "The current model supports image input directly; read the image file instead of describing it.",
            },
          ],
          details: { tool: "describe_image", skipped: true },
        };
      }
      const result = await describeImage(params.path, {
        question: params.question,
        signal,
      });
      return {
        content: [{ type: "text", text: formatDescribeResult(result) }],
        details: { tool: "describe_image" },
      };
    },
  });

  // ------------------------------------------------------------------
  // 自动层·input hook：不阻塞、不注入；仅后台预取描述
  // ------------------------------------------------------------------
  pi.on("input", (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" };
    }
    if (process.env.PI_VISION_AUTO_DESCRIBE === "0") {
      return { action: "continue" };
    }
    if (isVisionCapable(ctx)) {
      return { action: "continue" };
    }
    const paths = extractImagePaths(event.text);
    if (paths.length === 0) {
      return { action: "continue" };
    }
    // fire-and-forget：后台预取描述填充缓存；describeImage 内部吞掉所有异常
    void prewarm(paths);
    // 用户消息原样发送（零污染、零阻塞）
    return { action: "continue" };
  });

  // ------------------------------------------------------------------
  // 自动层·before_agent_start：把（已就绪的）描述注入 system prompt
  // ------------------------------------------------------------------
  pi.on("before_agent_start", (event, ctx) => {
    if (process.env.PI_VISION_AUTO_DESCRIBE === "0") {
      return {};
    }
    if (isVisionCapable(ctx)) {
      return {};
    }
    const paths = extractImagePaths(event.prompt);
    if (paths.length === 0) {
      return {};
    }

    const blocks: string[] = [];
    for (const p of paths) {
      const cached = peekDescribe(p);
      if (cached !== undefined) {
        blocks.push(
          `[Vision bridge] The user message includes the image ${p}. Its content has ` +
            `already been described by a vision model as follows — base your answer on ` +
            `this, and do NOT call describe_image for it again:\n${cached}`,
        );
      } else {
        blocks.push(
          `[Vision bridge] The user message includes the image ${p}. The current model ` +
            `cannot receive image input, so call the describe_image tool (parameter ` +
            `path="${p}") to get its content.`,
        );
        // 后台继续预取：模型调用工具时大概率命中缓存、快速返回
        void describeImage(p);
      }
    }

    return { systemPrompt: `${event.systemPrompt}\n\n${blocks.join("\n\n")}` };
  });
}

// ============================================================================
// 内部辅助
// ============================================================================

type ModelLike = { input?: readonly string[] } | undefined;

function isVisionCapable(ctx: { model?: ModelLike }): boolean {
  return ctx.model?.input?.includes("image") ?? false;
}

function prewarm(paths: string[]): void {
  for (const p of paths) {
    void describeImage(p);
  }
}

function formatDescribeResult(
  result: { ok: true; description: string } | { ok: false; error: string },
): string {
  if (result.ok) {
    return `[Image: ${result.description}]`;
  }
  return `[Image description unavailable: ${result.error}]`;
}
