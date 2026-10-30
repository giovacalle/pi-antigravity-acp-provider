import { normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AcpSessionStore } from "../src/acp/session-store.js";
import { AntigravityRuntime, PERMISSION_TOOL_NAME, PERMISSION_RESULT_KIND } from "../src/runtime.js";
import type { NativeTools, PermissionMode } from "../src/config.js";
import type { PiEventWriter } from "../src/stream/pi-events.js";
import { piToolFingerprint, PiMcpBridge } from "../src/mcp/bridge.js";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model: Model<"antigravity-acp"> = { id: "gemini-test", name: "Test", api: "antigravity-acp", provider: "antigravity-acp", baseUrl: "", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 8192 };
const tools = [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }];
const roots: string[] = [];
const runtimes: AntigravityRuntime[] = [];
afterEach(async () => {
	await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(scenario?: string, mode: PermissionMode = "yolo", store?: AcpSessionStore, limits?: { idleTtlMs?: number; maxLiveSessions?: number; nativeTools?: NativeTools }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-safety-")); roots.push(root);
	const log = path.join(root, "calls.jsonl"); fs.writeFileSync(log, "");
	const connections: AntigravityAcpConnection[] = [];
	const runtime = new AntigravityRuntime((options) => {
		const connection = new AntigravityAcpConnection({ ...options, command: process.execPath,
			args: [fakeAgent, ...(scenario ? [scenario] : [])], env: { ...process.env, FAKE_AGENT_LOG_FILE: log } });
		connections.push(connection); return connection;
	}, mode, store, limits);
	runtimes.push(runtime);
	const entries = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; prompt?: unknown; mode?: string; _meta?: unknown });
	return { root, runtime, connections, entries };
}
async function drain(writer: PiEventWriter) { for await (const _event of writer.stream) void _event; return writer.message; }
function turn(runtime: AntigravityRuntime, messages: Context["messages"], sessionId = "safety") {
	return drain(runtime.stream(model, { messages }, { sessionId, apiKey: "test-key" }));
}
const user = (content: string, timestamp = 1): Context["messages"][number] => ({ role: "user", content, timestamp });

// Synthetic ACP processes only: no Google account or real agent actions.
describe("permission policy and lifecycle", () => {
	it.each(["no-mode-metadata", "no-default-mode"])("refuses unconfirmed new session policy: %s", async (scenario) => {
		const { runtime, entries } = setup(scenario, "default");
		const message = await turn(runtime, [user("hello")]);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("did not advertise permission mode 'default'");
		expect(entries().some((entry) => entry.method === "session/prompt")).toBe(false);
	});

	it("refuses an unsupported restored mode and removes that binding record", async () => {
		const initial = setup(undefined, "default");
		const store = new AcpSessionStore(path.join(initial.root, "sessions.json"));
		const first = setup(undefined, "default", store);
		const message = await turn(first.runtime, [user("hello")]);
		expect(message.stopReason).toBe("stop"); await first.runtime.close();
		const restored = setup("no-default-on-restore", "default", store);
		const response = await turn(restored.runtime, [user("hello"), message, user("next", 2)]);
		expect(response.errorMessage).toContain("restored session did not advertise");
		expect(restored.entries().some((entry) => entry.method === "session/prompt")).toBe(false);
		expect(store.get("safety")).toBeUndefined();
	});

	it.each(["no-auto-edit-mode", "set-mode-fails", "config-options-ignored-mode"])("closes sessions that cannot confirm a mode change: %s", async (scenario) => {
		const { runtime, entries } = setup(scenario, "default");
		const first = await turn(runtime, [user("hello")]); expect(first.stopReason).toBe("stop");
		await runtime.setPermissionMode("auto_edit");
		expect((await runtime.snapshot()).bindings).toBe(0);
		const second = await turn(runtime, [user("hello"), first, user("next", 2)]);
		expect(second.stopReason).toBe("error");
		expect(entries().filter((entry) => entry.method === "session/prompt")).toHaveLength(1);
	});

	it.each(["mode-drift", "config-options-mode-drift"])("closes a server that unexpectedly changes permission policy: %s", async (scenario) => {
		const { runtime } = setup(scenario, "default");
		const message = await turn(runtime, [user("hello")]);
		expect(message.stopReason).toBe("error"); expect(message.errorMessage).toContain("permission mode unexpectedly");
		await vi.waitFor(async () => expect((await runtime.snapshot()).bindings).toBe(0));
	});

	it("serializes competing mode changes on a modern server", async () => {
		const { runtime } = setup("config-options");
		await turn(runtime, [user("hello")]);
		await Promise.all([runtime.setPermissionMode("auto_edit"), runtime.setPermissionMode("default")]);
		expect((await runtime.snapshot()).processes[0]?.confirmedPermissionMode).toBe("default");
	});

	it("closes discovery still initializing and rejects late session creation", async () => {
		const { runtime, connections, entries } = setup("initialize-timeout");
		const discovery = runtime.discoverModels(undefined).catch((error: unknown) => error);
		const close = runtime.close();
		expect(runtime.close()).toBe(close);
		await close;
		expect(await discovery).toBeInstanceOf(Error);
		expect(connections[0]?.process.alive).toBe(false);
		expect(entries().some((entry) => entry.method === "session/new")).toBe(false);
	});
});

