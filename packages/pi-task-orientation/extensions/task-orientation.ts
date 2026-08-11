/**
 * Task Orientation Extension v2
 *
 * 让每个任务从"一次性定向"升级为"持续性定向"：
 *
 *   plan() —— 起点硬门控的解锁工具（每个新任务强制一次）
 *     模型在动手前调用 plan()，一次完成三件事：
 *     - 技能评估：匹配 <available_skills> 并注入所选 SKILL.md 全文
 *     - AGENTS.md 规则分析：区分始终适用/条件式，记录跳过项（skipped_rules，审计）
 *     - 生成执行清单（todos）：依据用户请求 + 所选技能 + AGENTS.md 规则
 *     调用前所有其他工具被 tool_call 门控拦截；调用后整个请求放行。
 *
 *   task_todo() —— 执行期轻量更新
 *     模型按 plan 的清单逐项执行，途中标记完成/新增/加载新技能。
 *
 *   turn_end + context —— 软检查点
 *     每个执行 turn 结束后，注入一行紧凑状态行 + 更新引导 + AGENTS.md 条件规则提醒。
 *
 *   agent_end —— 终点硬收尾（条件触发、只一次）
 *     若 todo 有未终结项 或 门控从未被打开（纯文本绕过），注入收尾检查并续跑一轮。
 *
 * 状态机（门控从"每条消息"降到"每个任务"）：
 *   before_agent_start:
 *     activeTodo == null 或全部终结 → 新任务：武装门控 + 注入 plan 指令
 *     否则                              → 延续：不武装，注入延续 nudge
 *
 * 设计要点：
 *   - 决策留模型、执行归 harness：语义判断靠模型，加载/门控/持久化靠扩展
 *   - 不重复注入：loadedSkills 去重（含用户手动 /skill: 加载的技能）
 *   - 结构承重：todo 清单写进工具结果 details，分支安全，可在检查点回显
 *   - 状态可恢复：session_start/session_tree/session_compact 时从会话历史重建
 *
 * 放置：~/.pi/agent/extensions/（/reload 可热加载）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const PLAN_TOOL = "plan";
const TODO_TOOL = "task_todo";

const CT_PLAN = "task-orientation-plan";
const CT_CONTINUE = "task-orientation-continue";
const CT_CHECKPOINT = "task-orientation-checkpoint";
const CT_ENDCHECK = "task-orientation-endcheck";
const CT_ARCHIVE = "todo-archive";

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

type TodoStatus = "pending" | "in_progress" | "done" | "blocked" | "cancelled";

interface Todo {
	id: number;
	title: string;
	status: TodoStatus;
}

interface TodoDetails {
	todos: Todo[];
	nextId: number;
}

/** skill name -> { filePath, description }，从 systemPromptOptions.skills 惰性构建 */
const skillPaths = new Map<string, { filePath: string; description: string }>();

/** 当前任务 todo 清单；null = 无活跃任务 */
let activeTodo: Todo[] | null = null;
let nextTodoId = 1;

/** plan 门控是否武装（新任务模式） */
let gateArmed = false;
/** 本任务是否已调用过 plan（终点兜底"纯文本绕过"判定） */
let planDone = false;
/** 终点检查是否已触发过（保证只续跑一次） */
let endCheckDone = false;
/** 本任务已注入/已手动加载的技能（防重复注入） */
let loadedSkills = new Set<string>();
/** turn_end 已排期、待 context 注入的检查点 */
let checkpointPending = false;

// ---------------------------------------------------------------------------
// 注入文案（英文，模型可见）
// ---------------------------------------------------------------------------

const PLAN_INSTRUCTION = [
	"## Task orientation (do not skip — applies to every new request)",
	"",
	"Call plan() before any other tool. plan() requires:",
	"- skills: all matching skills from <available_skills>; [] if none. Skills already loaded via /skill: are handled automatically — do not re-list them.",
	"- reason: one sentence justifying your choice.",
	"- skipped_rules: AGENTS.md conditional rules this request does NOT trigger, each with a reason; empty array if none.",
	"- todos: the execution checklist derived from the user request, the chosen skills, and the AGENTS.md rules.",
	"",
	"AGENTS.md rules are BINDING. Lack of forceful wording (e.g. no \"must\") does not downgrade a rule to a suggestion. Follow every rule except clearly conditional ones; when a conditional rule becomes triggered during execution (e.g. after modifying files), apply it immediately or add it to the todos.",
	"",
	"Execute the todos one by one, in order: mark an item in_progress before working on it, and mark it done (or blocked/cancelled) when you leave it.",
].join("\n");

