/**
 * Task Orientation Extension
 *
 * 每轮任务开始前，强制模型完成两步骤定向：
 *
 *   第 1 步 · 技能评估（强制第一步）
 *   模型对照 system prompt 中的 <available_skills> 列表（渐进式披露，只有
 *   名 + 描述 + 路径），判断本次请求匹配哪些技能——可能一个都不匹配，也
 *   可能同时匹配多个。调用 task_orientation({ skills: [...], reason })：
 *   - 匹配一个或多个 → 扩展直接把对应 SKILL.md 全文注入上下文（模型无需
 *     自己 read，也无法跳过）
 *   - 不匹配 → task_orientation({ skills: ["none"], reason })，reason 必须具体
 *   所有其他工具被 tool_call 门控拦截，直到本轮完成评估。
 *
 *   第 2 步 · 项目规则分析（仅当项目存在 AGENTS.md 时注入）
 *   AGENTS.md 全文已在 system prompt 的 <project_context> 中。模型被指示
 *   区分"始终适用的规则"与"条件触发的规则"：前者直接应用，后者判断本轮
 *   是否触发条件。指令只教方法、不复述规则内容（AGENTS.md 永远只有一份）。
 *
 * 设计要点：
 *   - 不重复注入技能列表（pi 核心已在 system prompt 提供 <available_skills>）
 *   - 多技能支持：skills 是数组，一轮可加载多个 SKILL.md
 *   - reason 必填但"轻选重不选"：选技能时简短说明覆盖范围；none 时必须
 *     具体说明任务类型与不匹配原因（防"机械敷衍 none"）
 *   - 动态检测：contextFiles 有 AGENTS.md 才注入第 2 步
 *   - 决策留模型、执行归 harness：判断靠模型语义理解，加载/门控靠扩展保证
 *
 * 放置：~/.pi/agent/extensions/（/reload 可热加载）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** skill name -> { filePath, description }，从 systemPromptOptions.skills 惰性构建 */
const skillPaths = new Map<string, { filePath: string; description: string }>();

/** 本轮是否已完成技能评估 */
let skillResolved = false;

/** 门控放行的路由工具本身 */
const ROUTER_TOOL = "task_orientation";

// ---------------------------------------------------------------------------
// 注入文本（英文，与扩展其他文本一致）
// ---------------------------------------------------------------------------

const STEP1_SKILL_ASSESSMENT = [
	"## Task orientation (do not skip — applies to every new request)",
	"",
	"Step 1 · Skill assessment (mandatory first step):",
	"Check the <available_skills> list in the system prompt and decide which skills this request matches — it may match none, or several at once.",
	"- Match one or more -> call task_orientation with their names; the full skill files will be loaded and are mandatory for the rest of this task.",
	"- Match none -> call task_orientation with [\"none\"], and give a concrete reason in the reason parameter.",
	"",
].join("\n");

const STEP2_RULE_ANALYSIS = [
	"Step 2 · Project rule analysis:",
	"The full AGENTS.md content is already in <project_context> in the system prompt.",
	"Check EVERY rule in it, one by one, and classify:",
	"- Always-applicable rules -> apply them to this task directly.",
	"- Conditional rules -> if this task meets the condition, follow them; if not, do NOT silently ignore them: pass them to task_orientation's skipped_rules parameter with a reason.",
	"Pass an empty array if nothing was skipped.",
	"",
].join("\n");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refreshSkillIndex(
	skills: Array<{
		name: string;
		filePath: string;
		description?: string;
		disableModelInvocation?: boolean;
	}>,
): void {
	skillPaths.clear();
	for (const s of skills) {
		// 与 pi 的 formatSkillsForPrompt 一致：disable-model-invocation 的技能
		// 不暴露给模型自动调用（只能通过 /skill:name 显式调用）。
		if (!s?.name || !s.filePath) continue;
		if (s.disableModelInvocation) continue;
		skillPaths.set(s.name, { filePath: s.filePath, description: s.description ?? "" });
	}
}

function readSkillMarkdown(filePath: string): string | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return content.length > 12_000 ? content.slice(0, 12_000) + "\n…(truncated)" : content;
	} catch {
		return undefined;
	}
}

