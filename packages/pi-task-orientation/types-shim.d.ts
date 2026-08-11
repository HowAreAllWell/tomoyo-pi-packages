/**
 * 类型 shim：仅用于本地 tsc 严格类型检查（pi 运行时提供真实类型）。
 * 按 .work/pi-midturn-compaction/packages/coding-agent/src/core/extensions/types.ts 核对。
 */

declare module "@earendil-works/pi-coding-agent" {
	type TSchema = import("typebox").TSchema;
	type Static<S extends TSchema> = import("typebox").Static<S>;

	// ---- 基础消息类型 ----
	export interface TextContent {
		type: "text";
		text: string;
	}
	export interface ImageContent {
		type: "image";
		[keys: string]: unknown;
	}
	export interface CustomMessage<T = unknown> {
		role: "custom";
		customType: string;
		content: string | (TextContent | ImageContent)[];
		display: boolean;
		details?: T;
		timestamp: number;
	}
	export interface ToolResultMessage {
		role: "toolResult";
		toolCallId: string;
		toolName: string;
		content: (TextContent | ImageContent)[];
		details?: any;
		isError: boolean;
		timestamp: number;
	}
	export type AgentMessage =
		| { role: "user"; content: (TextContent | ImageContent)[]; timestamp: number }
		| { role: "assistant"; content: unknown[]; timestamp: number }
		| ToolResultMessage
		| CustomMessage;

	// ---- Skill ----
	export interface Skill {
		name: string;
		description: string;
		filePath: string;
		baseDir: string;
		disableModelInvocation: boolean;
	}

	// ---- systemPromptOptions ----
	export interface BuildSystemPromptOptions {
		skills?: Skill[];
		contextFiles?: Array<{ path: string; content: string }>;
		[keys: string]: unknown;
	}

	// ---- 事件 ----
	export interface BeforeAgentStartEvent {
		type: "before_agent_start";
		prompt: string;
		images?: ImageContent[];
		systemPrompt: string;
		systemPromptOptions: BuildSystemPromptOptions;
	}
	export interface ToolCallEvent {
		type: "tool_call";
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
	}
	export interface TurnEndEvent {
		type: "turn_end";
		turnIndex: number;
		message: AgentMessage;
		toolResults: ToolResultMessage[];
	}
	export interface ContextEvent {
		type: "context";
		messages: AgentMessage[];
	}
	export interface AgentEndEvent {
		type: "agent_end";
		messages: AgentMessage[];
	}
	export interface SessionStartEvent {
		type: "session_start";
		reason: "startup" | "reload" | "new" | "resume" | "fork";
	}
	export interface SessionTreeEvent {
		type: "session_tree";
	}
	export interface SessionCompactEvent {
		type: "session_compact";
	}

	// ---- 事件结果 ----
	export interface ToolCallEventResult {
		block?: boolean;
		reason?: string;
		terminate?: boolean;
	}
	export interface ContextEventResult {
		messages: AgentMessage[];
	}
	export interface BeforeAgentStartEventResult {
		message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
		systemPrompt?: string;
	}

	// ---- Session entries（重建状态用）----
	export interface SessionEntryBase {
		id: string;
		parentId?: string;
		timestamp: number;
	}
	export interface SessionMessageEntry extends SessionEntryBase {
		type: "message";
		message: AgentMessage;
	}
	export interface CustomEntry<T = unknown> extends SessionEntryBase {
		type: "custom";
		customType: string;
		data?: T;
	}
	export type SessionEntry =
		| SessionMessageEntry
		| CustomEntry
		| { type: "compaction" | "branchSummary" | "label" | "session_info" | "thinking_level" | "model"; [k: string]: unknown };

	export interface ReadonlySessionManager {
		getBranch(fromId?: string): SessionEntry[];
		[keys: string]: unknown;
	}

	export interface ExtensionContext {
		ui: unknown;
		mode: unknown;
		hasUI: boolean;
		cwd: string;
		sessionManager: ReadonlySessionManager;
		[keys: string]: unknown;
	}

	// ---- Tool ----
	export interface AgentToolResult<TDetails = unknown> {
		content: (TextContent | ImageContent)[];
		details: TDetails;
		usage?: unknown;
		addedToolNames?: string[];
		terminate?: boolean;
		/** 扩展自定义：错误标记（v1 同款用法） */
		isError?: boolean;
	}

	export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: TParams;
		execute(
			toolCallId: string,
			params: Static<TParams>,
			signal: AbortSignal | undefined,
			onUpdate: ((partial: unknown) => void) | undefined,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<any>> | AgentToolResult<any>;
	}

	// ---- ExtensionAPI ----
	export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

	export interface ExtensionAPI {
		registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(
			tool: ToolDefinition<TParams, TDetails>,
		): void;
		on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
		on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>): void;
		on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
		on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
		on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
		on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
		on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
		on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
		on(event: string, handler: (event: any, ctx: ExtensionContext) => any): void;
		sendMessage(
			message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
			options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
		): void;
		appendEntry<T = unknown>(customType: string, data?: T): void;
	}
}
