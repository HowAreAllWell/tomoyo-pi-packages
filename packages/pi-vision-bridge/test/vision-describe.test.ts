/**
 * vision-describe 深模块测试 —— 跨 seam 注入本地 stub server 验证。
 * 运行：node --experimental-strip-types --test test/*.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import {
  createVisionCache,
  describeImage,
  peekDescribe,
  type DescribeImageOptions,
} from "../lib/vision-describe.ts";

/** 最小合法 1x1 PNG */
const MINI_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface StubState {
  hits: number;
  lastBody: unknown;
}

function startStub(response: unknown, status = 200, delayMs = 0): Promise<{ server: Server; url: string; state: StubState }> {
  const state: StubState = { hits: 0, lastBody: undefined };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      state.hits += 1;
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          state.lastBody = JSON.parse(raw);
        } catch {
          state.lastBody = raw;
        }
        setTimeout(() => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(response));
        }, delayMs);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, url: `http://127.0.0.1:${(addr as { port: number }).port}/v1`, state });
    });
  });
}

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "vision-describe-test-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeImage(name: string, bytes: Buffer = MINI_PNG): string {
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}

function baseOptions(url: string): DescribeImageOptions {
  return { baseUrl: url, apiKey: "test-key", model: "test-model" };
}

function freshInternals() {
  return { cache: createVisionCache() };
}

const okResponse = {
  choices: [{ message: { content: "<think>reasoning…</think>\nThe image shows a red button labeled Save." } }],
};

test("成功：返回描述并剥离 think 块", async () => {
  const { server, url, state } = await startStub(okResponse);
  try {
    const img = writeImage("ok.png");
    const result = await describeImage(img, baseOptions(url), freshInternals());
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.description, "The image shows a red button labeled Save.");
      assert.equal(result.fromCache, false);
    }
    assert.equal(state.hits, 1);
  } finally {
    server.close();
  }
});

test("缓存命中：同图第二次不调用视觉 API", async () => {
  const { server, url, state } = await startStub(okResponse);
  try {
    const img = writeImage("cached.png");
    const cache = createVisionCache();
    const first = await describeImage(img, baseOptions(url), { cache });
    const second = await describeImage(img, baseOptions(url), { cache });
    assert.equal(first.ok && second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(second.fromCache, true);
      assert.equal(second.description, first.description);
    }
    assert.equal(state.hits, 1); // 只调了一次
  } finally {
    server.close();
  }
});

test("失败降级：视觉 API 返回 500 时得到 ok:false 而非抛异常", async () => {
  const { server, url } = await startStub({ error: "boom" }, 500);
  try {
    const img = writeImage("err500.png");
    const result = await describeImage(img, baseOptions(url), freshInternals());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /Vision API 500/);
  } finally {
    server.close();
  }
});

test("失败降级：视觉 API 返回空描述", async () => {
  const { server, url } = await startStub({ choices: [{ message: { content: "<think>only thinking</think>" } }] });
  try {
    const img = writeImage("empty.png");
    const result = await describeImage(img, baseOptions(url), freshInternals());
    assert.equal(result.ok, false);
  } finally {
    server.close();
  }
});

test("失败降级：文件不存在", async () => {
  const result = await describeImage(join(dir, "missing.png"), { baseUrl: "http://127.0.0.1:1", apiKey: "k" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /ENOENT/);
});

test("失败降级：非图片扩展名", async () => {
  const p = join(dir, "notes.txt");
  writeFileSync(p, "hello");
  const result = await describeImage(p, { baseUrl: "http://127.0.0.1:1", apiKey: "k" });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /Not a recognized image file/);
});

test("失败降级：超过 maxBytes 限制", async () => {
  const { server, url, state } = await startStub(okResponse);
  try {
    const img = writeImage("big.png");
    const result = await describeImage(img, { ...baseOptions(url), maxBytes: 4 }, freshInternals());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /too large/);
    assert.equal(state.hits, 0); // 未调用视觉 API
  } finally {
    server.close();
  }
});

test("超时降级：调用超过 timeoutMs 被中止并返回 ok:false", async () => {
  const { server, url } = await startStub(okResponse, 200, 300);
  try {
    const img = writeImage("slow.png");
    const result = await describeImage(img, { ...baseOptions(url), timeoutMs: 100 }, freshInternals());
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /timed out/);
  } finally {
    server.close();
  }
});

test("question 透传：请求体包含自定义问题", async () => {
  const { server, url, state } = await startStub(okResponse);
  try {
    const img = writeImage("question.png");
    await describeImage(img, { ...baseOptions(url), question: "What color is the button?" }, freshInternals());
    const content = (state.lastBody as { messages: Array<{ content: Array<{ type: string; text?: string }> }> })
      .messages[0].content;
    assert.equal(content[0]?.text, "What color is the button?");
    assert.equal(content[1]?.type, "image_url");
  } finally {
    server.close();
  }
});

test("peekDescribe：描述后同步命中缓存，未描述返回 undefined", async () => {
  const { server, url } = await startStub(okResponse);
  try {
    const img = writeImage("peek.png");
    const cache = createVisionCache();
    // 未描述时 peek 返回 undefined
    assert.equal(peekDescribe(img, { cache }), undefined);
    await describeImage(img, baseOptions(url), { cache });
    // 描述后 peek 命中
    const hit = peekDescribe(img, { cache });
    assert.ok(hit !== undefined);
    assert.ok(hit!.includes("red button labeled Save"));
  } finally {
    server.close();
  }
});

test("peekDescribe：文件不存在返回 undefined（不抛异常）", () => {
  assert.equal(peekDescribe(join(dir, "no-such-file.png")), undefined);
});