function availableSkillList(): string {
	if (skillPaths.size === 0) return "(none)";
	return [...skillPaths.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([name, info]) => (info.description ? `${name} — ${info.description.replace(/\s+/g, " ")}` : name))
		.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function taskOrientationExtension(pi: ExtensionAPI): void {
	// ------------------------------------------------------------------
	// 1. 注册路由工具：多技能评估 + 必填 reason。
	// ------------------------------------------------------------------
	pi.registerTool({
		name: ROUTER_TOOL,
		label: "Resolve Skill",
		description:
			"MANDATORY FIRST STEP for every new request. " +
			"Check the <available_skills> list in the system prompt and decide which skills the current request matches. " +
			"Pass ALL matching skill names (a request may match several skills), or [\"none\"] if none apply. " +
			"Each chosen skill's full instructions will be loaded and are mandatory for the rest of this task. " +
			"No other tool (read, bash, edit, write, subagent, ...) can be used until this tool has been called.",
		promptSnippet: "task_orientation(skills, reason) — mandatory skill assessment before any other tool",
		parameters: Type.Object({
			skills: Type.Array(
				Type.String({
					description:
						"All skill names from the <available_skills> list that match the current request, or [\"none\"] if no skill applies.",
				}),
			),
			reason: Type.String({
				description:
					"One sentence justifying your choice. " +
					"If you passed skill names, say which part of the task each skill covers. " +
					"If you passed [\"none\"], be specific about what kind of task this is and why the listed skills do not fit — " +
					"vague reasons like \"not applicable\" or \"no match\" are not acceptable.",
			}),
			skipped_rules: Type.Array(
				Type.Object({
					rule: Type.String({ description: "The conditional AGENTS.md rule that this task does not trigger." }),
					reason: Type.String({ description: "Why the condition is not met (concrete, not \"not applicable\")." }),
				}),
				{ description: "Conditional AGENTS.md rules checked and skipped for this task. Empty array if none were skipped." },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			skillResolved = true;

			const chosen = (params.skills ?? []).filter((n: string) => n && n !== "none");

			// 汇总被跳过的条件式 AGENTS.md 规则（Step 2 的审计面）。
			const skippedRules = params.skipped_rules ?? [];
			const skippedSummary =
				skippedRules.length === 0
					? "AGENTS.md: no conditional rules skipped."
					: "Skipped AGENTS.md conditional rules:\n" +
						skippedRules.map((r: { rule: string; reason: string }) => `- ${r.rule}: ${r.reason}`).join("\n");

			// 未选择任何技能（["none"] 或空）→ 评估完成，确认 reason 已记录。
			if (chosen.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No skill selected. Assessment complete. Reason recorded: ${params.reason ?? ""}\n\n${skippedSummary}`,
						},
					],
					details: {},
				};
			}

			// 逐个校验技能存在并读取 SKILL.md 全文，拼接后一次返回。
			const blocks: string[] = [];
			for (const name of chosen) {
				const info = skillPaths.get(name);
				if (!info) {
					return {
						content: [
							{
								type: "text" as const,
								text:
									`Skill "${name}" is not available for automatic invocation. ` +
									`Available skills:\n${availableSkillList()}\n` +
									`Re-call task_orientation with valid skill names, or ["none"].`,
							},
						],
						details: {},
						isError: true,
					};
				}

				const markdown = readSkillMarkdown(info.filePath);
				if (!markdown) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Could not read skill file for "${name}" (${info.filePath}).`,
							},
						],
						details: {},
						isError: true,
					};
				}

				blocks.push(
					[
						`<auto_loaded_skill name="${name}">`,
						`You chose this skill for the current request. Its instructions are mandatory — follow them for the rest of this task.`,
						`Source: ${info.filePath}`,
						"",
						markdown,
						`</auto_loaded_skill>`,
					].join("\n"),
				);
			}

			return {
				content: [{ type: "text" as const, text: blocks.join("\n\n") + `\n\n${skippedSummary}` }],
				details: {},
			};
		},
	});

	// ------------------------------------------------------------------
	// 2. 门控：评估完成前拦截所有其他工具。
	// ------------------------------------------------------------------
	pi.on("tool_call", (event) => {
		if (event.toolName === ROUTER_TOOL) return undefined;
		if (skillResolved || skillPaths.size === 0) return undefined;

		return {
			block: true,
			reason:
				`You must call task_orientation before using "${event.toolName}". ` +
				`Assess the <available_skills> list against the current request: ` +
				`if skills match, pass their names (their instructions will be loaded and are mandatory); ` +
				`otherwise pass ["none"] with a concrete reason and proceed normally.`,
		};
	});

	// ------------------------------------------------------------------
	// 3. 每轮重置门控 + 注入定向指令（动态检测 AGENTS.md）。
	// ------------------------------------------------------------------
	pi.on("before_agent_start", (event) => {
		skillResolved = false;
		refreshSkillIndex(event.systemPromptOptions?.skills ?? []);

		// 无技能可用（如 --no-skills）：无需强制，也不注入。
		if (skillPaths.size === 0) {
			return undefined;
		}

		// 动态检测：contextFiles 中是否有 AGENTS.md（含 override 变体）。
		const hasAgentsMd = (event.systemPromptOptions?.contextFiles ?? []).some((f) =>
			path.basename(f.path).toUpperCase().startsWith("AGENTS."),
		);

		const steps = [STEP1_SKILL_ASSESSMENT];
		if (hasAgentsMd) {
			steps.push(STEP2_RULE_ANALYSIS);
		}

		// 持久消息：定向指令跨轮保留可见。
		return {
			message: {
				customType: "task-orientation",
				content: steps.join("\n"),
				display: false,
			},
		};
	});
}
