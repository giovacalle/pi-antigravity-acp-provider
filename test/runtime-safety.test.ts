import { isContextOverflow, isRetryableAssistantError, normalizeContext, type Context, type Model } from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { retryAssistantCall } from "@earendil-works/pi-ai/utils/retry";
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
import type { PermissionMode } from "../src/config.js";
import type { AntigravityQuotaSnapshot } from "../src/acp/usage-quota.js";
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

function setup(
	scenario?: string,
	mode: PermissionMode = "yolo",
	store?: AcpSessionStore,
	runtimeOptions?: { maxBindings?: number; idleMs?: number; modeIds?: string[]; restoredModeIds?: string[]; emitModeUpdates?: boolean },
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-runtime-safety-")); roots.push(root);
	const log = path.join(root, "calls.jsonl"); fs.writeFileSync(log, "");
	const connections: AntigravityAcpConnection[] = [];
	const runtime = new AntigravityRuntime((options) => {
		const connection = new AntigravityAcpConnection({ ...options, command: process.execPath,
			args: [fakeAgent, ...(scenario ? [scenario] : [])], env: { ...options.env, FAKE_AGENT_LOG_FILE: log, FAKE_AGENT_MODE_IDS: runtimeOptions?.modeIds?.join(","), FAKE_AGENT_RESTORED_MODE_IDS: runtimeOptions?.restoredModeIds?.join(","), ...(runtimeOptions?.emitModeUpdates ? { FAKE_AGENT_EMIT_MODE_UPDATES: "1" } : {}) } });
		connections.push(connection); return connection;
	}, mode, store, runtimeOptions);
	runtimes.push(runtime);
	const entries = () => fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { method: string; prompt?: unknown; mode?: string });
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

describe("early lifecycle and setup cancellation", () => {
	it.each(["initialize-timeout", "session-timeout"])("starts before slow %s and stays cancellable", async (scenario) => {
		const { runtime, connections, entries } = setup(scenario);
		const controller = new AbortController();
		const writer = runtime.stream(model, { messages: [user("hello")] }, { sessionId: "early-start", signal: controller.signal });
		const iterator = writer.stream[Symbol.asyncIterator]();
		expect((await iterator.next()).value).toMatchObject({ type: "start", partial: { content: [] } });
		await vi.waitFor(() => expect(entries().some((entry) => entry.method === (scenario === "session-timeout" ? "session/new" : "initialize"))).toBe(true));
		controller.abort();
		const events = [];
		for (;;) { const next = await iterator.next(); if (next.done) break; events.push(next.value); }
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(writer.message.stopReason).toBe("aborted");
		expect(writer.message.content).toEqual([]);
		await vi.waitFor(() => expect(connections[0]!.process.alive).toBe(false));
	});

	it("does not start work for a pre-aborted request", async () => {
		const { runtime, connections } = setup();
		const controller = new AbortController(); controller.abort();
		const writer = runtime.stream(model, { messages: [user("hello")] }, { signal: controller.signal });
		const events = [];
		for await (const event of writer.stream) events.push(event.type);
		expect(events).toEqual(["error"]);
		expect(connections).toHaveLength(0);
	});
});

describe("host permission mode negotiation", () => {
	const hostModes = ["default", "accept-edits", "auto", "plan"];

	it.each([undefined, "config-options"])("confirms the advertised edit-policy alias (%s)", async (scenario) => {
		const { runtime, entries } = setup(scenario, "auto_edit", undefined, { modeIds: hostModes });
		expect((await turn(runtime, [user("hello")])).stopReason).toBe("stop");
		expect(entries().find((entry) => entry.method === "session/prompt")?.mode).toBe("accept-edits");
		expect((await runtime.snapshot()).processes[0]).toMatchObject({ confirmedPermissionMode: "auto_edit", confirmedAcpModeId: "accept-edits" });
	});

	it("does not silently substitute auto or default for yolo", async () => {
		const { runtime, entries } = setup("config-options", "yolo", undefined, { modeIds: hostModes });
		const message = await turn(runtime, [user("hello")]);
		expect(message.errorMessage).toContain("Advertised modes: default, accept-edits, auto, plan");
		expect(message.errorMessage).toContain("/antigravity-acp permissions default");
		expect(entries().some((entry) => entry.method === "session/prompt")).toBe(false);
	});

	it.each([undefined, "config-options"])("changes a warm session to the alias and back to default with update notifications (%s)", async (scenario) => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-warm-mode-update-")); roots.push(root);
		const store = new AcpSessionStore(path.join(root, "sessions.json"));
		const { runtime, connections } = setup(scenario, "default", store, { modeIds: hostModes, emitModeUpdates: true });
		await turn(runtime, [user("hello")]);
		const pid = (await runtime.snapshot()).processes[0]?.pid;
		await runtime.setPermissionMode("auto_edit");
		expect((await runtime.snapshot()).processes[0]).toMatchObject({ pid, alive: true, confirmedPermissionMode: "auto_edit", confirmedAcpModeId: "accept-edits" });
		expect(store.get("safety")).toBeDefined();
		await runtime.setPermissionMode("default");
		expect((await runtime.snapshot()).processes[0]).toMatchObject({ pid, alive: true, confirmedPermissionMode: "default", confirmedAcpModeId: "default" });
		expect(connections).toHaveLength(1);
	});

	it("rejects an ignored alias selection", async () => {
		const { runtime, entries } = setup("config-options-ignored-mode", "auto_edit", undefined, { modeIds: hostModes });
		expect((await turn(runtime, [user("hello")])).errorMessage).toContain("did not confirm");
		expect(entries().some((entry) => entry.method === "session/prompt")).toBe(false);
	});

	it("rejects unexpected drift away from the confirmed alias", async () => {
		const { runtime } = setup("config-options-mode-drift", "auto_edit", undefined, { modeIds: hostModes });
		expect((await turn(runtime, [user("hello")])).errorMessage).toContain("permission mode unexpectedly");
	});

	it("renegotiates restored aliases and removes unsupported saved bindings", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-alias-restore-")); roots.push(root);
		const store = new AcpSessionStore(path.join(root, "sessions.json"));
		const first = setup("config-options", "auto_edit", store, { modeIds: hostModes });
		const response = await turn(first.runtime, [user("hello")]);
		await first.runtime.close();
		const restored = setup("config-options", "auto_edit", store, { modeIds: hostModes });
		expect((await turn(restored.runtime, [user("hello"), response, user("next", 2)])).stopReason).toBe("stop");
		expect((await restored.runtime.snapshot()).processes[0]).toMatchObject({ restored: true, confirmedAcpModeId: "accept-edits" });
		await restored.runtime.close();
		const unsupported = setup("config-options", "auto_edit", store, { modeIds: hostModes, restoredModeIds: ["default", "auto", "plan"] });
		expect((await turn(unsupported.runtime, [user("hello"), response, user("next", 2)])).errorMessage).toContain("restored session did not advertise");
		expect(store.get("safety")).toBeUndefined();
	});
});

