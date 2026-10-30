import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const scenario = process.argv[2];
const modern = scenario?.startsWith("config-options") || scenario === "effort-selector" || scenario === "legacy-set-model";
// The real 1.4.x server takes only base model ids on its `model` selector and
// silently ignores an effort-qualified id; these scenarios model that.
const qualifiedModelRejected = scenario === "effort-selector" || scenario === "legacy-set-model";
const effortSelector = scenario === "effort-selector";
// Prompt ids still awaiting a response, by session id.
const inFlight = new Map();
const send = (value) => {
	if (value.method === undefined) for (const [sessionId, promptId] of inFlight) if (promptId === value.id) inFlight.delete(sessionId);
	process.stdout.write(`${JSON.stringify(value)}\n`);
};
let sessionCount = 0;
let frozen = false;
const sessions = new Map();
// Any id can be loaded or resumed, so state starts with defaults on first use.
const state = (sessionId) => {
	if (!sessions.has(sessionId)) sessions.set(sessionId, { model: "auto", mode: "default", effort: "high" });
	return sessions.get(sessionId);
};
// agy 1.4.x writes this guide into the session cwd on setup and again at each
// prompt when it is missing.
const writeSystemSkill = (cwd) => {
	if (process.env.FAKE_AGENT_SYSTEM_SKILL !== "1" || !cwd) return;
	const dir = path.join(cwd, "skills", "system", "run-workflow");
	fs.mkdirSync(dir, { recursive: true });
	if (!fs.existsSync(path.join(dir, "SKILL.md"))) fs.writeFileSync(path.join(dir, "SKILL.md"), "fake system skill\n");
};

