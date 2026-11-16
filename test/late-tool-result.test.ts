import type { Context, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";

import { AntigravityAcpConnection } from "../src/acp/connection.js";
import { AntigravityRuntime, PERMISSION_RESULT_KIND } from "../src/runtime.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-agent.mjs", import.meta.url));
const model: Model<"antigravity-acp"> = {
	id: "gemini-test", name: "Test", api: "antigravity-acp", provider: "antigravity-acp",
	baseUrl: "", reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 8192,
};

describe("Pi results arriving after the ACP prompt ended", () => {
	it.each([
		["bridge", "late-stop", false],
		["bridge", "late-error", false],
		["bridge parallel", "late-stop", false],
		["permission", "late-stop", false],
		["bridge", "late-hang", true],
		["permission", "late-hang", true],
	] as const)("recovers %s after %s (cancel recovery: %s)", async (request, scenario, cancel) => {
		let ended!: () => void;
		const originalEnded = new Promise<void>((resolve) => { ended = resolve; });
		const controller = new AbortController();
		let prompts = 0;
		const runtime = new AntigravityRuntime((options) => {
			const connection = new AntigravityAcpConnection({
				...options, command: process.execPath, args: [fixture, scenario],
				handlers: {
					...options.handlers,
					onUpdate(notification) {
						options.handlers?.onUpdate?.(notification);
						if (cancel && prompts === 2 && notification.update.sessionUpdate === "agent_message_chunk") {
							controller.abort();
						}
					},
				},
			});
			const prompt = connection.prompt.bind(connection);
			connection.prompt = async (...args) => {
				const original = ++prompts === 1;
				try { return await prompt(...args); }
				finally {
					// Let the runtime finish processing the original response before returning Pi's result.
					if (original) setImmediate(ended);
				}
			};
			return connection;
		});
		try {
			const context: Context = {
				messages: [{ role: "user", content: `use ${request}`, timestamp: 1 }],
				tools: [{ name: "echo", description: "Echo", parameters: Type.Object({ text: Type.String() }) }],
			};
			const options = { sessionId: "late-result", apiKey: "test-key" };
			const first = await runtime.stream(model, context, options).stream.result();
			expect(first.stopReason).toBe("toolUse");
			const calls = first.content.filter((block) => block.type === "toolCall");
			expect(calls).toHaveLength(request.includes("parallel") ? 2 : 1);
			await originalEnded;
			expect((await runtime.snapshot()).processes[0]).toMatchObject({ waitingForTools: 0, waitingForPermission: false });

			const results: ToolResultMessage[] = calls.map((call, index) => ({
				role: "toolResult", toolCallId: call.id, toolName: call.name,
				content: [{ type: "text", text: `REJECT_LATE_${index}` }], isError: false, timestamp: 2,
				...(request === "permission" ? { details: {
					kind: PERMISSION_RESULT_KIND, requestId: call.id, cancelled: true,
				} } : {}),
			}));
			const recovered = await runtime.stream(model, {
				...context, messages: [...context.messages, first, ...results],
			}, { ...options, signal: controller.signal }).stream.result();
			expect(recovered.stopReason).toBe(cancel ? "aborted" : "stop");
			if (!cancel) {
				const text = recovered.content.filter((b) => b.type === "text").map((b) => b.text).join("");
				for (let index = 0; index < results.length; index++) expect(text).toContain(`REJECT_LATE_${index}`);
				expect(recovered.content.some((b) => b.type === "toolCall")).toBe(false);
			}
			expect(prompts).toBe(2);
			const snapshot = await runtime.snapshot();
			expect(snapshot.processes[0]).toMatchObject({ waitingForTools: 0, waitingForPermission: false });
		} finally {
			controller.abort();
			await runtime.close();
		}
	}, 3000);
});