describe("context size from usage_update", () => {
	it.each([
		["usage multi", false, 1076000, 0, 8192],
		["usage multi cached", false, 356000, 720000, 8192],
		["usage multi cached boundary", false, 1086000, 720000, 1],
		["usage multi cached overflow", true, 1186000, 720000, 1],
	] as const)("detects overflow from the latest context, not billed tokens: %s", async (prompt, overflow, input, cacheRead, budget) => {
		const { runtime } = setup();
		const message = await turn(runtime, [user(prompt)]);
		expect(message.stopReason).toBe("stop");
		expect(isContextOverflow(message, model.contextWindow)).toBe(overflow);
		expect(message.usage.input + message.usage.cacheRead).toBeLessThanOrEqual(message.usage.totalTokens);
		expect(estimateContextTokens([message]).usageTokens).toBe(message.usage.totalTokens);
		expect(clampMaxTokensToContext(model, normalizeContext({ messages: [message] }), model.maxTokens)).toBe(budget);
		expect((await runtime.snapshot()).metrics.totals).toMatchObject({ turns: 1, input, cacheRead, output: 4000 });
	});

	it("preserves explicit context overflow errors", async () => {
		const { runtime } = setup();
		const message = await turn(runtime, [user("usage overflow error")]);
		expect(message.stopReason).toBe("error");
		expect(isContextOverflow(message, model.contextWindow)).toBe(true);
	});

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
		expect(final.usage).toMatchObject({ output: 200, totalTokens: 1800 });
		expect(isContextOverflow(final, 1800)).toBe(false);
	});

	it("removes the double-counted cache read on a single-inference prompt", async () => {
		const { runtime } = setup();
		const first = await turn(runtime, [user("usage single")]);
		expect(first.usage).toMatchObject({ input: 600, cacheRead: 400, totalTokens: 1200 });
		const second = await turn(runtime, [user("usage single"), first, user("usage single", 3)]);
		expect(second.usage).toMatchObject({ input: 600, cacheRead: 400, totalTokens: 1200 });
	});

	it.each([
		["usage single net", 1200],
		["usage single net drift", 1300],
	] as const)("does not subtract cache reads without evidence of double-counting: %s", async (prompt, expectedContext) => {
		const { runtime } = setup();
		const message = await turn(runtime, [user(prompt)]);
		expect(message.stopReason).toBe("stop");
		expect(message.usage).toMatchObject({ input: 600, cacheRead: 400, output: 200, totalTokens: expectedContext });
	});

	// Captures: https://github.com/zacbemis/pi-antigravity-acp-provider/issues/80#issuecomment-6936679859
	it.each([
		["1.5.0", [25814, 26766, 26947],
			[{ input: 25400, output: 639, reasoning: 516, cacheRead: 13635 },
				{ input: 7301, output: 457, reasoning: 264, cacheRead: 71480 },
				{ input: 2307, output: 98, reasoning: 93, cacheRead: 24542 }]],
		["1.4.3", [46697, 48600, 25630],
			[{ input: 28360, output: 1158, reasoning: 818, cacheRead: 57059 },
				{ input: 7185, output: 446, reasoning: 243, cacheRead: 68159 },
				{ input: 2280, output: 55, reasoning: 50, cacheRead: 23295 }]],
	] as const)("replays ACP %s captures across three turns without corrupting Pi's budget or billed cost", async (version, contexts, billed) => {
		const { runtime } = setup();
		const pricedModel = { ...model, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } };
		const messages: Context["messages"] = [];
		for (const [index, name] of ["warm cache", "multi-step", "single inference"].entries()) {
			messages.push(user(`usage capture ${version} ${name}`, Date.now()));
			const message = await drain(runtime.stream(pricedModel, { messages }, { sessionId: "captured-usage", apiKey: "test-key" }));
			expect(message.stopReason).toBe("stop");
			const context = contexts[index]!;
			const counters = billed[index]!;
			expect(message.usage.totalTokens).toBe(context);
			expect(message.usage.output).toBe(counters.output);
			expect(message.usage.reasoning).toBe(counters.reasoning);
			if (index === 2) {
				expect(message.usage).toMatchObject(counters);
			} else {
				// The final inference's cache split is unavailable; old ACP's used is an upper bound.
				expect(message.usage).toMatchObject({ input: context, cacheRead: 0 });
			}
			expect(isContextOverflow(message, model.contextWindow)).toBe(false);
			expect(message.usage.cost.input).toBeCloseTo(counters.input / 1_000_000, 10);
			expect(message.usage.cost.output).toBeCloseTo(counters.output * 2 / 1_000_000, 10);
			expect(message.usage.cost.cacheRead).toBeCloseTo(counters.cacheRead * 0.1 / 1_000_000, 10);
			messages.push(message);
			expect(estimateContextTokens(messages).usageTokens).toBe(context);
			// Exercise Pi's actual next-request clamp, including after a model/provider switch.
			const nextModel = { ...model, contextWindow: context + 4096 + 1000 };
			expect(clampMaxTokensToContext(nextModel, normalizeContext({ messages }), model.maxTokens)).toBe(1000);
		}
		const totals = (await runtime.snapshot()).metrics.totals;
		expect(totals.turns).toBe(3);
		for (const key of ["input", "output", "reasoning", "cacheRead"] as const) {
			expect(totals[key]).toBe(billed.reduce((sum, counters) => sum + counters[key], 0));
		}
	});

	it("keeps the prompt response usage when the agent sends no usage_update", async () => {
		// Reuses the quota fixture's "quoted" reply only because it carries prompt usage without a usage_update.
		const { runtime } = setup("quota-exhausted");
		const message = await turn(runtime, [user("quoted")], "quota");
		expect(message.usage).toMatchObject({ input: 10, output: 5, totalTokens: 15 });
	});
});

