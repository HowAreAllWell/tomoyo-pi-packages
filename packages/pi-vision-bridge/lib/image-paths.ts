/**
 * image-paths — 从用户输入文本中提取图片文件路径（自动层用）
 *
 * 接口（Interface）：
 *   extractImagePaths(text) → string[]
 *
 * 保守匹配：只返回"以图片扩展名结尾、且本地文件真实存在、且不是 URL"的路径，
 * 避免误伤普通文本（如代码里的字符串）。支持：
 *   - pi 粘贴产生的 /tmp/pi-clipboard-*.png
 *   - 引号包裹的路径（可含空格，如 macOS 截图 "Screen Shot 2026-01-01.png"）
 *   - 未加引号、不含空格的绝对/相对路径
 *   - ~ 起始路径
 */
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const IMAGE_EXT = "(?:png|jpe?g|gif|webp|bmp)";

/** 引号包裹的路径（允许中间有空格） */
const QUOTED_PATH = new RegExp(`["']([^"']+?\\.${IMAGE_EXT})["']`, "gi");

/** 未加引号的路径 token（不允许空格；前后分隔符含中英文冒号，兼容中文输入） */
const BARE_PATH = new RegExp(
  `(^|[\\s,;=:\uff1a\\(\\[\\{])` +
    `([^\\s"'<>,;=:\uff1a\\(\\)\\[\\]\\{\\}]+?\\.${IMAGE_EXT})` +
    `(?=[\\s,;:\uff1a\\)\\]\\}\\.]|$)`,
  "gi",
);

export function extractImagePaths(text: string): string[] {
  const candidates = new Set<string>();

  for (const m of text.matchAll(QUOTED_PATH)) {
    candidates.add(m[1]!);
  }
  for (const m of text.matchAll(BARE_PATH)) {
    candidates.add(m[2]!);
  }

  const found: string[] = [];
  for (const candidate of candidates) {
    if (isRemoteOrDataUrl(candidate)) continue;
    const expanded = expandTilde(candidate);
    if (isReadableFile(expanded)) {
      found.push(candidate);
    }
  }
  return found;
}

function isRemoteOrDataUrl(path: string): boolean {
  return /^(?:https?:|data:|file:)/i.test(path);
}

function expandTilde(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
