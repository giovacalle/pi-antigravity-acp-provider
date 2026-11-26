import type { Tool } from "@earendil-works/pi-ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import net from "node:net";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { PiMcpBridge, type PiToolInvocation } from "../src/mcp/bridge.js";

const tools: Tool[] = [
	{
		name: "echo",
		description: "Echo text",
		parameters: Type.Object({ text: Type.String() }),
	},
];

describe("PiMcpBridge", () => {
	it("authenticates, lists namespaced tools, and revalidates arguments", async () => {
		const onCall = vi.fn(async ({ arguments: args }) => ({
			content: [{ type: "text" as const, text: String(args.text) }],
		}));
		const bridge = new PiMcpBridge({ tools, onCall });
		const descriptor = await bridge.start();
		if (!descriptor || !("url" in descriptor)) throw new Error("bridge did not start");
		const headers = Object.fromEntries(descriptor.headers.map((header) => [header.name, header.value]));
		const client = new Client({ name: "bridge-test", version: "1" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
			requestInit: { headers },
		});
		try {
			await client.connect(transport as Parameters<typeof client.connect>[0]);
			const catalog = await client.listTools();
			expect(catalog.tools.map((tool) => tool.name)).toEqual(["pi_echo"]);
			const invalid = await client.callTool({ name: "pi_echo", arguments: { text: 7 } });
			expect(invalid.isError).toBe(true);
			expect(onCall).not.toHaveBeenCalled();
			const valid = await client.callTool({ name: "pi_echo", arguments: { text: "hello" } });
			expect(valid.content).toEqual([{ type: "text", text: "hello" }]);
			expect(onCall).toHaveBeenCalledOnce();
			const unauthorized = await fetch(descriptor.url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(unauthorized.status).toBe(401);
		} finally {
			await client.close();
			await bridge.close();
		}
	});

	it("closes promptly even with an open HTTP keep-alive socket", async () => {
		const bridge = new PiMcpBridge({
			tools,
			onCall: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});
		const descriptor = await bridge.start();
		if (!descriptor || !("url" in descriptor)) throw new Error("bridge did not start");
		const parsed = new URL(descriptor.url);
		const socket = net.createConnection({ host: parsed.hostname, port: Number(parsed.port) });
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			socket.write(`POST ${parsed.pathname} HTTP/1.1\r\nHost: ${parsed.host}\r\nConnection: keep-alive\r\nContent-Length: 2\r\n\r\n{}`);
			await new Promise<void>((resolve) => socket.once("data", () => resolve()));

			const started = Date.now();
			await Promise.race([
				bridge.close(),
				new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge.close() hung on keep-alive socket")), 1_000)),
			]);
			expect(Date.now() - started).toBeLessThan(1_000);
		} finally {
			socket.destroy();
			await bridge.close();
		}
	});

	it("projects more than 64 tools without silent truncation", async () => {
		const manyTools: Tool[] = Array.from({ length: 96 }, (_, index) => ({
			name: `tool_${index}`,
			description: `Tool ${index}`,
			parameters: Type.Object({ value: Type.String() }),
		}));
		const onCall = vi.fn(async ({ name, arguments: args }) => ({
			content: [{ type: "text" as const, text: `${name}:${String(args.value)}` }],
		}));
		const bridge = new PiMcpBridge({ tools: manyTools, onCall });
		expect(bridge.omissions).toEqual([]);
		const descriptor = await bridge.start();
		if (!descriptor || !("url" in descriptor)) throw new Error("bridge did not start");
		const headers = Object.fromEntries(descriptor.headers.map((header) => [header.name, header.value]));
		const client = new Client({ name: "many-tools-test", version: "1" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
			requestInit: { headers },
		});
		try {
			await client.connect(transport as Parameters<typeof client.connect>[0]);
			const catalog = await client.listTools();
			expect(catalog.tools).toHaveLength(96);
			expect(catalog.tools.at(-1)?.name).toBe("pi_tool_95");
			const result = await client.callTool({ name: "pi_tool_95", arguments: { value: "ok" } });
			expect(result.content).toEqual([{ type: "text", text: "tool_95:ok" }]);
		} finally {
			await client.close();
			await bridge.close();
		}
	});

	it("caps a bash timeout past Antigravity's MCP call deadline and says so", async () => {
		const onCall = vi.fn(async (_invocation: PiToolInvocation) => ({ content: [{ type: "text" as const, text: "done" }] }));
		const bridge = new PiMcpBridge({
			tools: [{
				name: "bash",
				description: "Run a command",
				parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
			}, {
				name: "wait",
				description: "Wait in milliseconds",
				parameters: Type.Object({ timeout: Type.Number() }),
			}],
			onCall,
		});
		const descriptor = await bridge.start();
		if (!descriptor || !("url" in descriptor)) throw new Error("bridge did not start");
		const headers = Object.fromEntries(descriptor.headers.map((header) => [header.name, header.value]));
		const client = new Client({ name: "bridge-test", version: "1" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
			requestInit: { headers },
		});
		try {
			await client.connect(transport as Parameters<typeof client.connect>[0]);
			const capped = await client.callTool({ name: "pi_bash", arguments: { command: "make test", timeout: 900 } });
			expect(onCall.mock.calls[0]![0].arguments).toEqual({ command: "make test", timeout: 150 });
			const [note, output] = capped.content as { text: string }[];
			expect(note!.text).toContain("timeout 900 s lowered to 150 s");
			expect(output!.text).toBe("done");

			const kept = await client.callTool({ name: "pi_bash", arguments: { command: "ls", timeout: 150 } });
			expect(onCall.mock.calls[1]![0].arguments).toEqual({ command: "ls", timeout: 150 });
			expect(kept.content).toEqual([{ type: "text", text: "done" }]);

			const other = await client.callTool({ name: "pi_wait", arguments: { timeout: 900 } });
			expect(onCall.mock.calls[2]![0].arguments).toEqual({ timeout: 900 });
			expect(other.content).toEqual([{ type: "text", text: "done" }]);
		} finally {
			await client.close();
			await bridge.close();
		}
	});

	it("keeps a pending tool alive past the client timeout with increasing progress", async () => {
		let releaseCall!: () => void;
		const bridge = new PiMcpBridge({
			tools,
			progressKeepaliveMs: 25,
			onCall: () =>
				new Promise((resolve) => {
					releaseCall = () => resolve({ content: [{ type: "text", text: "finished" }] });
				}),
		});
		const descriptor = await bridge.start();
		if (!descriptor || !("url" in descriptor)) throw new Error("bridge did not start");
		const headers = Object.fromEntries(descriptor.headers.map((header) => [header.name, header.value]));
		const client = new Client({ name: "progress-test", version: "1" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
			requestInit: { headers },
		});
		const progressEvents: Array<{ progress: number; message?: string }> = [];
		try {
			await client.connect(transport as Parameters<typeof client.connect>[0]);
			const pending = client.callTool(
				{ name: "pi_echo", arguments: { text: "slow" } },
				undefined,
				{
					timeout: 500,
					maxTotalTimeout: 5_000,
					resetTimeoutOnProgress: true,
					onprogress: (progress) => {
						progressEvents.push({
							progress: progress.progress,
							...(progress.message !== undefined ? { message: progress.message } : {}),
						});
					},
				},
			);
			pending.catch(() => undefined);
			await vi.waitFor(() => expect(progressEvents.length).toBeGreaterThanOrEqual(3));
			// Without resetTimeoutOnProgress or keepalives, this exceeds timeout: 500.
			await new Promise((resolve) => setTimeout(resolve, 650));
			expect(progressEvents.every((entry, index) => index === 0 || entry.progress > progressEvents[index - 1]!.progress)).toBe(true);
			releaseCall();
			const result = await pending;
			expect(result.content).toEqual([{ type: "text", text: "finished" }]);
			const countAtCompletion = progressEvents.length;
			await new Promise((resolve) => setTimeout(resolve, 75));
			expect(progressEvents).toHaveLength(countAtCompletion);
		} finally {
			releaseCall?.();
			await client.close();
			await bridge.close();
		}
	});

	it("names the failing property without echoing argument values", async () => {
		const onCall = vi.fn();
		const bridge = new PiMcpBridge({
			tools: [{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) }],
			onCall,
		});
		const descriptor = await bridge.start();
		if (!descriptor || !("url" in descriptor)) throw new Error("bridge did not start");
		const headers = Object.fromEntries(descriptor.headers.map((header) => [header.name, header.value]));
		const client = new Client({ name: "bridge-test", version: "1" }, { capabilities: {} });
		const transport = new StreamableHTTPClientTransport(new URL(descriptor.url), {
			requestInit: { headers },
		});
		const errorText = async (args: Record<string, unknown>) => {
			const result = await client.callTool({ name: "pi_read", arguments: args });
			expect(result.isError).toBe(true);
			return (result.content as { text: string }[])[0]!.text;
		};
		try {
			await client.connect(transport as Parameters<typeof client.connect>[0]);
			const wrongType = await errorText({ path: 4242 });
			expect(wrongType).toContain("/path");
			expect(wrongType).not.toContain("4242");
			const missing = await errorText({});
			expect(missing).toContain("(root)");
			expect(missing).toContain("path");
			expect(onCall).not.toHaveBeenCalled();
		} finally {
			await client.close();
			await bridge.close();
		}
	});
});