describe("slash commands", () => {
	it.each(["/usage", "/logout", "hi\n/plan x"])("never lets agy intercept the user message %j", async (content) => {
		const { runtime, entries } = setup();
		const message = await turn(runtime, [user(content)]);
		expect(message.stopReason).toBe("stop");
		expect(message.content.filter((block) => block.type === "text")).toEqual([{ type: "text", text: "Hello" }]);
		const [prompt] = entries().filter((entry) => entry.method === "session/prompt");
		const texts = (prompt!.prompt as { type: string; text?: string }[]).flatMap((block) => block.type === "text" ? [block.text!] : []);
		const joined = texts.join("").trim();
		expect(joined).not.toBe("/logout");
		expect(joined).not.toMatch(/^\/usage(?:\s|$)/iu);
		for (const text of texts) expect(text).not.toMatch(/(?:\s|^)\/plan(?:\s|$)/u);
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

	it("evicts idle bindings after idleMs while preserving saved records for resume", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const { runtime, connections } = setup(undefined, "yolo", store, { idleMs: 60 });
		const first = await turn(runtime, [user("a")], "idle-a");
		expect(first.stopReason).toBe("stop");
		expect(connections[0]!.process.alive).toBe(true);

		await connections[0]!.process.exited;
		await vi.waitFor(async () => expect((await runtime.snapshot()).bindings).toBe(0));
		expect(store.get("idle-a")).toBeDefined();

		const resumed = await turn(runtime, [user("a"), first, user("next", 2)], "idle-a");
		expect(resumed.stopReason).toBe("stop");
		expect(connections).toHaveLength(2);
		expect((await runtime.snapshot()).processes[0]?.restored).toBe(true);
	});

	it("never evicts a binding with a parked Pi tool call", async () => {
		const { runtime } = setup(undefined, "yolo", undefined, { idleMs: 40 });
		const first = await drain(runtime.stream(model, { tools, messages: [user("use bridge")] }, { sessionId: "parked-idle", apiKey: "test-key" }));
		expect(first.stopReason).toBe("toolUse");
		await new Promise((resolve) => setTimeout(resolve, 120));
		const snapshot = await runtime.snapshot();
		expect(snapshot.bindings).toBe(1);
		expect(snapshot.processes[0]?.alive).toBe(true);
		expect(snapshot.processes[0]?.waitingForTools).toBe(1);
	});

	it("evicts the oldest idle binding when maxBindings is exceeded", async () => {
		const { runtime, connections } = setup(undefined, "yolo", undefined, { maxBindings: 2, idleMs: 60_000 });
		await turn(runtime, [user("s1")], "S1");
		await turn(runtime, [user("s2")], "S2");
		await turn(runtime, [user("s3")], "S3");

		await connections[0]!.process.exited;
		expect(connections[0]!.process.alive).toBe(false);
		expect(connections[1]!.process.alive).toBe(true);
		expect(connections[2]!.process.alive).toBe(true);
		expect((await runtime.snapshot()).bindings).toBe(2);
	});

	it("aborts a queued turn whose closeSession runs before binding creation", async () => {
		const { runtime, connections } = setup();
		let releaseMode!: () => void;
		(runtime as unknown as { modeChanges: Promise<void> }).modeChanges = new Promise<void>((resolve) => {
			releaseMode = resolve;
		});

		const pending = turn(runtime, [user("early-close")], "race-close");
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			await runtime.closeSession("race-close");
		} finally {
			releaseMode();
		}

		const message = await pending;
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("closed");
		expect(connections).toHaveLength(0);
		expect((await runtime.snapshot()).bindings).toBe(0);
	});

	it("never evicts an existing binding while a new turn for it is entering setup", async () => {
		const { runtime, connections } = setup(undefined, "yolo", undefined, { maxBindings: 1, idleMs: 60_000 });
		const first = await turn(runtime, [user("a")], "keep-busy");
		expect(first.stopReason).toBe("stop");

		let releaseMode!: () => void;
		(runtime as unknown as { modeChanges: Promise<void> }).modeChanges = new Promise<void>((resolve) => {
			releaseMode = resolve;
		});

		// Trigger capacity and idle eviction while "keep-busy" is between runQueued entry and setting its queue.
		const busyTurn = turn(runtime, [user("a"), first, user("b", 2)], "keep-busy");
		try {
			await new Promise((resolve) => setTimeout(resolve, 20));
			(runtime as unknown as { idleMs: number }).idleMs = 0;
			await (runtime as unknown as { evictForCapacity: () => Promise<void> }).evictForCapacity();
			await (runtime as unknown as { evictExpiredBindings: () => Promise<void> }).evictExpiredBindings();
			expect(connections[0]!.process.alive).toBe(true);
		} finally {
			releaseMode();
		}

		const second = await busyTurn;
		expect(second.stopReason).toBe("stop");
		expect(connections).toHaveLength(1);
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

	it("resumes a bridge call and a permission request raised by the same inference together", async () => {
		const { runtime } = setup(undefined, "default");
		const messages = [user("bridge and permission")];
		const first = await drain(runtime.stream(model, { tools, messages }, { sessionId: "mixed", apiKey: "test-key" }));
		expect(first.stopReason).toBe("toolUse");
		const calls = first.content.filter((block) => block.type === "toolCall");
		const echo = calls.find((block) => block.name === "echo");
		const permission = calls.find((block) => block.name === PERMISSION_TOOL_NAME);
		if (echo?.type !== "toolCall" || permission?.type !== "toolCall") throw new Error(`expected echo and permission calls, got ${JSON.stringify(calls)}`);

		// Pi answers both calls at once, faster than the provider's tool batching window.
		const second = await Promise.race([
			drain(runtime.stream(model, { tools, messages: [...messages, first,
				{ role: "toolResult", toolCallId: echo.id, toolName: echo.name, content: [{ type: "text", text: "echoed" }], isError: false, timestamp: 2 },
				{ role: "toolResult", toolCallId: permission.id, toolName: PERMISSION_TOOL_NAME, content: [{ type: "text", text: "Allowed" }], isError: false, timestamp: 3,
					details: { kind: PERMISSION_RESULT_KIND, requestId: permission.id, optionId: "allow-once", cancelled: false } },
			] }, { sessionId: "mixed", apiKey: "test-key" })),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("continuation hung")), 3000)),
		]);
		expect(second.stopReason).toBe("stop");
		expect(second.content).toEqual([{ type: "text", text: "echoed|allow-once" }]);
		// The batching timer of the first slice must not end a later slice.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect((await runtime.snapshot()).processes[0]?.waitingForTools).toBe(0);
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
			const { runtime } = setup();
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

	it("rejects an idle continuation without aborting idle or newer turns", async () => {
		const { runtime } = setup();
		const internals = runtime as unknown as { awaitContinuation(binding: unknown, signal?: AbortSignal): Promise<void> };
		let complete!: () => void;
		const binding = { turnCompletion: undefined as Promise<void> | undefined, abortRequested: false, session: { sessionId: "unit" }, connection: { cancel: vi.fn(async () => undefined), close: vi.fn(async () => undefined) } };
		await expect(internals.awaitContinuation(binding, AbortSignal.abort())).rejects.toMatchObject({ code: "protocol" });
		expect(binding.abortRequested).toBe(false); expect(binding.connection.cancel).not.toHaveBeenCalled();
		binding.turnCompletion = new Promise<void>((resolve) => { complete = resolve; });
		const controller = new AbortController();
		const pending = internals.awaitContinuation(binding, controller.signal);
		binding.turnCompletion = new Promise<void>(() => undefined); controller.abort(); complete(); await pending;
		expect(binding.connection.cancel).not.toHaveBeenCalled(); expect(binding.connection.close).not.toHaveBeenCalled();
	});

	it("clears parked Pi tools when the ACP turn ends early and completes the next toolResult turn without hanging", async () => {
		const { runtime, entries } = setup("early-tool-turn-end");
		const first = await drain(runtime.stream(model, { tools, messages: [user("bridge")] }, { sessionId: "early-end", apiKey: "test-key" }));
		expect(first.stopReason).toBe("toolUse");
		const call = first.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing tool");

		await vi.waitFor(async () => {
			expect((await runtime.snapshot()).processes[0]?.waitingForTools).toBe(0);
		}, { timeout: 2000 });

		const second = await Promise.race([
			drain(runtime.stream(model, {
				tools,
				messages: [
					user("bridge"),
					first,
					{ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "late tool result" }], isError: false, timestamp: 2 },
				],
			}, { sessionId: "early-end", apiKey: "test-key" })),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream hung after early ACP turn end")), 2000)),
		]);
		expect(second.stopReason).toBe("stop");
		const prompts = entries().filter((entry) => entry.method === "session/prompt");
		expect(prompts).toHaveLength(2);
		expect(JSON.stringify(prompts[1]?.prompt)).toContain("late tool result");
	});

	it("fails the Pi stream instead of hanging if runQueued resolves without finishing the writer", async () => {
		const { runtime } = setup();
		vi.spyOn(runtime as unknown as { runQueued: () => Promise<void> }, "runQueued").mockResolvedValue(undefined);
		const message = await Promise.race([
			turn(runtime, [user("hello")], "unfinished-writer"),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("stream hung with unfinished writer")), 1000)),
		]);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("without completing");
	});
});