describe("native tool filter", () => {
	it("sends an empty builtin filter on session/new when native tools are off", async () => {
		const { runtime, entries } = setup(undefined, "yolo", undefined, { nativeTools: "none" });
		expect((await turn(runtime, [user("hello")])).stopReason).toBe("stop");
		expect(entries().find((entry) => entry.method === "session/new")?._meta).toEqual({ antigravity: { enabledTools: [] } });
		expect((await runtime.snapshot()).nativeTools).toBe("none");
	});

	it("sends no session metadata by default", async () => {
		const { runtime, entries } = setup();
		await turn(runtime, [user("hello")]);
		expect("_meta" in entries().find((entry) => entry.method === "session/new")!).toBe(false);
		expect((await runtime.snapshot()).nativeTools).toBe("all");
	});

	it("resends the filter when resuming a session saved under the same filter", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const first = setup(undefined, "yolo", store, { nativeTools: "none" });
		const message = await turn(first.runtime, [user("hello")]); await first.runtime.close();
		const second = setup(undefined, "yolo", store, { nativeTools: "none" });
		expect((await turn(second.runtime, [user("hello"), message, user("next", 2)])).stopReason).toBe("stop");
		expect(second.entries().find((entry) => entry.method === "session/resume")?._meta).toEqual({ antigravity: { enabledTools: [] } });
	});

	it("starts a fresh session instead of resuming one saved under a different filter", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const first = setup(undefined, "yolo", store, { nativeTools: "none" });
		const message = await turn(first.runtime, [user("hello")]); await first.runtime.close();
		const second = setup(undefined, "yolo", store);
		expect((await turn(second.runtime, [user("hello"), message, user("next", 2)])).stopReason).toBe("stop");
		expect(second.entries().some((entry) => entry.method === "session/resume" || entry.method === "session/load")).toBe(false);
		expect(second.entries().filter((entry) => entry.method === "session/new")).toHaveLength(1);
	});
});

describe("eager Pi tools", () => {
	const toolTurn = (runtime: AntigravityRuntime, messages: Context["messages"]) =>
		drain(runtime.stream(model, { tools, messages }, { sessionId: "eager", apiKey: "test-key" }));
	const eager = { eagerMcpServers: ["pi-bridge"], mcpMaxOutputBytes: 1048576 };

	it("loads the Pi bridge eagerly when tools are attached", async () => {
		const { runtime, entries } = setup();
		await toolTurn(runtime, [user("hello")]);
		expect(entries().find((entry) => entry.method === "session/new")?._meta).toEqual({ antigravity: eager });
	});

	it("merges eager loading with the builtin filter", async () => {
		const { runtime, entries } = setup(undefined, "yolo", undefined, { nativeTools: "none" });
		await toolTurn(runtime, [user("hello")]);
		expect(entries().find((entry) => entry.method === "session/new")?._meta).toEqual({ antigravity: { enabledTools: [], ...eager } });
	});

	it("sends no eager keys without tools", async () => {
		const { runtime, entries } = setup();
		await turn(runtime, [user("hello")]);
		expect("_meta" in entries().find((entry) => entry.method === "session/new")!).toBe(false);
	});

	it("sends no eager keys when the agent lacks MCP over HTTP", async () => {
		const { runtime, entries } = setup("no-mcp");
		await toolTurn(runtime, [user("hello")]);
		expect("_meta" in entries().find((entry) => entry.method === "session/new")!).toBe(false);
	});

	it("resends eager loading on resume", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const first = setup(undefined, "yolo", store);
		const message = await toolTurn(first.runtime, [user("hello")]); await first.runtime.close();
		const second = setup(undefined, "yolo", store);
		expect((await toolTurn(second.runtime, [user("hello"), message, user("next", 2)])).stopReason).toBe("stop");
		expect(second.entries().find((entry) => entry.method === "session/resume")?._meta).toEqual({ antigravity: eager });
	});
});

