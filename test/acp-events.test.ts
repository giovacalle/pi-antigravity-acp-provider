import type { SessionNotification } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { mapSessionUpdate, type ToolCallEntry } from "../src/acp/events.js";

const note = (update: Record<string, unknown>) => ({ sessionId: "s", update } as unknown as SessionNotification);
const mcpMeta = { mcp: { tool: "pi_echo", server: "pi-bridge" }, is_mcp_tool_call: true };

describe("mapSessionUpdate", () => {
	it("drops MCP tool calls even when the completion lacks _meta", () => {
		const calls = new Map<string, ToolCallEntry>();
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call", toolCallId: "m", title: "pi-bridge_pi_echo",
			kind: "other", status: "pending", _meta: mcpMeta }), calls)).toEqual([]);
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call_update", toolCallId: "m", title: "pi-bridge_pi_echo",
			kind: "other", status: "in_progress", _meta: mcpMeta }), calls)).toEqual([]);
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call_update", toolCallId: "m", status: "completed",
			content: [{ type: "content", content: { type: "text", text: "Probe echo" } }], rawOutput: "Probe echo" }), calls)).toEqual([]);
		expect(calls.size).toBe(0);
	});

	it("reports a native tool once on its terminal status without content", () => {
		const calls = new Map<string, ToolCallEntry>();
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call", toolCallId: "n", title: "echo probe",
			kind: "execute", status: "pending" }), calls)).toEqual([]);
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call_update", toolCallId: "n", status: "in_progress" }), calls)).toEqual([]);
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call_update", toolCallId: "n", status: "completed",
			content: [{ type: "content", content: { type: "text", text: "probe" } }], rawOutput: "probe" }), calls))
			.toEqual([{ type: "tool", text: "\n[Antigravity tool: echo probe — completed]\n" }]);
		expect(calls.size).toBe(0);
	});

	it("labels a terminal update for an unknown call with its id", () => {
		expect(mapSessionUpdate(note({ sessionUpdate: "tool_call_update", toolCallId: "late", status: "failed" }), new Map()))
			.toEqual([{ type: "tool", text: "\n[Antigravity tool: late — failed]\n" }]);
	});

	it("keeps plan and thought mappings", () => {
		const calls = new Map<string, ToolCallEntry>();
		expect(mapSessionUpdate(note({ sessionUpdate: "plan", entries: [{ content: "step", status: "pending", priority: "high" }] }), calls))
			.toEqual([{ type: "plan", text: "\n[Antigravity plan]\n- [pending] step\n" }]);
		expect(mapSessionUpdate(note({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } }), calls))
			.toEqual([{ type: "thought", delta: "hm" }]);
	});
});