describe("quota exhaustion", () => {
	afterEach(() => { vi.restoreAllMocks(); });

	function quotaSetup() {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		return { store, ...setup("quota-exhausted", "yolo", store) };
	}

	it.each([0, 429])("ends the turn with a relative reset time (%i milliseconds)", async (milliseconds) => {
		// A valid ISO reset timestamp may contain .429Z; it is not an HTTP 429 error.
		vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 5, 21, 50, 0, milliseconds));
		const { runtime, store } = quotaSetup();
		const message = await turn(runtime, [user("relative")], "quota");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/^Antigravity quota exceeded for \S+\. Resets at \S+\.$/u);
		expect(message.errorMessage).not.toMatch(/\b429\b|rate limit|try again in|reset in/iu);
		const resetAt = Date.parse(/Resets at (\S+)\.$/u.exec(message.errorMessage!)![1]!);
		expect(Math.abs(resetAt - (Date.now() + 231 * 60_000))).toBeLessThan(60_000);
		expect((await runtime.snapshot()).bindings).toBe(0);
		expect(store.get("quota")).toBeUndefined();
	});

	it("converts the absolute reset date to ISO", async () => {
		const { runtime } = quotaSetup();
		const message = await turn(runtime, [user("absolute")], "quota");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("Resets at 2026-10-02T14:00:00.000Z.");
	});

	it("ends without a reset clause when Antigravity gives none", async () => {
		const { runtime } = quotaSetup();
		const message = await turn(runtime, [user("no reset")], "quota");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/^Antigravity quota exceeded for .+\.$/u);
		expect(message.errorMessage).not.toContain("Resets at");
	});

	it("treats a refusal carrying the quota message as an error", async () => {
		const { runtime } = quotaSetup();
		const message = await turn(runtime, [user("refusal")], "quota");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/quota exceeded/u);
	});

	it("fails a turn stuck on 429 RESOURCE_EXHAUSTED retries without Pi retrying it", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const { runtime } = setup("resource-exhausted", "yolo", store);
		const message = await turn(runtime, [user("Reply with exactly: PONG")], "exhausted");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/^Antigravity quota exceeded:/u);
		expect(isRetryableAssistantError(message)).toBe(false);
		expect(store.get("exhausted")?.messageCount ?? 0).toBe(0);
	});

	it("retries after quota replies without duplicating the request in the Antigravity session", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const { runtime } = setup(undefined, "yolo", store);
		const first = await turn(runtime, [user("hello")], "quota-retry");
		expect(first.stopReason).toBe("stop");
		const retry = [user("hello"), first, user("quota until 3", 2)];
		for (let attempt = 0; attempt < 3; attempt++) {
			const refused = await turn(runtime, retry, "quota-retry");
			expect(refused.errorMessage).toMatch(/^Antigravity quota exceeded/u);
		}
		const recovered = await turn(runtime, retry, "quota-retry");
		expect(recovered.stopReason).toBe("stop");
		expect(recovered.content).toEqual([{ type: "text", text: "copies: 1" }]);
	});

	it("fails an over-long input reported as a reply so Pi can compact", async () => {
		const fixture = setup();
		const store = new AcpSessionStore(path.join(fixture.root, "sessions.json"));
		const { runtime } = setup(undefined, "yolo", store);
		const first = await turn(runtime, [user("hello")], "overflow");
		const message = await turn(runtime, [user("hello"), first, user("overflow reply", 2)], "overflow");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toMatch(/^Antigravity context overflow: /u);
		expect(isContextOverflow(message, model.contextWindow)).toBe(true);
		expect((await runtime.snapshot()).bindings).toBe(0);
		expect(store.get("overflow")).toBeUndefined();
	});

	it("leaves a normal reply that quotes the wording untouched", async () => {
		const { runtime } = quotaSetup();
		const message = await turn(runtime, [user("quoted")], "quota");
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([expect.objectContaining({ type: "text", text: expect.stringContaining("You have reached your current quota") })]);
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

	it("keeps tools beyond 64, excludes the permission broker and fingerprints descriptions/omissions", () => {
		const active = Array.from({ length: 67 }, (_, i) => ({ name: `t${i}`, description: "tool", parameters: Type.Object({}) }));
		const bridge = new PiMcpBridge({ tools: [...active, { name: PERMISSION_TOOL_NAME, description: "broker", parameters: Type.Object({}) }], onCall: async () => ({ content: [] }) });
		expect(bridge.omissions).toEqual([]);
		expect(bridge.fingerprint).toBe(piToolFingerprint(active));
		expect(piToolFingerprint(active)).not.toBe(piToolFingerprint(active.slice(0, 64)));
		const invalid = new PiMcpBridge({ tools: [...active, active[0]!, { name: "bad", description: "bad", parameters: Type.String() }], onCall: async () => ({ content: [] }) });
		expect(invalid.omissions).toEqual([
			{ name: "t0", reason: "duplicate or invalid projected name" },
			{ name: "bad", reason: expect.stringContaining("not_object") },
		]);
		expect(piToolFingerprint(tools)).not.toBe(piToolFingerprint([{ ...tools[0]!, description: "changed" }]));
		expect(piToolFingerprint(tools)).not.toBe(piToolFingerprint([...tools, { name: "bad", description: "bad", parameters: Type.String() }]));
	});
});