describe("context size from usage_update", () => {
	it("reports each message's context size instead of the turn's summed usage", async () => {
		const { runtime } = setup();
		const first = await drain(runtime.stream(model, { tools, messages: [user("bridge usage")] }, { sessionId: "usage", apiKey: "test-key" }));
		expect(first.stopReason).toBe("toolUse");
		expect(first.usage.totalTokens).toBe(1000);
		const call = first.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing call");
		const final = await drain(runtime.stream(model, { tools, messages: [user("bridge usage"), first,
			{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "done" }], isError: false, timestamp: 2 },
		] }, { sessionId: "usage", apiKey: "test-key" }));
		expect(final.stopReason).toBe("stop");
		expect(final.usage).toMatchObject({ input: 2400, output: 200, totalTokens: 1800 });
	});

	it("removes the double-counted cache read on a single-inference prompt", async () => {
		const { runtime } = setup();
		const message = await turn(runtime, [user("usage single")]);
		expect(message.usage).toMatchObject({ input: 600, cacheRead: 400, totalTokens: 1200 });
	});
});

describe("quota exhaustion", () => {
	function quotaSetup() {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		return { store, ...setup("quota-exhausted", "yolo", store) };
	}

	it("ends the turn with an error that carries the relative reset time", async () => {
		const { runtime, store } = quotaSetup();
		const message = await turn(runtime, [user("relative")], "quota");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/^Antigravity quota exceeded for \S+\. Resets at \S+\.$/u);
		expect(message.errorMessage).not.toMatch(/429|rate limit|try again in|reset in/iu);
		const resetAt = Date.parse(/Resets at (\S+)\.$/u.exec(message.errorMessage!)![1]!);
		expect(Math.abs(resetAt - (Date.now() + 231 * 60_000))).toBeLessThan(60_000);
		const snapshot = await runtime.snapshot();
		expect(snapshot.bindings).toBe(1);
		expect(snapshot.processes[0]?.alive).toBe(true);
		expect(store.get("quota")?.messageCount ?? 0).toBe(0);
	});

	it("converts the absolute reset date to ISO", async () => {
		const { runtime } = quotaSetup();
		const message = await turn(runtime, [user("absolute")], "quota");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Resets at 2026-10-02T14:00:00.000Z.");
	});

	it("treats a refusal carrying the quota message as an error", async () => {
		const { runtime } = quotaSetup();
		const message = await turn(runtime, [user("refusal")], "quota");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/quota exceeded/u);
	});

	it("leaves a normal reply that quotes the wording untouched", async () => {
		const { runtime } = quotaSetup();
		const message = await turn(runtime, [user("quoted")], "quota");
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("You have reached your current quota") })]);
	});
});

