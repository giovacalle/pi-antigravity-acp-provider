import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";

export type AcpActivity =
	| { type: "text"; delta: string }
	| { type: "thought"; delta: string }
	| { type: "tool"; text: string; compactText: string; isUpdate: boolean }
	| { type: "plan"; text: string }
	| { type: "usage"; used: number }
	| { type: "unknown"; updateType: string };

/**
 * `mcpCalls` remembers MCP tool call ids, because agy's terminal update carries neither `_meta` nor a title.
 * Pi's own tools arrive through the MCP bridge as real Pi tool calls, so they are not repeated as activity.
 */
export function mapSessionUpdate(notification: SessionNotification, mcpCalls = new Set<string>()): AcpActivity[] {
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
		case "tool_call": {
			if (isMcpToolCall(update._meta)) {
				mcpCalls.add(update.toolCallId);
				return [];
			}
			const status = update.status ? ` — ${update.status}` : "";
			const title = clean(update.title);
			const singleLineTitle = title.replace(/\s+/gu, " ").trim() || "tool";
			return [
				{
					type: "tool",
					isUpdate: false,
					text: `\n[Antigravity tool: ${title}${status}]\n`,
					compactText: `\n[Antigravity tool: ${singleLineTitle}${status}]\n`,
				},
			];
		}
		case "tool_call_update": {
			const mcp = mcpCalls.has(update.toolCallId) || isMcpToolCall(update._meta);
			if (update.status === "completed" || update.status === "failed") mcpCalls.delete(update.toolCallId);
			if (mcp) return [];
			const label = update.title ? clean(update.title) : clean(update.toolCallId);
			const status = update.status ? ` — ${update.status}` : "";
			const details = toolContentText(update.content);
			const singleLineLabel = label.replace(/\s+/gu, " ").trim() || "tool";
			return [
				{
					type: "tool",
					isUpdate: true,
					text: `\n[Antigravity tool update: ${label}${status}]${details ? `\n${details}\n` : "\n"}`,
					compactText: `\n[Antigravity tool update: ${singleLineLabel}${status}]\n`,
				},
			];
		}
		case "plan": {
			const lines = update.entries.map((entry) => `- [${entry.status}] ${clean(entry.content)}`);
			return lines.length ? [{ type: "plan", text: `\n[Antigravity plan]\n${lines.join("\n")}\n` }] : [];
		}
		case "usage_update":
			// Sent once per inference with the context size after it; session setup reports 0.
			return update.used > 0 ? [{ type: "usage", used: update.used }] : [];
		default:
			return [{ type: "unknown", updateType: update.sessionUpdate }];
	}
}

function toolContentText(content: SessionNotification["update"] extends infer _T ? unknown : never): string {
	if (!Array.isArray(content)) return "";
	const output: string[] = [];
	for (const item of content.slice(0, 8)) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		if (record.type === "diff") {
			const path = typeof record.path === "string" ? clean(record.path) : "file";
			output.push(`[diff: ${path}]`);
		} else if (record.type === "content") {
			const block = record.content as Record<string, unknown> | undefined;
			if (block?.type === "text" && typeof block.text === "string") {
				output.push(clean(block.text).slice(0, 2_000));
			}
		}
	}
	return output.join("\n").slice(0, 4_000);
}

function isMcpToolCall(meta: { [key: string]: unknown } | null | undefined): boolean {
	return meta?.is_mcp_tool_call === true;
}

function clean(value: string): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "").slice(0, 2_000);
}