describe("live quota", () => {
	afterEach(() => { vi.useRealTimers(); });

	it("reads quota with a raw /usage prompt on its own short-lived connection", async () => {
		const { runtime, connections, entries } = setup();
		const quota = await runtime.quota(undefined);
		expect(quota.groups.map((group) => group.displayName)).toEqual(["Gemini Models", "Claude and GPT models", "Gemini 4 Argon"]);
		expect(entries().filter((entry) => entry.method === "session/prompt").map((entry) => entry.prompt))
			.toEqual([[{ type: "text", text: "/usage" }]]);
		await connections[0]!.process.exited;
		expect((await runtime.snapshot()).bindings).toBe(0);
	});

	it("caches a snapshot for 60 seconds and shares one request between concurrent callers", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const { runtime, connections } = setup();
		const [first, second] = await Promise.all([runtime.quota(undefined), runtime.quota(undefined)]);
		expect(second).toBe(first);
		expect(await runtime.quota(undefined)).toBe(first);
		expect(connections).toHaveLength(1);

		vi.advanceTimersByTime(61_000);
		await runtime.quota(undefined);
		expect(connections).toHaveLength(2);
	});

	it("drops the cached snapshot on logout", async () => {
		const { root, runtime, connections } = setup();
		vi.stubEnv("GEMINI_HOME", path.join(root, "gemini"));
		try {
			await runtime.quota(undefined);
			await runtime.logout();
			await runtime.quota(undefined);
			expect(connections).toHaveLength(2);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("does not populate the cache if logout occurs while a quota read is in flight", async () => {
		const { root, runtime } = setup();
		vi.stubEnv("GEMINI_HOME", path.join(root, "gemini"));
		try {
			let resolveQuota!: (snapshot: AntigravityQuotaSnapshot) => void;
			const pendingSnapshot = new Promise<AntigravityQuotaSnapshot>((resolve) => { resolveQuota = resolve; });
			vi.spyOn(runtime as unknown as { fetchQuota: () => Promise<AntigravityQuotaSnapshot> }, "fetchQuota").mockReturnValue(pendingSnapshot);
			const quotaPromise = runtime.quota(undefined);
			await runtime.logout();
			resolveQuota({ at: Date.now(), groups: [] });
			await quotaPromise;
			expect((runtime as unknown as { quotaCache: unknown }).quotaCache).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("does not cache a failed quota read", async () => {
		const { runtime, connections } = setup("usage-unavailable");
		await expect(runtime.quota(undefined)).rejects.toThrow("Unable to retrieve quota status (backend unavailable)");
		await expect(runtime.quota(undefined)).rejects.toThrow("no quota groups");
		expect(connections).toHaveLength(2);
	});

	it("rejects an aborted caller without cancelling the shared request", async () => {
		const { runtime, connections } = setup();
		const controller = new AbortController();
		const aborted = runtime.quota(undefined, controller.signal);
		const shared = runtime.quota(undefined);
		controller.abort();
		await expect(aborted).rejects.toThrow("aborted");
		expect((await shared).groups).toHaveLength(3);
		expect(connections).toHaveLength(1);
	});

	it("rejects a cached quota read after close", async () => {
		const { runtime } = setup();
		vi.spyOn(runtime as unknown as { fetchQuota: () => Promise<AntigravityQuotaSnapshot> }, "fetchQuota")
			.mockResolvedValue({ at: Date.now(), groups: [] });
		await runtime.quota(undefined);
		await runtime.close();
		await expect(runtime.quota(undefined)).rejects.toThrow("closed");
	});

	it("rejects a quota read that would join an in-flight request after close", async () => {
		const { runtime } = setup();
		let resolveQuota!: (snapshot: AntigravityQuotaSnapshot) => void;
		const pending = new Promise<AntigravityQuotaSnapshot>((resolve) => { resolveQuota = resolve; });
		const fetchQuota = vi.spyOn(runtime as unknown as { fetchQuota: () => Promise<AntigravityQuotaSnapshot> }, "fetchQuota")
			.mockReturnValue(pending);
		const first = runtime.quota(undefined);
		await runtime.close();
		await expect(runtime.quota(undefined)).rejects.toThrow("closed");
		resolveQuota({ at: Date.now(), groups: [] });
		await first.catch(() => undefined);
		expect(fetchQuota).toHaveBeenCalledTimes(1);
	});

	it.each(["logout", "credential change"])("starts a fresh quota read on %s while the old one is still in flight", async (change) => {
		const { root, runtime } = setup();
		vi.stubEnv("GEMINI_HOME", path.join(root, "gemini"));
		try {
			let resolveOld!: (snapshot: AntigravityQuotaSnapshot) => void;
			let resolveNew!: (snapshot: AntigravityQuotaSnapshot) => void;
			const oldPromise = new Promise<AntigravityQuotaSnapshot>((resolve) => { resolveOld = resolve; });
			const newPromise = new Promise<AntigravityQuotaSnapshot>((resolve) => { resolveNew = resolve; });
			const fetchQuota = vi.spyOn(runtime as unknown as { fetchQuota: () => Promise<AntigravityQuotaSnapshot> }, "fetchQuota")
				.mockReturnValueOnce(oldPromise)
				.mockReturnValueOnce(newPromise);

			const old = runtime.quota(undefined);
			if (change === "logout") await runtime.logout();
			const nextKey = change === "credential change" ? "new-key" : undefined;
			const fresh = runtime.quota(nextKey);
			resolveOld({ at: 1, groups: [] });
			await old;
			const third = runtime.quota(nextKey);
			resolveNew({ at: 2, groups: [{ displayName: "fresh", buckets: [] }] });

			expect((await fresh).at).toBe(2);
			expect((await third).at).toBe(2);
			expect(fetchQuota).toHaveBeenCalledTimes(2);
			expect((runtime as unknown as { quotaCache?: { snapshot: AntigravityQuotaSnapshot } }).quotaCache?.snapshot.at).toBe(2);
		} finally {
			vi.unstubAllEnvs();
		}
	});
});

describe("throwaway conversations", () => {
	const userSid = "0f8fad5b-d9cb-469f-a165-70867728950e";
	function conversationsIn(root: string, sids: "uuid" | "plain" = "uuid") {
		vi.stubEnv("PI_CODING_AGENT_DIR", root);
		const acp = path.join(root, "antigravity-acp-provider", "gemini", "antigravity-acp");
		const conversations = path.join(acp, "conversations");
		fs.mkdirSync(conversations, { recursive: true });
		for (const suffix of [".db", ".db-shm", ".db-wal", ".meta"]) fs.writeFileSync(path.join(conversations, userSid + suffix), "user");
		fs.writeFileSync(path.join(acp, "acp_token.json"), "{}");
		vi.stubEnv("FAKE_AGENT_CONVERSATIONS", sids);
		return {
			files: () => fs.readdirSync(conversations).sort(),
			token: () => fs.existsSync(path.join(acp, "acp_token.json")),
		};
	}
	const userFiles = [".db", ".db-shm", ".db-wal", ".meta"].map((suffix) => userSid + suffix).sort();
	afterEach(() => { vi.unstubAllEnvs(); });

	it("removes the conversation a quota read creates and nothing else", async () => {
		const { root, runtime, connections } = setup();
		const store = conversationsIn(root);
		expect((await runtime.quota(undefined)).groups).toHaveLength(3);
		await connections[0]!.process.exited;
		expect(store.files()).toEqual(userFiles);
		expect(store.token()).toBe(true);
	});

	it("keeps the conversation of a user turn", async () => {
		const { root, runtime, connections } = setup();
		const store = conversationsIn(root);
		expect((await turn(runtime, [user("hello")])).stopReason).toBe("stop");
		const afterTurn = store.files();
		expect(afterTurn).toHaveLength(8);
		await runtime.quota(undefined);
		await connections.at(-1)!.process.exited;
		expect(store.files()).toEqual(afterTurn);
	});

	it("deletes nothing for a session id that is not a UUID", async () => {
		const { root, runtime, connections } = setup();
		const store = conversationsIn(root, "plain");
		await runtime.quota(undefined);
		await connections[0]!.process.exited;
		expect(store.files()).toEqual([...userFiles, "fake-session.db", "fake-session.db-shm", "fake-session.db-wal", "fake-session.meta"].sort());
	});
});

describe("bridged update cleanliness and generated skill cleanup", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("renders Antigravity tool activity according to toolActivityMode (compact default, off, full)", async () => {
		const { runtime } = setup();
		const compact = await drain(
			runtime.stream(model, { tools, messages: [user("emit tool activity")] }, { sessionId: "tool-compact", apiKey: "test-key" }),
		);
		const compactThinking = compact.content
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking)
			.join("\n");
		expect(compactThinking).toContain("Reasoning");
		expect(compactThinking).toContain("[Antigravity plan]");
		expect(compactThinking).toContain("[Antigravity tool: pi_echo — in_progress]");
		expect(compactThinking).not.toContain("[Antigravity tool update:");

		runtime.setToolActivityMode("off");
		const off = await drain(
			runtime.stream(model, { tools, messages: [user("emit tool activity")] }, { sessionId: "tool-off", apiKey: "test-key" }),
		);
		const offThinking = off.content
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking)
			.join("\n");
		expect(offThinking).toContain("Reasoning");
		expect(offThinking).toContain("[Antigravity plan]");
		expect(offThinking).not.toContain("[Antigravity tool:");
		expect(offThinking).not.toContain("[Antigravity tool update:");

		runtime.setToolActivityMode("full");
		const full = await drain(
			runtime.stream(model, { tools, messages: [user("emit tool activity")] }, { sessionId: "tool-full", apiKey: "test-key" }),
		);
		const fullThinking = full.content
			.filter((block) => block.type === "thinking")
			.map((block) => block.thinking)
			.join("\n");
		expect(fullThinking).toContain("[Antigravity tool: pi_echo — in_progress]");
		expect(fullThinking).toContain("[Antigravity tool update: tc-1 — completed]");
	});

	it("preserves user-authored skills/system/run-workflow/SKILL.md created during a session", async () => {
		const userCwd = fs.mkdtempSync(path.join(os.tmpdir(), "acp-skill-user-"));
		roots.push(userCwd);
		vi.spyOn(process, "cwd").mockReturnValue(userCwd);

		const { runtime } = setup();
		const first = await turn(runtime, [user("hello")], "skill-user-preserve");
		expect(first.stopReason).toBe("stop");

		const userFile = path.join(userCwd, "skills", "system", "run-workflow", "SKILL.md");
		fs.mkdirSync(path.dirname(userFile), { recursive: true });
		fs.writeFileSync(userFile, "# user-authored\n");

		await runtime.closeSession("skill-user-preserve");
		expect(fs.existsSync(userFile)).toBe(true);
		expect(fs.readFileSync(userFile, "utf8")).toBe("# user-authored\n");
	});
});

describe("closed connection eviction and retry recovery", () => {
	it("evicts a timed-out binding even if process.alive lingers after close() and recovers on Pi retry", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-retry-eviction-"));
		roots.push(root);
		const log = path.join(root, "calls.jsonl");
		fs.writeFileSync(log, "");
		const store = new AcpSessionStore(path.join(root, "sessions.json"));
		const connections: AntigravityAcpConnection[] = [];
		const realCloses: Array<() => Promise<void>> = [];
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({
				...options,
				command: process.execPath,
				args: [fakeAgent],
				env: { ...process.env, FAKE_AGENT_LOG_FILE: log },
				promptIdleTimeoutMs: 60,
			});
			const realClose = connection.process.close.bind(connection.process);
			realCloses.push(realClose);
			// Simulate close() returning while the OS child still reports alive === true
			// (e.g. slow teardown or unkillable child grace period).
			if (connections.length === 0) {
				connection.process.close = async () => undefined;
			}
			connections.push(connection);
			return connection;
		}, "yolo", store);
		runtimes.push(runtime);

		try {
			const first = await turn(runtime, [user("hello")], "retry-recovery");
			expect(first.stopReason).toBe("stop");
			expect(store.get("retry-recovery")).toBeDefined();

			let attempt = 0;
			const scheduled: string[] = [];
			const retried = await retryAssistantCall(
				async () => {
					attempt += 1;
					const text = attempt === 1 ? "hang" : "hello again";
					return drain(runtime.stream(model, {
						messages: [user("hello"), first, user(text, 2)],
					}, { sessionId: "retry-recovery", apiKey: "test-key" }));
				},
				{ enabled: true, maxRetries: 1, baseDelayMs: 10 },
				undefined,
				{ onRetryScheduled: (_attempt, _max, _delay, errorMessage) => { scheduled.push(errorMessage); } },
			);

			expect(attempt).toBe(2);
			expect(scheduled).toEqual([expect.stringContaining("timed out")]);
			expect(retried.stopReason).toBe("stop");
			expect(retried.content).toEqual([
				{ type: "thinking", thinking: "Checking" },
				{ type: "text", text: "Hello" },
			]);
			expect(connections).toHaveLength(2);
			expect((await runtime.snapshot()).processes[0]?.restored).toBe(true);
		} finally {
			await Promise.allSettled(realCloses.map((close) => close()));
		}
	});

	it("evicts a closed binding before the child finishes exiting when the next turn arrives", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-closed-between-turns-"));
		roots.push(root);
		const store = new AcpSessionStore(path.join(root, "sessions.json"));
		const connections: AntigravityAcpConnection[] = [];
		const realCloses: Array<() => Promise<void>> = [];
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({
				...options,
				command: process.execPath,
				args: [fakeAgent],
			});
			const realClose = connection.process.close.bind(connection.process);
			realCloses.push(realClose);
			if (connections.length === 0) {
				connection.process.close = async () => undefined;
			}
			connections.push(connection);
			return connection;
		}, "yolo", store);
		runtimes.push(runtime);

		try {
			const first = await turn(runtime, [user("hello")], "between-turns");
			expect(first.stopReason).toBe("stop");
			await connections[0]!.close();
			expect(connections[0]!.closed).toBe(true);
			expect(connections[0]!.process.alive).toBe(true);

			const second = await turn(runtime, [user("hello"), first, user("next", 2)], "between-turns");
			expect(second.stopReason).toBe("stop");
			expect(connections).toHaveLength(2);
			expect((await runtime.snapshot()).processes[0]?.restored).toBe(true);
			expect(store.get("between-turns")).toBeDefined();
		} finally {
			await Promise.allSettled(realCloses.map((close) => close()));
		}
	});

	it("completes binding eviction before failing the stream when process teardown is slow", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-slow-teardown-"));
		roots.push(root);
		const store = new AcpSessionStore(path.join(root, "sessions.json"));
		const connections: AntigravityAcpConnection[] = [];
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({
				...options,
				command: process.execPath,
				args: [fakeAgent],
				promptIdleTimeoutMs: 60,
			});
			const realClose = connection.process.close.bind(connection.process);
			connection.process.close = async () => {
				await new Promise((resolve) => setTimeout(resolve, 150));
				await realClose();
			};
			connections.push(connection);
			return connection;
		}, "yolo", store);
		runtimes.push(runtime);

		const failed = await turn(runtime, [user("hang")], "slow-teardown");
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("timed out");
		expect((await runtime.snapshot()).bindings).toBe(0);
		expect(connections[0]?.process.alive).toBe(false);
	});

	it("commits consumed tool continuation context before awaiting prompt completion so retry does not resend external-delta or user prompt", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "acp-tool-continuation-retry-"));
		roots.push(root);
		const log = path.join(root, "calls.jsonl");
		fs.writeFileSync(log, "");
		const store = new AcpSessionStore(path.join(root, "sessions.json"));
		const runtime = new AntigravityRuntime((options) => new AntigravityAcpConnection({
			...options,
			command: process.execPath,
			args: [fakeAgent],
			env: { ...process.env, FAKE_AGENT_LOG_FILE: log },
			promptIdleTimeoutMs: 80,
		}), "yolo", store);
		runtimes.push(runtime);

		const initialContext = normalizeContext({
			tools,
			messages: [user("use bridge delayed")],
		});
		const first = await drain(runtime.stream(model, initialContext, { sessionId: "cont-retry", apiKey: "test-key" }));
		expect(first.stopReason).toBe("toolUse");
		const call = first.content.find((block) => block.type === "toolCall");
		if (call?.type !== "toolCall") throw new Error("missing tool call");

		const contContext = normalizeContext({
			messages: [
				...initialContext.messages,
				first,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "bridge-output-payload" }],
					isError: false,
					timestamp: 2,
				},
			],
		});

		// Continuation delivers the tool result to ACP, then stalls during "bridge delayed" (500ms > 80ms watchdog).
		const stalled = await drain(runtime.stream(model, contContext, { sessionId: "cont-retry", apiKey: "test-key" }));
		expect(stalled.stopReason).toBe("error");
		expect(stalled.errorMessage).toContain("timed out");
		expect(store.get("cont-retry")?.messageCount).toBe(contContext.messages.length);

		// Retry on the restored session must send only WARM_CONTINUATION without external-delta or duplicate user prompt.
		const retried = await drain(runtime.stream(model, contContext, { sessionId: "cont-retry", apiKey: "test-key" }));
		expect(retried.stopReason).toBe("stop");
		const prompts = fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
			.map((line) => JSON.parse(line) as { method: string; prompt?: Array<{ type: string; text?: string }> })
			.filter((entry) => entry.method === "session/prompt");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]?.prompt).toEqual([
			{
				type: "text",
				text: "Continue the current Pi user request already given in this session. Incorporate the latest tool results without repeating completed tool actions.",
			},
		]);
	});
});
