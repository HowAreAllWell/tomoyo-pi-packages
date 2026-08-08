/**
 * Mandatory Skill Resolution Extension
 *
 * Makes the model's own skill judgment MANDATORY instead of relying on the
 * model's goodwill to call `read` on a SKILL.md (which small/fast models skip).
 *
 * How it works:
 *   1. Registers a custom tool `resolve_skill(skillName | "none")` — the model
 *      decides, from the available-skills list injected at turn start, whether
 *      this request matches a skill. It passes the skill name, or "none".
 *   2. A `tool_call` gate blocks EVERY other tool (read, bash, edit, write,
 *      subagent, ...) until `resolve_skill` has been called this turn. The
 *      block reason tells the model exactly what to do. Because blocked calls
 *      come back as tool errors, the model is forced to comply.
 *   3. On match, `resolve_skill` returns the full SKILL.md inline, so the
 *      model cannot "forget" to load it — the instructions are already in
 *      context, and stay in the conversation history for later turns.
 *
 * This is the model-judges / harness-enforces design: judgment stays with the
 * model (full semantic understanding, no trigger-word table), while the
 * harness makes the "evaluate + load" step impossible to skip.
 *
 * Placement: ~/.pi/agent/extensions/ (hot-reloadable with /reload)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** skill name -> { filePath, description }, resolved lazily from systemPromptOptions.skills */
const skillPaths = new Map<string, { filePath: string; description: string }>();

/** true once `resolve_skill` has run this turn. */
let skillResolved = false;
/** tools excluded from the gate (the router itself). */
const ROUTER_TOOL = "resolve_skill";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function refreshSkillIndex(skills: Array<{ name: string; filePath: string; description?: string; disableModelInvocation?: boolean }>): void {
	skillPaths.clear();
	for (const s of skills) {
		// Respect the Agent Skills spec: disable-model-invocation skills are
		// NOT exposed to the model (same filter as formatSkillsForPrompt) —
		// they can only be invoked explicitly via /skill:name.
		if (!s?.name || !s.filePath) continue;
		if (s.disableModelInvocation) continue;
		skillPaths.set(s.name, { filePath: s.filePath, description: s.description ?? "" });
	}
}

function skillListForPrompt(): string {
	if (skillPaths.size === 0) return "(none)";
	return [...skillPaths.entries()]
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([name, info]) => (info.description ? `${name} — ${info.description.replace(/\s+/g, " ")}` : name))
		.join("\n");
}


function readSkillMarkdown(filePath: string): string | undefined {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		return content.length > 12_000 ? content.slice(0, 12_000) + "\n…(truncated)" : content;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function mandatorySkillResolutionExtension(pi: ExtensionAPI): void {
	// ------------------------------------------------------------------
	// 1. Register the mandatory router tool.
	// ------------------------------------------------------------------
	pi.registerTool({
		name: ROUTER_TOOL,
		label: "Resolve Skill",
		description:
			"MANDATORY FIRST STEP for every new user request. " +
			"Check the Available skills list in the system prompt and decide whether the current request matches one of them. " +
			"If it matches, pass the exact skill name; if no skill applies, pass \"none\". " +
			"If a skill matches, its full instructions will be returned — you MUST follow them for the rest of this task. " +
			"No other tool (read, bash, edit, write, subagent, ...) can be used until this tool has been called.",
		promptSnippet: "resolve_skill(skillName) — mandatory skill assessment before any other tool",
		parameters: Type.Object({
			skillName: Type.String({
				description:
					"The exact skill name from the Available skills list that matches the current request, or \"none\" if no skill applies.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx: ExtensionContext) {
			skillResolved = true;

			const name = (params.skillName || "").trim();
			if (!name || name === "none") {
				return {
					content: [
						{
							type: "text" as const,
							text: `Skill assessment: no matching skill (you chose "none"). Proceed with the task using normal tooling.`,
						},
					],
					details: {},
				};
			}

			const skillInfo = skillPaths.get(name);
			if (!skillInfo) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Skill "${name}" is not available for automatic invocation. ` +
								`(It may be disabled via disable-model-invocation and only usable through /skill:${name}.) ` +
								`Available skills: ${skillListForPrompt()}. ` +
								`Re-call resolve_skill with a valid skill name, or "none".`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const markdown = readSkillMarkdown(skillInfo.filePath);
			if (!markdown) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Could not read skill file for "${name}" (${skillInfo.filePath}). Available skills: ${skillListForPrompt()}.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`<auto_loaded_skill name="${name}">`,
							`You chose this skill for the current request. Its instructions are mandatory — follow them for the rest of this task.`,
							`Source: ${skillInfo.filePath}`,
							"",
							markdown,
							`</auto_loaded_skill>`,
						].join("\n"),
					},
				],
				details: {},
			};
		},
	});

	// ------------------------------------------------------------------
	// 2. Gate: block every other tool until resolve_skill ran this turn.
	// ------------------------------------------------------------------
	pi.on("tool_call", (event) => {
		if (event.toolName === ROUTER_TOOL) return undefined;
		if (skillResolved || skillPaths.size === 0) return undefined;

		return {
			block: true,
			reason:
				`You must call resolve_skill before using "${event.toolName}". ` +
				`Assess the Available skills list against the current request: ` +
				`if a skill matches, pass its name (its instructions will be loaded and you must follow them); ` +
				`otherwise pass "none" and proceed normally.`,
		};
	});

	// ------------------------------------------------------------------
	// 3. Reset gate per turn + inject the skill index + mandate.
	// ------------------------------------------------------------------
	pi.on("before_agent_start", (event) => {
		skillResolved = false;

		const skills = event.systemPromptOptions?.skills;
		// Always rebuild the index: clears stale entries when skills change/disappear.
		refreshSkillIndex(skills ?? []);

		// No skills available (e.g. --no-skills): nothing to force.
		if (skillPaths.size === 0) {
			return undefined;
		}

		const list = skillListForPrompt();

		const mandate =
			[
				"## Mandatory skill assessment (do not skip)",
				"Before using any tool for this request, you MUST call resolve_skill once.",
				"Available skills: " + list,
				"- If the request matches a skill, pass its exact name; its instructions will be loaded and are mandatory.",
				"- If nothing matches, pass \"none\". " +
					"Every other tool is blocked until you do this — it is not optional.",
			].join("\n");

		// Persistent message so the list + mandate stay visible across turns.
		return {
			message: {
				customType: "mandatory-skill-assessment",
				content: mandate,
				display: false,
			},
		};
	});
}
