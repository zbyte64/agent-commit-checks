/**
 * The part of the omp and pi extension APIs the acc extensions use. Both hosts pass a richer object;
 * these structural types keep the adapters checkable without either host package installed.
 */

export interface HostUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	setStatus(key: string, text: string | undefined): void;
}

export interface HostContext {
	cwd: string;
	hasUI: boolean;
	ui: HostUi;
}

export interface ToolCallEvent {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

export interface ToolResultEvent {
	toolName: string;
	toolCallId: string;
	content: { type: string; text?: string }[];
	isError: boolean;
}

export interface HostToolResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
}

export interface HostToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute(toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: HostContext): Promise<HostToolResult>;
}

export interface HostCommand {
	description?: string;
	handler(args: string, ctx: HostContext): Promise<void>;
}

/** Event registration and the registries both hosts share. */
export interface HostApi {
	on(event: "tool_call", handler: (event: ToolCallEvent, ctx: HostContext) => unknown): unknown;
	on(event: "tool_result", handler: (event: ToolResultEvent, ctx: HostContext) => unknown): unknown;
	on(event: "session_start", handler: (event: unknown, ctx: HostContext) => unknown): unknown;
	registerTool(tool: HostToolDefinition): void;
	registerCommand(name: string, command: HostCommand): void;
}