for await (const line of rl) {
	if (frozen || !line.trim()) continue;
	const message = JSON.parse(line);
	if (!("id" in message)) {
		if (message.method !== "session/cancel") continue;
		const session = state(message.params.sessionId);
		for (const pending of ["hanging", "permission", "bridge"]) {
			if (session[pending] === undefined) continue;
			send({ jsonrpc: "2.0", id: session[pending], result: { stopReason: "cancelled" } });
			session[pending] = undefined;
		}
		continue;
	}
	const { id, method, params } = message;
	if (process.env.FAKE_AGENT_LOG_FILE && method) fs.appendFileSync(process.env.FAKE_AGENT_LOG_FILE,
		JSON.stringify({ method, ...(method === "session/prompt" ? { prompt: params.prompt, mode: state(params.sessionId).mode } : {}), ...(method === "session/set_mode" ? { modeId: params.modeId } : {}), ...(method === "session/new" ? { cwd: params.cwd } : {}), ...(["session/new", "session/load", "session/resume"].includes(method) && params && "_meta" in params ? { _meta: params._meta } : {}) }) + "\n");
	if (typeof id === "string" && id.startsWith("permission-") && method === undefined) {
		const sessionId = id.slice("permission-".length);
		const session = state(sessionId);
		if (session.permission === undefined) continue;
		const decision = message.result?.outcome?.outcome ?? "cancelled";
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Decision: ${decision}` } },
			},
		});
		send({ jsonrpc: "2.0", id: session.permission, result: { stopReason: "end_turn" } });
		session.permission = undefined;
	} else if (method === "initialize") {
		if (scenario === "initialize-timeout") continue;
		if (scenario === "malformed-output") {
			process.stdout.write("not-json\n");
			continue;
		}
		if (scenario === "browser-noise") {
			process.stdout.write("Opening in existing browser session.\n");
		}
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: 1,
				agentInfo: { name: "fake-gemini", version: "1.0.0" },
				authMethods: [
					{ id: "oauth-personal", name: "Log in with Google" },
					{ id: "api", name: "Gemini API key", _meta: { "api-key": { provider: "google" } } },
				],
				agentCapabilities: {
					loadSession: true,
					promptCapabilities: { image: true, embeddedContext: true },
					mcpCapabilities: { http: scenario !== "no-mcp" },
					sessionCapabilities: { resume: {} },
				},
			},
		});
		if (scenario === "exit-after-initialize") {
			setTimeout(() => process.exit(0), 10);
		}
	} else if (method === "authenticate") {
		if (scenario === "headless-auth") {
			const state = "fake-oauth-state";
			const server = http.createServer((request, response) => {
				const callback = new URL(request.url ?? "/", "http://127.0.0.1");
				if (callback.searchParams.get("state") !== state || !callback.searchParams.get("code")) {
					response.writeHead(400).end("Invalid callback");
					return;
				}
				response.writeHead(200).end("Authenticated");
				server.close();
				send({ jsonrpc: "2.0", id, result: {} });
			});
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") throw new Error("missing fake OAuth address");
				const redirect = `http://127.0.0.1:${address.port}/`;
				const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
				authorization.searchParams.set("redirect_uri", redirect);
				authorization.searchParams.set("state", state);
				const browser = process.env.BROWSER;
				if (!browser) throw new Error("missing BROWSER capture command");
				const child = spawn(browser, [authorization.toString()], { env: process.env, stdio: "ignore" });
				child.once("error", (error) => {
					server.close();
					send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
				});
			});
			continue;
		}
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (method === "session/new") {
		if (scenario === "session-timeout") continue;
		if (scenario === "internal-error") {
			send({
				jsonrpc: "2.0",
				id,
				error: {
					code: -32603,
					message: "Internal error",
					data: { details: "Permission denied: localharness_external; api_key=AIza1234567890abcdefghijkl" },
				},
			});
			continue;
		}
		const sessionId = `fake-session-${++sessionCount}`;
		const session = state(sessionId);
		session.mcpServer = params.mcpServers?.find((server) => server.type === "http");
		session.cwd = params.cwd;
		writeSystemSkill(params.cwd);
		send({
			jsonrpc: "2.0",
			id,
			result: modern ? { sessionId, configOptions: sessionConfigOptions(session) } : {
				sessionId,
				modes: sessionModes(session),
				models: {
					currentModelId: session.model,
					availableModels: [
						{ modelId: "auto", name: "Auto" },
						{ modelId: "gemini-test", name: "Gemini Test" },
					],
				},
			},
		});
	} else if (method === "session/resume" || method === "session/load") {
		const session = state(params.sessionId);
		session.cwd = params.cwd;
		writeSystemSkill(params.cwd);
		send({
			jsonrpc: "2.0",
			id,
			result: modern ? { configOptions: sessionConfigOptions(session) } : {
				modes: sessionModes(session, true),
				models: { currentModelId: session.model, availableModels: [] },
			},
		});
	} else if (method === "session/set_config_option") {
		const session = state(params.sessionId);
		if (params.configId === "model-selector") {
			if (!qualifiedModelRejected || ["auto", "gemini-test"].includes(params.value)) session.model = params.value;
		} else if (params.configId === "thinking-level-selector") session.effort = params.value;
		else if (params.configId === "permission-selector") {
			if (scenario !== "config-options-ignored-mode") session.mode = params.value;
		}
		else {
			send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown selector" } });
			continue;
		}
		send({ jsonrpc: "2.0", id, result: { configOptions: sessionConfigOptions(session) } });
	} else if (modern && (method === "session/set_model" || method === "session/set_mode")) {
		if (scenario === "legacy-set-model" && method === "session/set_model") {
			state(params.sessionId).model = params.modelId;
			send({ jsonrpc: "2.0", id, result: {} });
			continue;
		}
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Use config options" } });
	} else if (method === "session/set_model") {
		state(params.sessionId).model = params.modelId;
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (method === "session/set_mode") {
		if (scenario === "set-mode-fails" && params.modeId === "auto_edit") {
			send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Mode change refused" } });
			continue;
		}
		state(params.sessionId).mode = params.modeId;
		send({ jsonrpc: "2.0", id, result: {} });
	} else if (method === "session/prompt") {
		// agy refuses a prompt while the same session still runs a turn.
		if (inFlight.has(params.sessionId)) {
			send({ jsonrpc: "2.0", id, error: { code: -32603, message: "Concurrent receive_steps() calls are not supported on this connection." } });
			continue;
		}
		inFlight.set(params.sessionId, id);
		const session = state(params.sessionId);
		writeSystemSkill(session.cwd);
		const text = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
		// agy runs these slash commands itself instead of prompting the model.
		const joined = params.prompt.filter((block) => block.type === "text").map((block) => block.text).join("").trim();
		const slash = joined === "/logout" ? "logout" : /^\/usage(?:\s|$)/iu.test(joined) ? "usage"
			: params.prompt.some((block) => block.type === "text" && /(?:\s|^)\/plan(?:\s|$)/u.test(block.text)) ? "plan" : undefined;
		if (slash) {
			const reply = slash !== "usage" ? `Intercepted /${slash}`
				: scenario === "usage-unavailable"
					? "### Session Usage\n- **Session total:** data not available yet\n\n### Quota Limits\n- Unable to retrieve quota status (backend unavailable)"
					: fs.readFileSync(new URL("./usage-reply.md", import.meta.url), "utf8");
			send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } } } });
			send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
			continue;
		}
		if (text === "crash process") process.exit(1);
		if (text === "freeze process") {
			frozen = true;
			continue;
		}
		if (text === "ignore cancel") continue;
		// Handoffs carry the original request explicitly, but tell the agent not
		// to repeat completed actions. Model that instruction rather than treating
		// scenario keywords in the replayed request as a fresh tool invocation.
		const continuing = params.prompt.some((block) => block.type === "text" && block.text.includes("Continue the current Pi user request"));
		if (scenario === "mode-drift" || scenario === "config-options-mode-drift") {
			session.mode = "yolo";
			send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId,
				update: modern ? { sessionUpdate: "config_option_update", configOptions: sessionConfigOptions(session) }
					: { sessionUpdate: "current_mode_update", currentModeId: session.mode } } });
		}
		// `count <n> <marker>` streams `<marker><i>;` chunks on a timer, so
		// concurrent sessions interleave.
		const counting = /^count (\d+) (\S+)$/u.exec(text);
		if (counting || text === "stream progress" || text === "native work" || text === "native stuck") {
			session.hanging = id;
			const notify = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } });
			if (text.startsWith("native")) notify({ sessionUpdate: "tool_call_update", toolCallId: "native", status: "in_progress" });
			if (text === "native stuck") continue;
			let count = 0;
			const timer = setInterval(() => {
				if (session.hanging !== id) { clearInterval(timer); return; }
				count++;
				if (text === "stream progress") notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "." } });
				if (counting) notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${counting[2]}${count};` } });
				if (count < (counting ? Number(counting[1]) : 8)) return;
				clearInterval(timer);
				if (text === "native work") notify({ sessionUpdate: "tool_call_update", toolCallId: "native", status: "completed" });
				session.hanging = undefined;
				send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
			}, Number(process.env.FAKE_PROGRESS_STEP_MS ?? 30));
			continue;
		}
		const notify = (update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.sessionId, update } });
		// agy reports the context size after each inference; setup sends used: 0.
		const usageUpdate = (used) => notify({ sessionUpdate: "usage_update", used, size: 1048576 });
		const mcpServer = session.mcpServer;
		if (!continuing && text.includes("bridge") && mcpServer) {
			session.bridge = id;
			const reportUsage = text.includes("usage");
			if (reportUsage) { usageUpdate(0); usageUpdate(1000); }
			const invocation = text.includes("parallel")
				? Promise.all([
						text.includes("reversed")
							? new Promise((resolve) => setTimeout(resolve, 50)).then(() => invokeMcpTool(mcpServer, "first"))
							: invokeMcpTool(mcpServer, "first"),
						text.includes("reversed")
							? invokeMcpTool(mcpServer, "second")
							: new Promise((resolve) => setTimeout(resolve, 50)).then(() => invokeMcpTool(mcpServer, "second")),
					]).then((results) => results.join(","))
				: invokeMcpTool(mcpServer, "from gemini");
			void invocation.then(async (result) => {
				if (text.includes("bridge delayed")) await new Promise((resolve) => setTimeout(resolve, 500));
				if (session.bridge !== id) return;
				session.bridge = undefined;
				if (reportUsage) usageUpdate(1800);
				send({
					jsonrpc: "2.0",
					method: "session/update",
					params: {
						sessionId: params.sessionId,
						update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result } },
					},
				});
				send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn",
					...(reportUsage ? { usage: { inputTokens: 2400, outputTokens: 200, totalTokens: 2600 } } : {}) } });
			});
			continue;
		}
		if (scenario === "quota-exhausted") {
			// agy reports exhaustion as a plain reply: no usage, and `refusal` when the SDK flags it.
			const reset = text.includes("absolute") ? " Your limit will reset on Oct 2, 2026 14:00 UTC."
				: text.includes("no reset") ? "" : " Your limit will reset in 3 hours, 51 minutes.";
			notify({ sessionUpdate: "agent_message_chunk", content: { type: "text",
				text: `Usage Limit Reached\n\nYou have reached your current quota for this period.${reset}` } });
			send({ jsonrpc: "2.0", id, result: { stopReason: text.includes("refusal") ? "refusal" : "end_turn",
				...(text.includes("refusal") || text.includes("quoted") ? { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } : {}) } });
			continue;
		}
		if (text === "usage single") {
			usageUpdate(1600);
			notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
			send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn",
				usage: { inputTokens: 1000, cachedReadTokens: 400, outputTokens: 150, thoughtTokens: 50, totalTokens: 1200 } } });
			continue;
		}
		if (!continuing && text.includes("hang")) {
			session.hanging = id;
			continue;
		}
		if (!continuing && text.includes("permission")) {
			session.permission = id;
			send({
				jsonrpc: "2.0",
				id: `permission-${params.sessionId}`,
				method: "session/request_permission",
				params: {
					sessionId: params.sessionId,
					toolCall: { toolCallId: "native-tool-1", title: "Run native command", kind: "execute" },
					options: [
						{ optionId: "allow-once", name: "Allow once", kind: "allow_once" },
						{ optionId: "reject-once", name: "Reject", kind: "reject_once" },
					],
				},
			});
			continue;
		}
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: params.sessionId,
				update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Checking" } },
			},
		});
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: params.sessionId,
				update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
			},
		});
		send({
			jsonrpc: "2.0",
			id,
			result: {
				stopReason: "end_turn",
				_meta: { quota: { token_count: { input_tokens: 7, output_tokens: 3 }, model_usage: [] } },
			},
		});
	} else {
		send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method ${method}` } });
	}
}