describe("session lifecycle", () => {
	it("closes only the ending session and keeps its saved record", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const { runtime, connections } = setup(undefined, "yolo", store);
		await turn(runtime, [user("a")], "A");
		const first = await turn(runtime, [user("b")], "B");

		await runtime.closeSession("A");

		await connections[0]!.process.exited;
		expect(connections[1]!.process.alive).toBe(true);
		expect(store.get("A")).toBeDefined();
		const next = await turn(runtime, [user("b"), first, user("next", 2)], "B");
		expect(next.stopReason).toBe("stop");
		expect((await runtime.snapshot()).processes[0]?.pid).toBe(connections[1]!.process.pid);
		expect(connections).toHaveLength(2);
	});

	it("aborts and waits for an in-flight turn before closing its session", async () => {
		const { runtime, connections, entries } = setup();
		const writer = runtime.stream(model, { messages: [user("hang")] }, { sessionId: "A", apiKey: "test-key" });
		const events: Array<{ type: string; reason?: string }> = [];
		const drained = (async () => { for await (const event of writer.stream) events.push(event); })();
		await vi.waitFor(() => expect(entries().some((entry) => entry.method === "session/prompt")).toBe(true));

		await runtime.closeSession("A");

		await drained;
		expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
		await connections[0]!.process.exited;
		expect((await runtime.snapshot()).bindings).toBe(0);
	});

	it("keeps neither a binding nor a saved record for one-off requests", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const { runtime, connections } = setup(undefined, "yolo", store);
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		for (const sessionId of ids) {
			const message = await drain(runtime.stream(model, { messages: [user("summarize")] }, { sessionId, cacheRetention: "none", apiKey: "test-key" }));
			expect(message.stopReason).toBe("stop");
		}

		expect((await runtime.snapshot()).bindings).toBe(0);
		for (const id of ids) expect(store.get(id)).toBeUndefined();
		await Promise.all(connections.map((connection) => connection.process.exited));
		expect(connections).toHaveLength(3);
	});

	it("resumes a one-off request's parked permission and then drops its binding", async () => {
		const { runtime, connections } = setup();
		const options = { sessionId: randomUUID(), cacheRetention: "none" as const, apiKey: "test-key" };
		const messages = [user("request permission")];
		const first = await drain(runtime.stream(model, { messages }, options));
		const call = first.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing permission tool call");

		const second = await drain(runtime.stream(model, { messages: [...messages, first, { role: "toolResult", toolCallId: call.id,
			toolName: PERMISSION_TOOL_NAME, content: [{ type: "text", text: "Rejected" }], isError: false, timestamp: 2,
			details: { kind: PERMISSION_RESULT_KIND, requestId: call.id, optionId: "reject-once", cancelled: false } }] }, options));

		expect(second.stopReason).toBe("stop");
		expect(connections).toHaveLength(1);
		expect((await runtime.snapshot()).bindings).toBe(0);
	});
});

describe("idle eviction", () => {
	afterEach(() => { vi.useRealTimers(); });

	it("evicts an idle session and resumes it on the next turn", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		// Real setTimeout keeps ACP request deadlines working.
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		const { runtime, connections, entries } = setup(undefined, "yolo", store, { idleTtlMs: 1_000 });
		const first = await turn(runtime, [user("first")], "idle");
		expect(first.stopReason).toBe("stop");

		vi.advanceTimersByTime(2_000);

		await connections[0]!.process.exited;
		const evicted = await runtime.snapshot();
		expect(evicted.bindings).toBe(0);
		expect(evicted.evictions).toBe(1);
		const next = await turn(runtime, [user("first"), first, user("next", 2)], "idle");
		expect(next.stopReason).toBe("stop");
		expect(entries().some((entry) => entry.method === "session/resume")).toBe(true);
		expect((await runtime.snapshot()).processes[0]?.restored).toBe(true);
	});

	it("never evicts a session awaiting permission", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		const { runtime, connections } = setup(undefined, "yolo", undefined, { idleTtlMs: 1_000 });
		const parked = await turn(runtime, [user("request permission")], "parked");
		expect(parked.stopReason).toBe("toolUse");

		vi.advanceTimersByTime(2_000);

		const snapshot = await runtime.snapshot();
		expect(snapshot.bindings).toBe(1);
		expect(snapshot.processes[0]?.waitingForPermission).toBe(true);
		expect(snapshot.evictions).toBe(0);
		expect(connections[0]!.process.alive).toBe(true);
	});
});

