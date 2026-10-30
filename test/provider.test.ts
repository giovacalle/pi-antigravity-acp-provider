import { normalizeContext } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { FALLBACK_MODELS, projectModels } from "../src/models.js";
import { createAntigravityProvider } from "../src/provider.js";
import { AntigravityRuntime } from "../src/runtime.js";
import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";

const fakeAgent = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model = FALLBACK_MODELS[0]!;

describe("native Pi provider", () => {
	it("passes transcript instructions through to the ACP prompt", async () => {
		const prompts: Array<Parameters<AntigravityAcpConnection["prompt"]>[0]> = [];
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] });
			const prompt = connection.prompt.bind(connection);
			connection.prompt = (request, signal) => {
				prompts.push(request);
				return prompt(request, signal);
			};
			return connection;
		});
		try {
			const { provider } = createAntigravityProvider(runtime);
			const stream = provider.streamSimple(model, normalizeContext({
				systemPrompt: "Follow native transcript instructions",
				messages: [{ role: "user", content: "hello", timestamp: 1 }],
			}), { apiKey: "test-key" });
			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
			expect(prompts[0]?.prompt[0]).toMatchObject({
				type: "resource",
				resource: { text: expect.stringContaining("Follow native transcript instructions") },
			});
		} finally {
			await runtime.close();
		}
	});

	it("routes tools added by a transcript delta through the MCP bridge", async () => {
		const runtime = new AntigravityRuntime(
			(options) => new AntigravityAcpConnection({ ...options, command: process.execPath, args: [fakeAgent] }),
		);
		try {
			const { provider } = createAntigravityProvider(runtime);
			const tools = [{ name: "echo", description: "Echo text", parameters: Type.Object({ text: Type.String() }) }];
			const context = normalizeContext({ messages: [
				{ role: "system", content: "Base instructions", timestamp: 0 },
				{ role: "system", content: "", toolsAdded: tools, timestamp: 1 },
				{ role: "user", content: "use bridge", timestamp: 2 },
			] });
			const first = await provider.streamSimple(model, context, { apiKey: "test-key" }).result();
			const call = first.content.find((block) => block.type === "toolCall");
			if (!call || call.type !== "toolCall") throw new Error("missing transcript tool call");
			expect(call).toMatchObject({ name: "echo", arguments: { text: "from gemini" } });
			const second = await provider.streamSimple(model, normalizeContext({ messages: [
				...context.messages,
				first,
				{ role: "toolResult", toolCallId: call.id, toolName: "echo", content: [{ type: "text", text: "native result" }], isError: false, timestamp: 3 },
			] }), { apiKey: "test-key" }).result();
			expect(second.content).toEqual([{ type: "text", text: "native result" }]);
		} finally {
			await runtime.close();
		}
	});
});

