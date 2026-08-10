/**
 * image-paths 模块测试。
 * 运行：node --experimental-strip-types --test test/*.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { extractImagePaths } from "../lib/image-paths.ts";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "image-paths-test-"));
  writeFileSync(join(dir, "shot.png"), "x");
  writeFileSync(join(dir, "with space.png"), "x");
  writeFileSync(join(dir, "chart.jpg"), "x");
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("提取绝对路径的图片", () => {
  const p = join(dir, "shot.png");
  assert.deepEqual(extractImagePaths(`看看这张图：${p}`), [p]);
});

test("提取引号包裹、含空格的路径", () => {
  const p = join(dir, "with space.png");
  assert.deepEqual(extractImagePaths(`看图 "${p}" 的内容`), [p]);
});

test("提取 ~ 起始的路径", () => {
  const p = join(process.env.HOME ?? "", "test-home.png");
  writeFileSync(p, "x");
  try {
    const result = extractImagePaths(`看图 ~/test-home.png`);
    assert.deepEqual(result, ["~/test-home.png"]);
  } finally {
    rmSync(p, { force: true });
  }
});

test("排除 URL", () => {
  assert.deepEqual(extractImagePaths("https://example.com/a.png 参考"), []);
});

test("排除不存在的文件", () => {
  assert.deepEqual(extractImagePaths("/tmp/definitely-missing-12345.png"), []);
});

test("普通文本不误触发", () => {
  assert.deepEqual(extractImagePaths("请解释一下 closure 的概念"), []);
  assert.deepEqual(extractImagePaths("代码里的字符串 'logo.png' 不算"), []);
});

test("同时提取多张图片并去重", () => {
  const p1 = join(dir, "shot.png");
  const p2 = join(dir, "chart.jpg");
  const text = `图一 ${p1} 图二 ${p2} 再看一次 ${p1}`;
  const result = extractImagePaths(text);
  assert.deepEqual(result.sort(), [p1, p2].sort());
});