describe("live session cap", () => {
	it("evicts the least recently used idle session before spawning past the cap", async () => {
		const { runtime, connections } = setup(undefined, "yolo", undefined, { maxLiveSessions: 2 });
		const first = await turn(runtime, [user("hello")], "A");
		expect((await turn(runtime, [user("hello")], "B")).stopReason).toBe("stop");
		expect((await turn(runtime, [user("hello"), first, user("again", 2)], "A")).stopReason).toBe("stop");
		expect((await turn(runtime, [user("hello")], "C")).stopReason).toBe("stop");

		await connections[1]!.process.exited;
		expect(connections).toHaveLength(3);
		expect(connections[0]!.process.alive).toBe(true);
		expect(connections[2]!.process.alive).toBe(true);
		const snapshot = await runtime.snapshot();
		expect(snapshot.bindings).toBe(2);
		expect(snapshot.capEvictions).toBe(1);
		expect(snapshot.evictions).toBe(0);
		expect(snapshot.capOverflows).toBe(0);
	});

	it("counts sessions that are still starting against the cap", async () => {
		const { runtime, connections } = setup(undefined, "yolo", undefined, { maxLiveSessions: 2 });
		expect((await turn(runtime, [user("hello")], "A")).stopReason).toBe("stop");

		const started = await Promise.all([turn(runtime, [user("hello")], "B"), turn(runtime, [user("hello")], "C")]);

		expect(started.map((message) => message.stopReason)).toEqual(["stop", "stop"]);
		await connections[0]!.process.exited;
		const snapshot = await runtime.snapshot();
		expect(snapshot.bindings).toBe(2);
		expect(snapshot.capEvictions).toBe(1);
		expect(snapshot.capOverflows).toBe(0);
	});

	it("exceeds the cap rather than touching busy sessions", async () => {
		const { runtime, connections } = setup(undefined, "yolo", undefined, { maxLiveSessions: 2 });
		for (const sessionId of ["A", "B"]) expect((await turn(runtime, [user("request permission")], sessionId)).stopReason).toBe("toolUse");

		expect((await turn(runtime, [user("hello")], "C")).stopReason).toBe("stop");

		const snapshot = await runtime.snapshot();
		expect(snapshot.bindings).toBe(3);
		expect(snapshot.capOverflows).toBe(1);
		expect(snapshot.processes.filter((process) => process.waitingForPermission).map((process) => process.key).sort()).toEqual(["sid:A", "sid:B"]);
		expect(connections[0]!.process.alive).toBe(true);
		expect(connections[1]!.process.alive).toBe(true);
	});
});

describe("instruction updates during continuations", () => {
	it.each([false, true])("rebuilds with changed instructions instead of pretending they reached ACP (restart=%s)", async (restart) => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const firstRuntime = setup(undefined, "yolo", store);
		const firstContext = normalizeContext({ systemPrompt: "ORIGINAL_RULE", tools, messages: [user("use bridge")] });
		const first = await drain(firstRuntime.runtime.stream(model, firstContext, { sessionId: "rules", apiKey: "test-key" }));
		const call = first.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing call");
		const context = normalizeContext({ messages: [...firstContext.messages, first,
			{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "completed" }], isError: false, timestamp: 2 },
			{ role: "system", content: "UPDATED_RULE", timestamp: 3 },
		] });
		const second = await drain(firstRuntime.runtime.stream(model, context, { sessionId: "rules", apiKey: "test-key" }));
		expect(second.stopReason).toBe("stop"); expect(store.get("rules")).toBeUndefined();
		const next = restart ? setup(undefined, "yolo", store) : firstRuntime;
		if (restart) await firstRuntime.runtime.close();
		const third = await drain(next.runtime.stream(model, normalizeContext({ messages: [...context.messages, second, user("next", 4)] }), { sessionId: "rules", apiKey: "test-key" }));
		expect(third.stopReason).toBe("stop");
		const prompts = next.entries().filter((entry) => entry.method === "session/prompt");
		expect(JSON.stringify(prompts.at(-1)?.prompt)).toContain("UPDATED_RULE");
		if (!restart) expect(firstRuntime.connections).toHaveLength(2);
	});

	it("preserves instructions arriving during a permission continuation", async () => {
		const { runtime, entries } = setup();
		const context = normalizeContext({ systemPrompt: "ORIGINAL", messages: [user("permission")] });
		const first = await drain(runtime.stream(model, context, { sessionId: "permission-rules", apiKey: "test-key" }));
		const call = first.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing broker");
		const resumed = normalizeContext({ messages: [...context.messages, first,
			{ role: "toolResult", toolCallId: call.id, toolName: PERMISSION_TOOL_NAME,
				content: [{ type: "text", text: "Rejected" }], details: { kind: PERMISSION_RESULT_KIND, requestId: call.id, optionId: "reject-once", cancelled: false }, isError: false, timestamp: 2 },
			{ role: "system", content: "NEW_RULE", timestamp: 3 },
		] });
		const second = await drain(runtime.stream(model, resumed, { sessionId: "permission-rules", apiKey: "test-key" }));
		expect(second.stopReason).toBe("stop");
		await drain(runtime.stream(model, normalizeContext({ messages: [...resumed.messages, second, user("next", 4)] }), { sessionId: "permission-rules", apiKey: "test-key" }));
		expect(JSON.stringify(entries().filter((entry) => entry.method === "session/prompt").at(-1)?.prompt)).toContain("NEW_RULE");
	});

	it("reports oversized instructions as a stream error before spawning", async () => {
		const { runtime, connections } = setup();
		const message = await drain(runtime.stream(model, { systemPrompt: "x".repeat(270000), messages: [user("hello")] }));
		expect(message.errorMessage).toContain("system instructions exceed");
		expect(connections).toHaveLength(0);
	});
});