function sessionModes(session, restored = false) {
	if (scenario === "no-mode-metadata") return undefined;
	const unavailable = scenario === "no-auto-edit-mode" ? "auto_edit"
		: scenario === "no-default-mode" || (restored && scenario === "no-default-on-restore") ? "default" : undefined;
	return { currentModeId: session.mode, availableModes: ["default", "auto_edit", "yolo"].filter((id) => id !== unavailable).map((id) => ({ id, name: id })) };
}

function sessionConfigOptions(session) {
	return [
		{ id: "model-selector", name: "Model", category: "model", type: "select", currentValue: session.model,
			options: [{ group: "google", name: "Google", options: [
				{ value: "auto", name: "Auto" }, { value: "gemini-test", name: "Gemini Test" },
			] }] },
		...(effortSelector || (scenario === "config-options-disappearing-thought" && session.model === "auto")
			? [{ id: "thinking-level-selector", name: "Thinking", category: "thought_level", type: "select",
				currentValue: session.effort, options: ["low", "medium", "high"].map((value) => ({ value, name: value })) }]
			: []),
		{ id: "permission-selector", name: "Permissions", category: "mode", type: "select", currentValue: session.mode,
			options: ["default", "auto_edit", "yolo"].map((value) => ({ value, name: value })) },
	];
}

async function invokeMcpTool(server, text) {
	const headers = Object.fromEntries(server.headers.map((header) => [header.name, header.value]));
	const client = new Client({ name: "fake-gemini", version: "1" }, { capabilities: {} });
	const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
	try {
		await client.connect(transport);
		const result = await client.callTool({ name: "pi_echo", arguments: { text } });
		return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
	} finally {
		await client.close();
	}
}
