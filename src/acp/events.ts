import type { SessionNotification } from "@agentclientprotocol/sdk";

export type AcpActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	| { type: "tool"; text: string }
	| { type: "plan"; text: string }
	| { type: "unknown"; updateType: string };

export interface ToolCallEntry {
	mcp: boolean;
	title: string;
}

export function mapSessionUpdate(notification: SessionNotification, toolCalls: Map<string, ToolCallEntry>): AcpActivity[] {
	const update = notification.update;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
			return update.content.type === "text"
				? [{ type: "text", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_message:${update.content.type}` }];
		case "agent_thought_chunk":
			return update.content.type === "text"
				? [{ type: "thought", delta: update.content.text }]
				: [{ type: "unknown", updateType: `agent_thought:${update.content.type}` }];
		case "tool_call":
			// Remembered by id: agy's terminal update carries neither _meta nor title.
			toolCalls.set(update.toolCallId, { mcp: isMcpToolCall(update._meta), title: clean(update.title) });
			return [];
		case "tool_call_update": {
			if (update.status !== "completed" && update.status !== "failed") return [];
			const seen = toolCalls.get(update.toolCallId);
			toolCalls.delete(update.toolCallId);
			// Pi's own tools arrive through the MCP bridge and are already real Pi tool calls.
			if (seen?.mcp || isMcpToolCall(update._meta)) return [];
			const title = update.title ? clean(update.title) : seen?.title ?? clean(update.toolCallId);
			return [{ type: "tool", text: `\n[Antigravity tool: ${title} — ${update.status}]\n` }];
		}
		case "plan": {
			const lines = update.entries.map((entry) => `- [${entry.status}] ${clean(entry.content)}`);
			return lines.length ? [{ type: "plan", text: `\n[Antigravity plan]\n${lines.join("\n")}\n` }] : [];
		}
		default:
			return [{ type: "unknown", updateType: update.sessionUpdate }];
	}
}

function isMcpToolCall(meta: { [key: string]: unknown } | null | undefined): boolean {
	return meta?.is_mcp_tool_call === true;
}

function clean(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, 2_000);
}