describe("abort cleanup", () => {
	it.each(["use bridge", "permission"])("answers parked requests on abort and keeps a healthy process: %s", async (text) => {
		const { runtime } = setup();
		const controller = new AbortController();
		const first = await drain(runtime.stream(model, { tools, messages: [user(text)] }, { sessionId: "abort", apiKey: "test-key", signal: controller.signal }));
		expect(first.stopReason).toBe("toolUse");
		controller.abort();
		await vi.waitFor(async () => {
			const snapshot = await runtime.snapshot();
			expect(snapshot.processes[0]?.waitingForTools).toBe(0);
			expect(snapshot.processes[0]?.waitingForPermission).toBe(false);
		}, { timeout: 3000 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect((await runtime.snapshot()).processes[0]?.alive).toBe(true);
		const next = await turn(runtime, [user("hello")], "abort"); expect(next.stopReason).toBe("stop");
	});

	it("cancels a parked turn before applying a new permission policy", async () => {
		const { runtime } = setup();
		await drain(runtime.stream(model, { tools, messages: [user("use bridge")] }, { sessionId: "mode-running", apiKey: "test-key" }));
		await runtime.setPermissionMode("default");
		expect((await runtime.snapshot()).bindings).toBe(0);
		expect((await turn(runtime, [user("next")], "mode-running")).stopReason).toBe("stop");
		expect((await runtime.snapshot()).processes[0]?.confirmedPermissionMode).toBe("default");
	});

	it("keeps a Pi call parked beyond the former two-minute deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
		const { runtime } = setup();
		try {
			const first = await drain(runtime.stream(model, { tools, messages: [user("use bridge")] }, { sessionId: "long-tool", apiKey: "test-key" }));
			const call = first.content.find((block) => block.type === "toolCall");
			if (call?.type !== "toolCall") throw new Error("missing tool");
			vi.advanceTimersByTime(130_000);
			expect((await runtime.snapshot()).processes[0]?.waitingForTools).toBe(1);
			const second = await drain(runtime.stream(model, { tools, messages: [user("use bridge"), first,
				{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "long tool result" }], isError: false, timestamp: 2 },
			] }, { sessionId: "long-tool", apiKey: "test-key" }));
			expect(second.content).toEqual([{ type: "text", text: "long tool result" }]);
		} finally { vi.useRealTimers(); await runtime.close(); }
	});

	it("releases partially parked calls and rejects new calls after abort", async () => {
		const { runtime } = setup();
		const internals = runtime as unknown as { requestPiTool(binding: unknown, invocation: unknown): Promise<{ isError?: boolean }> };
		const release = vi.fn();
		const binding = { session: { sessionId: "unit" }, connection: { holdPromptWatchdog: () => release },
			writer: { finished: false, toolCall: () => { throw new Error("writer failed"); } }, permission: undefined,
			pendingTools: new Map(), abortRequested: false, toolBatchTimer: undefined };
		expect(await internals.requestPiTool(binding, { id: "one", name: "echo", arguments: {} })).toMatchObject({ isError: true });
		expect(release).toHaveBeenCalledTimes(1); expect(binding.pendingTools.size).toBe(0);
		binding.abortRequested = true;
		expect(await internals.requestPiTool(binding, { id: "two", name: "echo", arguments: {} })).toMatchObject({ isError: true });
		expect(release).toHaveBeenCalledTimes(1);
	});

	it("cancels late or partially exposed permissions without leaving a timer", async () => {
		vi.useFakeTimers();
		try {
			// No idle sweep, so the timer count covers only permission timers.
			const { runtime } = setup(undefined, "yolo", undefined, { idleTtlMs: 0 });
			const internals = runtime as unknown as { requestPermission(binding: unknown, request: unknown): Promise<unknown> };
			const binding = { session: { sessionId: "unit" }, abortRequested: false, permission: undefined,
				writer: { finished: true, toolCall: vi.fn(() => { throw new Error("cannot expose"); }), done: vi.fn() } };
			const request = { sessionId: "unit", options: [], toolCall: { toolCallId: "native" } };
			const cancelled = { outcome: { outcome: "cancelled" } };
			expect(await internals.requestPermission(binding, request)).toEqual(cancelled);
			expect(binding.writer.toolCall).not.toHaveBeenCalled();
			binding.writer.finished = false;
			expect(await internals.requestPermission(binding, request)).toEqual(cancelled);
			expect(binding.permission).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
			binding.abortRequested = true;
			expect(await internals.requestPermission(binding, request)).toEqual(cancelled);
			expect(binding.writer.toolCall).toHaveBeenCalledTimes(1);
		} finally { vi.useRealTimers(); }
	});

	it("does not kill a newer turn with an old continuation grace timer", async () => {
		vi.useFakeTimers();
		let complete!: () => void;
		let pending: Promise<void> | undefined;
		try {
			const { runtime } = setup();
			const internals = runtime as unknown as { awaitContinuation(binding: unknown, signal?: AbortSignal): Promise<void> };
			const binding = { session: { sessionId: "unit" }, abortRequested: false, pendingTools: new Map(),
				turnCompletion: new Promise<void>((resolve) => { complete = resolve; }),
				connection: { cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } };
			const controller = new AbortController();
			pending = internals.awaitContinuation(binding, controller.signal);
			controller.abort(); expect(binding.connection.cancel).toHaveBeenCalledTimes(1);
			binding.turnCompletion = new Promise<void>(() => undefined);
			vi.advanceTimersByTime(1500);
			expect(binding.connection.close).not.toHaveBeenCalled();
		} finally { complete?.(); await pending; vi.useRealTimers(); }
	});

	it("does not abort an idle binding or a newer turn through an old continuation", async () => {
		const { runtime } = setup();
		const internals = runtime as unknown as { awaitContinuation(binding: unknown, signal?: AbortSignal): Promise<void> };
		let complete!: () => void;
		const binding = { turnCompletion: undefined as Promise<void> | undefined, abortRequested: false, session: { sessionId: "unit" }, connection: { cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } };
		await internals.awaitContinuation(binding, AbortSignal.abort());
		expect(binding.abortRequested).toBe(false); expect(binding.connection.cancel).not.toHaveBeenCalled();
		binding.turnCompletion = new Promise<void>((resolve) => { complete = resolve; });
		const controller = new AbortController();
		const pending = internals.awaitContinuation(binding, controller.signal);
		binding.turnCompletion = new Promise<void>(() => undefined); controller.abort(); complete(); await pending;
		expect(binding.connection.cancel).not.toHaveBeenCalled(); expect(binding.connection.close).not.toHaveBeenCalled();
	});
});