const CONTINUE_NUDGE = [
	"New message received. If it changes the task direction, update the plan first (task_todo for small changes, plan for major re-plans), then continue. Otherwise proceed directly.",
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
	return [...skillPaths.keys()].join(", ");
}

/** 扫描用户消息里的 /skill:name 展开块（<skill name="X" ...>），返回手动加载的技能名。 */
function findManualSkills(prompt: string): string[] {
	const re = /<skill\s+name="([^"]+)"/g;
	const names: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(prompt)) !== null) names.push(m[1]);
	return names;
}

function isTaskComplete(list: Todo[]): boolean {
	// 任务是否真正结束：仅 done/cancelled。blocked=暂停（等用户/被阻塞），状态保留供延续。
	return list.every((t) => t.status === "done" || t.status === "cancelled");
}

function statusCounts(list: Todo[]): { done: number; inProgress: Todo[]; pending: Todo[] } {
	const done = list.filter((t) => t.status === "done").length;
	const inProgress = list.filter((t) => t.status === "in_progress");
	const pending = list.filter((t) => t.status === "pending");
	return { done, inProgress, pending };
}

function formatTodoList(list: Todo[]): string {
	if (list.length === 0) return "Todos: (none)";
	const lines = list.map((t) => {
		const mark =
			t.status === "done" ? "[x]" : t.status === "in_progress" ? "[>]" : t.status === "blocked" ? "[!]" : t.status === "cancelled" ? "[-]" : "[ ]";
		return `#${t.id} ${mark} ${t.title} (${t.status})`;
	});
	return `Todos:\n${lines.join("\n")}`;
}