describe("model catalog refresh", () => {
	const HOUR = 60 * 60_000;
	const storedModels = projectModels([
		{ modelId: "gemini-y-low", name: "Gemini Y (low)" },
		{ modelId: "gemini-y-high", name: "Gemini Y (high)" },
	]);

	async function refresh(
		options: Partial<RefreshModelsContext> & { publishResult?: boolean; discoveryFails?: boolean } = {},
	) {
		const runtime = new AntigravityRuntime(() => {
			throw new Error("no ACP process expected");
		});
		const discover = vi.spyOn(runtime, "discoverModels");
		if (options.discoveryFails) discover.mockRejectedValue(new Error("offline"));
		else discover.mockResolvedValue([
			{ modelId: "gemini-x-low", name: "Gemini X (low)" },
			{ modelId: "gemini-x-high", name: "Gemini X (high)" },
		]);
		const publications: ModelsPublication[] = [];
		try {
			const { provider } = createAntigravityProvider(runtime);
			const started = Date.now();
			await provider.refreshModels!({
				credential: { type: "api_key", key: "k" },
				signal: new AbortController().signal,
				allowNetwork: true,
				...options,
				async publish(publication) {
					publications.push(publication);
					if (options.publishResult === false) return false;
					publication.update?.();
					return true;
				},
			});
			return {
				calls: discover.mock.calls.length,
				ids: provider.getModels().map((entry) => entry.id),
				models: provider.getModels(),
				publications,
				window: [started, Date.now()] as const,
			};
		} finally {
			await runtime.close();
		}
	}

	it("reuses a fresh stored catalog without discovering", async () => {
		const result = await refresh({ stored: { models: storedModels, checkedAt: Date.now() } });
		expect(result.calls).toBe(0);
		expect(result.ids).toEqual(["gemini-y"]);
		expect(result.publications.some((publication) => publication.persist)).toBe(false);
	});

	it("rediscovers a stale stored catalog and persists the result", async () => {
		const result = await refresh({ stored: { models: storedModels, checkedAt: Date.now() - 25 * HOUR } });
		expect(result.calls).toBe(1);
		const persist = result.publications.at(-1)?.persist;
		expect(persist?.models.map((entry) => entry.id)).toEqual(["gemini-x"]);
		expect(persist?.checkedAt).toBeGreaterThanOrEqual(result.window[0]);
		expect(persist?.checkedAt).toBeLessThanOrEqual(result.window[1]);
		expect(result.ids).toEqual(["gemini-x"]);
	});

	it("rediscovers a fresh stored catalog when forced", async () => {
		const result = await refresh({ stored: { models: storedModels, checkedAt: Date.now() }, force: true });
		expect(result.calls).toBe(1);
		expect(result.ids).toEqual(["gemini-x"]);
	});

	it("treats a future or missing check time as stale", async () => {
		expect((await refresh({ stored: { models: storedModels, checkedAt: Date.now() + HOUR } })).calls).toBe(1);
		expect((await refresh({ stored: { models: storedModels } })).calls).toBe(1);
	});

	it("keeps a stale stored catalog when discovery fails", async () => {
		const result = await refresh({
			stored: { models: storedModels, checkedAt: Date.now() - 25 * HOUR },
			discoveryFails: true,
		});
		expect(result.ids).toEqual(["gemini-y"]);
	});

	it("restores the stored catalog offline without discovering", async () => {
		const result = await refresh({
			stored: { models: storedModels, checkedAt: Date.now() - 25 * HOUR },
			allowNetwork: false,
		});
		expect(result.calls).toBe(0);
		expect(result.ids).toEqual(["gemini-y"]);
	});

	it("treats an empty or foreign stored catalog as missing", async () => {
		const foreign = { models: [{ ...storedModels[0]!, provider: "openrouter" }], checkedAt: Date.now() };
		const fallbackIds = FALLBACK_MODELS.map((entry) => entry.id);
		for (const stored of [foreign, { models: [], checkedAt: Date.now() }]) {
			const offline = await refresh({ stored, allowNetwork: false });
			expect(offline.ids).toEqual(fallbackIds);
			expect((await refresh({ stored })).calls).toBe(1);
		}
	});

	it("rebuilds stored entries from code and drops unsafe ids", async () => {
		const tampered = {
			...storedModels[0]!,
			baseUrl: "http://evil",
			cost: { input: 5, output: 5, cacheRead: 5, cacheWrite: 5 },
		};
		const unsafe = { ...storedModels[0]!, id: "gemini-\u0007bad" };
		const result = await refresh({
			stored: { models: [tampered, unsafe], checkedAt: Date.now() },
			allowNetwork: false,
		});
		expect(result.ids).toEqual(["gemini-y"]);
		expect(result.models[0]).toEqual(storedModels[0]);
	});

	it("stops when the restored catalog is not published", async () => {
		const result = await refresh({
			stored: { models: storedModels, checkedAt: Date.now() - 25 * HOUR },
			publishResult: false,
		});
		expect(result.calls).toBe(0);
	});
});