describe("context handoff transport", () => {
	it("sends active text/images and bounded labelled results through the ACP child", async () => {
		const { runtime, entries } = setup();
		const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
		const context = normalizeContext({ messages: [
			{ role: "system", content: "BASE_RULE", sections: { rule: "OLD_RULE" }, timestamp: 0 },
			{ role: "user", content: [{ type: "text", text: "ACTIVE_REQUEST" }, image], timestamp: 1 },
			{ role: "assistant", content: [{ type: "toolCall", id: "external-call", name: "read", arguments: { path: "a.ts" } }],
				api: model.api, provider: "other-provider", model: "external", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
			{ role: "toolResult", toolCallId: "external-call", toolName: "read", content: [{ type: "text", text: "x".repeat(40_000) + "RESULT_TAIL" }], isError: false, timestamp: 3 },
			{ role: "system", content: "NEW_RULE", sections: { rule: "UPDATED_RULE" }, timestamp: 4 },
		] });
		const response = await drain(runtime.stream({ ...model, input: ["text", "image"] }, context, { sessionId: "handoff", apiKey: "test-key" }));
		expect(response.stopReason).toBe("stop");
		const prompts = entries().filter((entry) => entry.method === "session/prompt");
		expect(prompts).toHaveLength(1);
		const prompt = prompts[0]!.prompt as Array<{ type: string; resource?: { text?: string }; text?: string }>;
		expect(prompt).toContainEqual({ type: "text", text: "ACTIVE_REQUEST" });
		expect(prompt).toContainEqual(image);
		const reconstruction = prompt[0]!.resource!.text!;
		expect(reconstruction).toContain("BASE_RULE");
		expect(reconstruction).toContain("NEW_RULE");
		expect(reconstruction).toContain("UPDATED_RULE");
		expect(reconstruction).not.toContain("OLD_RULE");
		expect(reconstruction).toContain("[tool call read id=external-call]");
		expect(reconstruction).toContain("## Tool result (read id=external-call)");
		expect(reconstruction).toContain("RESULT_TAIL");
		expect(reconstruction.slice(reconstruction.indexOf("# Prior conversation")).length).toBeLessThanOrEqual(32_000);
	});
});

describe("tool projection diagnostics", () => {
	it.each([undefined, "no-mcp"])("reports omitted tools and their reasons (agent=%s)", async (scenario) => {
		const { runtime } = setup(scenario);
		const writer = runtime.stream(model, { tools: [{ name: "unsupported", description: "bad", parameters: Type.String() }], messages: [user("hello")] }, { sessionId: "omissions", apiKey: "test-key" });
		await drain(writer);
		expect((await runtime.snapshot()).processes[0]?.omittedTools).toEqual([{ name: "unsupported", reason: expect.stringContaining(scenario ? "MCP over HTTP" : "not_object") }]);
	});

	it("revalidates changed tools before a continuation early return", async () => {
		const { runtime, connections, entries } = setup();
		const first = await drain(runtime.stream(model, { tools, messages: [user("use bridge")] }, { sessionId: "changed-tools", apiKey: "test-key" }));
		const call = first.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing tool");
		const next = await drain(runtime.stream(model, { tools: [...tools, { name: "unprojectable", description: "bad", parameters: Type.String() }], messages: [user("use bridge"), first,
			{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "result" }], isError: false, timestamp: 2 },
		] }, { sessionId: "changed-tools", apiKey: "test-key" }));
		expect(next.stopReason).toBe("stop"); expect(connections).toHaveLength(2);
		expect((await runtime.snapshot()).processes[0]?.omittedTools[0]?.name).toBe("unprojectable");
		const prompts = entries().filter((entry) => entry.method === "session/prompt");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]?.prompt).toContainEqual({ type: "text", text: "use bridge" });
		expect(JSON.stringify(prompts[1]?.prompt)).toContain(`tool call echo id=${call.id}`);
	});

	it("names all capped tools, excludes the permission broker and fingerprints descriptions/omissions", () => {
		const active = Array.from({ length: 67 }, (_, i) => ({ name: `t${i}`, description: "tool", parameters: Type.Object({}) }));
		const bridge = new PiMcpBridge({ tools: [...active, { name: PERMISSION_TOOL_NAME, description: "broker", parameters: Type.Object({}) }], onCall: async () => ({ content: [] }) });
		expect(bridge.omissions.map((entry) => entry.name)).toEqual(["t64", "t65", "t66"]);
		expect(piToolFingerprint(tools)).not.toBe(piToolFingerprint([{ ...tools[0]!, description: "changed" }]));
		expect(piToolFingerprint(tools)).not.toBe(piToolFingerprint([...tools, { name: "bad", description: "bad", parameters: Type.String() }]));
	});
});