/** 把注入技能文本拼成 <auto_loaded_skill> 块；返回 blocks 与未知技能列表。 */
function injectSkills(names: string[]): { blocks: string[]; unknown: string[]; missing: string[] } {
	const blocks: string[] = [];
	const unknown: string[] = [];
	const missing: string[] = [];
	for (const name of names) {
		if (loadedSkills.has(name)) continue; // 已加载（手动 /skill: 或本任务先前已注入）
		const info = skillPaths.get(name);
		if (!info) {
			unknown.push(name);
			continue;
		}
		const markdown = readSkillMarkdown(info.filePath);
		if (!markdown) {
			missing.push(name);
			continue;
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
		loadedSkills.add(name);
	}
	return { blocks, unknown, missing };
}

function skippedRulesSummary(skipped: Array<{ rule: string; reason: string }>): string {
	if (skipped.length === 0) return "AGENTS.md: no conditional rules skipped.";
	return "Skipped AGENTS.md conditional rules:\n" + skipped.map((r) => `- ${r.rule}: ${r.reason}`).join("\n");
}

function buildCheckpointText(): string {
	const list = activeTodo ?? [];
	const { done, inProgress, pending } = statusCounts(list);
	const inProgressText =
		inProgress.length > 0 ? `#${inProgress[0].id} "${inProgress[0].title}"` : "none";
	const pendingText =
		pending.length > 0 ? `${pending.length} (next: #${pending[0].id} "${pending[0].title}")` : "0";
	return [
		`[checkpoint] Done: ${done} · In progress: ${inProgressText} · Pending: ${pendingText}`,
		"- Something completed or changed? Call task_todo to update it (or load_skill for a new skill).",
		"- Did an AGENTS.md conditional rule trigger? Apply it now or add it to the todos.",
		"- Otherwise just continue — no action needed.",
	].join("\n");
}

function buildEndCheckText(needsPlan: boolean, hasUnfinished: boolean): string {
	if (!hasUnfinished) {
		return [
			"[final check] plan() was never called for this request. Do NOT start new work.",
			"If this request was trivial, answer directly. Otherwise call plan() first (skills + AGENTS.md rules + todos), then give your final answer.",
		].join("\n");
	}
	const lines = [
		hasUnfinished && needsPlan
			? "[final check] plan() was never called and your todos still have unfinished items. Do NOT start new work — only finalize:"
			: "[final check] Your todos still have unfinished items. Do NOT start new work — only finalize:",
		"- mark done items as done, items waiting on the user or blocked as blocked, unnecessary items as cancelled;",
		"- ensure every triggered AGENTS.md conditional rule is either applied or already present in your todos;",
		"then give your final answer.",
	];
	return lines.join("\n");
}

/** 任务完成收尾：全部终结 → 存档 + 清空（下条消息进入新任务模式）；否则保留（延续）。 */
function applyCompletion(appendArchive: (todos: Todo[]) => void): void {
	if (activeTodo !== null && isTaskComplete(activeTodo)) {
		appendArchive(activeTodo);
		activeTodo = null;
	}
}

/** 从会话历史重建 activeTodo（分支安全，覆盖 /reload /compact /fork）。 */
function reconstructState(ctx: ExtensionContext): void {
	activeTodo = null;
	nextTodoId = 1;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === CT_ARCHIVE) {
			activeTodo = null;
			continue;
		}
		if (entry.type !== "message") continue;
		const msg = entry.message;
		if (msg.role !== "toolResult") continue;
		if (msg.toolName !== PLAN_TOOL && msg.toolName !== TODO_TOOL) continue;
		const details = msg.details as TodoDetails | undefined;
		if (!details || !Array.isArray(details.todos)) continue;
		activeTodo = details.todos;
		nextTodoId =
			typeof details.nextId === "number"
				? details.nextId
				: activeTodo.length > 0
					? Math.max(...activeTodo.map((t) => t.id)) + 1
					: 1;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function taskOrientationExtension(pi: ExtensionAPI): void {
	const appendArchive = (todos: Todo[]) => {
		pi.appendEntry(CT_ARCHIVE, { todos, archivedAt: Date.now() });
	};

	// ------------------------------------------------------------------
	// 1. plan 工具：起点解锁 + 交付物（技能 + AGENTS.md 分析 + todo）
	// ------------------------------------------------------------------
	pi.registerTool({
		name: PLAN_TOOL,
		label: "Plan Task",
		description:
			"MANDATORY FIRST STEP for every new request. Call it before any other tool. " +
			"It loads matching skills, records the AGENTS.md rule analysis, and establishes the execution checklist for this request. " +
			"No other tool can be used until plan() has been called on a fresh task. " +
			"May be called again later to re-plan.",
		promptSnippet: "plan(skills, reason, skipped_rules, todos) — mandatory orientation: skills + AGENTS.md rules + execution checklist",
		parameters: Type.Object({
			skills: Type.Array(
				Type.String({
					description:
						"All skill names from the <available_skills> list that match this request, or [] if none. Skills already loaded via /skill: are handled automatically — do not re-list them.",
				}),
				{ description: "Matching skills to load." },
			),
			reason: Type.String({
				description:
					"One sentence justifying your choice. If you passed skills, say which part of the task each covers. If [], be specific about why no skill applies.",
			}),
			skipped_rules: Type.Array(
				Type.Object({
					rule: Type.String({ description: "The conditional AGENTS.md rule that this request does not trigger." }),
					reason: Type.String({ description: "Why the condition is not met (concrete, not \"not applicable\")." }),
				}),
				{ description: "AGENTS.md conditional rules not triggered by this request; empty array if none." },
			),
			todos: Type.Array(
				Type.Object({
					title: Type.String({ description: "One execution step to perform." }),
					status: Type.Union([
						Type.Literal("pending"),
						Type.Literal("in_progress"),
						Type.Literal("done"),
						Type.Literal("blocked"),
						Type.Literal("cancelled"),
					]),
				}),
				{ description: "The execution checklist. At most one item may be in_progress." },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			// todo 校验：同时最多一个 in_progress（结构不变式）
			const inProgress = params.todos.filter((t) => t.status === "in_progress");
			if (inProgress.length > 1) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Invalid plan: at most one todo can be "in_progress" (got ${inProgress.length}). Re-call plan() with a single in_progress item.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			// 技能注入（loadedSkills 去重；未知/读取失败单独报告）
			const { blocks, unknown, missing } = injectSkills(params.skills);
			if (unknown.length > 0 || missing.length > 0) {
				const problems: string[] = [];
				if (unknown.length > 0) {
					problems.push(`Skill(s) not available for automatic invocation: ${unknown.join(", ")}. Available: ${availableSkillList()}`);
				}
				if (missing.length > 0) {
					problems.push(`Could not read skill file(s): ${missing.join(", ")}.`);
				}
				return {
					content: [
						{
							type: "text" as const,
							text: problems.join("\n") + `\nRe-call plan() with valid skill names.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			// 落状态
			const todos: Todo[] = params.todos.map((t, i) => ({
				id: i + 1,
				title: t.title,
				status: t.status,
			}));
			activeTodo = todos;
			nextTodoId = todos.length + 1;
			gateArmed = false;
			planDone = true;

			const parts: string[] = [];
			if (blocks.length > 0) parts.push(blocks.join("\n\n"));
			parts.push(formatTodoList(todos));
			parts.push(skippedRulesSummary(params.skipped_rules ?? []));

			return {
				content: [{ type: "text" as const, text: parts.join("\n\n") }],
				details: { todos, nextId: nextTodoId } satisfies TodoDetails,
			};
		},
	});

	// ------------------------------------------------------------------
	// 2. task_todo 工具：执行期轻量更新
	// ------------------------------------------------------------------
	pi.registerTool({
		name: TODO_TOOL,
		label: "Update Task Todo",
		description:
			"Update the current task's todo list. " +
			"Actions: update (mark an item done/blocked/cancelled/pending/in_progress), add (append a new pending item), load_skill (load a skill's full instructions). " +
			"At most one item may be in_progress at a time.",
		promptSnippet: "task_todo(action, ...) — update the current task's todo list",
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("update"),
				Type.Literal("add"),
				Type.Literal("load_skill"),
			]),
			id: Type.Optional(
				Type.Integer({ description: "Todo id to update (required for action=update)." }),
			),
			status: Type.Optional(
				Type.Union([
					Type.Literal("pending"),
					Type.Literal("in_progress"),
					Type.Literal("done"),
					Type.Literal("blocked"),
					Type.Literal("cancelled"),
				]),
			),
			title: Type.Optional(Type.String({ description: "New todo title (required for action=add)." })),
			skills: Type.Optional(
				Type.Array(
					Type.String({
						description:
							"Skill names from <available_skills> to load (required for action=load_skill).",
					}),
				),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (activeTodo === null) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No active todo for this request. Call plan() first.",
						},
					],
					details: {},
					isError: true,
				};
			}

			const list: Todo[] = activeTodo.map((t) => ({ ...t }));

			if (params.action === "update") {
				if (params.id === undefined || params.status === undefined) {
					return {
						content: [
							{
								type: "text" as const,
								text: 'task_todo(action="update") requires both "id" and "status".',
							},
						],
						details: {},
						isError: true,
					};
				}
				const item = list.find((t) => t.id === params.id);
				if (!item) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Todo #${params.id} not found. Current todos:\n${formatTodoList(list)}`,
							},
						],
						details: {},
						isError: true,
					};
				}
				if (params.status === "in_progress") {
					const already = list.find((t) => t.status === "in_progress" && t.id !== params.id);
					if (already) {
						return {
							content: [
								{
									type: "text" as const,
									text: `Todo #${already.id} is already in_progress. Mark it done/blocked/cancelled first, then re-call task_todo.`,
								},
							],
							details: {},
							isError: true,
						};
					}
				}
				item.status = params.status;
			} else if (params.action === "add") {
				if (!params.title) {
					return {
						content: [
							{
								type: "text" as const,
								text: 'task_todo(action="add") requires "title".',
							},
						],
						details: {},
						isError: true,
					};
				}
				list.push({ id: nextTodoId, title: params.title, status: "pending" });
				nextTodoId++;
			} else if (params.action === "load_skill") {
				const { blocks, unknown, missing } = injectSkills(params.skills ?? []);
				const problems: string[] = [];
				if (unknown.length > 0) {
					problems.push(`Skill(s) not available for automatic invocation: ${unknown.join(", ")}. Available: ${availableSkillList()}`);
				}
				if (missing.length > 0) {
					problems.push(`Could not read skill file(s): ${missing.join(", ")}.`);
				}
				activeTodo = list;
				const parts: string[] = [];
				if (blocks.length > 0) parts.push(blocks.join("\n\n"));
				if (problems.length > 0) parts.push(problems.join("\n"));
				parts.push(formatTodoList(list));
				return {
					content: [{ type: "text" as const, text: parts.join("\n\n") }],
					details: { todos: list, nextId: nextTodoId } satisfies TodoDetails,
				};
			}

			activeTodo = list;
			return {
				content: [{ type: "text" as const, text: formatTodoList(list) }],
				details: { todos: list, nextId: nextTodoId } satisfies TodoDetails,
			};
		},
	});

	// ------------------------------------------------------------------
	// 3. 门控：plan 之前拦截所有其他工具。
	// ------------------------------------------------------------------
	pi.on("tool_call", (event) => {
		if (!gateArmed) return undefined;
		if (event.toolName === PLAN_TOOL) return undefined;
		return {
			block: true,
			reason: `You must call plan() before using "${event.toolName}". ` +
				`Assess the <available_skills> list and the AGENTS.md rules against the current request, ` +
				`then call plan() with the matching skills (or []), a reason, skipped_rules, and the execution checklist.`,
		};
	});

	// ------------------------------------------------------------------
	// 4. 每请求分流：新任务武装门控 + 注入 plan 指令；延续注入 nudge。
	// ------------------------------------------------------------------
	pi.on("before_agent_start", (event) => {
		// 每请求重置（activeTodo 跨请求保留，驱动延续模式）
		gateArmed = false;
		planDone = false;
		endCheckDone = false;
		checkpointPending = false;
		loadedSkills = new Set(findManualSkills(event.prompt));
		refreshSkillIndex(event.systemPromptOptions?.skills ?? []);

		const hasAgentsMd = (event.systemPromptOptions?.contextFiles ?? []).some((f) =>
			path.basename(f.path).toUpperCase().startsWith("AGENTS."),
		);
		const hasContent = skillPaths.size > 0 || hasAgentsMd;

		// 新任务模式（无活跃任务或已全部终结）
		if (activeTodo === null || isTaskComplete(activeTodo)) {
			if (!hasContent) return undefined; // 无技能且无 AGENTS.md：无可强制内容，纯自由
			gateArmed = true;
			return {
				message: { customType: CT_PLAN, content: PLAN_INSTRUCTION, display: false },
			};
		}

		// 延续模式
		return {
			message: { customType: CT_CONTINUE, content: CONTINUE_NUDGE, display: false },
		};
	});

	// ------------------------------------------------------------------
	// 5. turn_end：执行回合结束时排期检查点。
	// ------------------------------------------------------------------
	pi.on("turn_end", (event) => {
		if (gateArmed) return; // plan 之前不检查点
		if (event.toolResults.length === 0) return; // 最终答案回合（无工具调用）
		// plan 所在回合跳过（首个执行回合再排期）
		if (event.toolResults.every((r) => r.toolName === PLAN_TOOL)) return;
		checkpointPending = true;
	});

	// ------------------------------------------------------------------
	// 6. context：清理过期定向消息 + 注入待发检查点。
	// ------------------------------------------------------------------
	pi.on("context", (event) => {
		let messages = event.messages;

		// 只保留最近一条本扩展的定向消息（CT_PLAN/CT_CONTINUE/CT_CHECKPOINT/CT_ENDCHECK）
		const ourTypes = new Set([CT_PLAN, CT_CONTINUE, CT_CHECKPOINT, CT_ENDCHECK]);
		let lastIdx = -1;
		for (let i = 0; i < messages.length; i++) {
			const m = messages[i];
			if (m.role === "custom" && m.customType !== undefined && ourTypes.has(m.customType)) lastIdx = i;
		}
		if (lastIdx !== -1) {
			messages = messages.filter(
				(m, i) => !(i !== lastIdx && m.role === "custom" && m.customType !== undefined && ourTypes.has(m.customType)),
			);
		}

		// 注入检查点（仅进本次 LLM payload，不落会话历史）
		if (checkpointPending) {
			messages = [
				...messages,
				{
					role: "custom" as const,
					customType: CT_CHECKPOINT,
					content: buildCheckpointText(),
					display: false,
					timestamp: Date.now(),
				},
			];
			checkpointPending = false;
		}

		return { messages };
	});

	// ------------------------------------------------------------------
	// 7. agent_end：终点硬收尾（条件触发、只一次）+ 完成存档。
	// ------------------------------------------------------------------
	pi.on("agent_end", () => {
		if (endCheckDone) {
			applyCompletion(appendArchive);
			return;
		}
		const needsPlan = gateArmed && !planDone;
		const hasUnfinished = activeTodo !== null && !isTaskComplete(activeTodo);
		if (needsPlan || hasUnfinished) {
			endCheckDone = true;
			pi.sendMessage(
				{ customType: CT_ENDCHECK, content: buildEndCheckText(needsPlan, hasUnfinished), display: false },
				{ deliverAs: "followUp" },
			);
			return;
		}
		applyCompletion(appendArchive);
	});

	// ------------------------------------------------------------------
	// 8. 会话事件：状态重建（覆盖 /reload /compact /fork）。
	// ------------------------------------------------------------------
	pi.on("session_start", (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", (_event, ctx) => reconstructState(ctx));
	pi.on("session_compact", (_event, ctx) => reconstructState(ctx));
}
