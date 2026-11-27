import type { SessionNotification } from "@agentclientprotocol/sdk/unstable";
import { describe, expect, it } from "vitest";
import { mapSessionUpdate } from "../src/acp/events.js";

const note = (update: Record<string, unknown>) => ({ sessionId: "s", update } as unknown as SessionNotification);
const mcpMeta = { mcp: { tool: "pi_echo", server: "pi-bridge" }, is_mcp_tool_call: true };

describe("mapSessionUpdate", () => {
	it("drops MCP tool calls even when the completion lacks _meta", () => {
		const mcpCalls = new Set<string>();
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call", toolCallId: "m", title: "pi-bridge_pi_echo",
			kind: "other", status: "pending", _meta: mcpMeta }), mcpCalls)).toEqual([]);
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call_update", toolCallId: "m", title: "pi-bridge_pi_echo",
			kind: "other", status: "in_progress", _meta: mcpMeta }), mcpCalls)).toEqual([]);
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call_update", toolCallId: "m", status: "completed",
			content: [{ type: "content", content: { type: "text", text: "Probe echo" } }], rawOutput: "Probe echo" }), mcpCalls)).toEqual([]);
		expect(mcpCalls.size).toBe(0);
	});

	it("still reports native tool calls and their updates", () => {
		const mcpCalls = new Set<string>();
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call", toolCallId: "n", title: "echo probe",
			kind: "execute", status: "pending" }), mcpCalls)).toEqual([{ type: "tool", isUpdate: false,
			text: "\n[Antigravity tool: echo probe — pending]\n", compactText: "\n[Antigravity tool: echo probe — pending]\n" }]);
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call_update", toolCallId: "n", status: "completed" }), mcpCalls))
			.toMatchObject([{ type: "tool", isUpdate: true }]);
		expect(mcpCalls.size).toBe(0);
	});
});
