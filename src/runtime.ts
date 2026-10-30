import type {
	ContentBlock,
	InitializeResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk";
import {
	collapseSystemMessages,
	getCurrentSystemPrompt,
	getCurrentTools,
	normalizeContext,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

import {
	clearAntigravityCredentials,
	inspectAntigravityAuth,
	type AntigravityAuthHealth,
} from "./acp/antigravity.js";
import { AntigravityAcpConnection, type AntigravityConnectionOptions } from "./acp/connection.js";
import {
	AcpConnectionPool,
	waitUnlessAborted,
	type ConnectionLease,
	type OpenedConnection,
	type PooledProcessSnapshot,
} from "./acp/connection-pool.js";
import { abortError, AntigravityAcpError, errorMessage } from "./acp/errors.js";
import { quotaExhaustion } from "./acp/quota.js";
import { AcpSessionStore } from "./acp/session-store.js";
import { sessionModels, sessionModes, type AcpModelInfo, type AcpNewSessionResponse, type SessionState } from "./acp/session-state.js";
import { parseUsageQuota, type AntigravityQuotaSnapshot } from "./acp/usage-quota.js";
import {
	MANAGED_AUTH_MARKER,
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
} from "./constants.js";
export { MANAGED_AUTH_MARKER, PERMISSION_RESULT_KIND, PERMISSION_TOOL_NAME } from "./constants.js";
import { mapSessionUpdate, type ToolCallEntry } from "./acp/events.js";
import { ensureAntigravityAcpReady } from "./acp/setup.js";
import { HeadlessOAuthRelay, shouldUseHeadlessOAuth } from "./acp/headless-oauth.js";
import {
	MCP_MAX_OUTPUT_BYTES,
	PiMcpBridge,
	piToolFingerprint,
	planToolProjection,
	type ToolOmission,
	type PiToolInvocation,
} from "./mcp/bridge.js";
import { DEFAULT_IDLE_TTL_MS, DEFAULT_MAX_LIVE_SESSIONS, DEFAULT_MAX_SESSIONS_PER_PROCESS, type NativeTools, type PermissionMode } from "./config.js";
import { resolveAcpModelId } from "./models.js";
import { type PromptParts, buildPromptParts, currentSystemInstructions } from "./stream/context.js";
import { PiEventWriter } from "./stream/pi-events.js";
import { usageFromPrompt } from "./stream/usage.js";
import { RuntimeMetrics } from "./status.js";

const PERMISSION_TIMEOUT_MS = 120_000;
const TOOL_BATCH_MS = 100;
const IDLE_SWEEP_MAX_MS = 60_000;
const QUOTA_CACHE_MS = 60_000;
const QUOTA_TIMEOUT_MS = 30_000;
// agy keeps every session's harness (~140 MB) until its process exits; measured on agy 1.4.3,
// a process that has set up 6 sessions holds about 1.13 GB, so it is retired then, whatever
// maxSessionsPerProcess allows; a lower cap only limits how many of those 6 are live at once.
const RECYCLE_AFTER_SESSIONS = 6;

type AntigravityModel = Model<"antigravity-acp">;

interface PendingPermission {
	id: string;
	request: RequestPermissionRequest;
	resolve: (response: RequestPermissionResponse) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface PendingPiTool {
	invocation: PiToolInvocation;
	/** Resolve the MCP request and release its bounded work-watchdog hold. */
	resolve: (result: CallToolResult) => void;
}

interface Binding {
	key: string;
	cwd: string;
	connection: AntigravityAcpConnection;
	/** Set when the connection is shared with other bindings. */
	lease: ConnectionLease | undefined;
	initialize: InitializeResponse;
	session: AcpNewSessionResponse;
	mode: PermissionMode;
	instructionsFingerprint: string | undefined;
	needsReconstruction: boolean;
	modelId: string;
	messageCount: number;
	historyFingerprint: string;
	expectedAssistantFingerprint: string | undefined;
	pendingContextCount: number;
	pendingContextFingerprint: string;
	writer: PiEventWriter | undefined;
	permission: PendingPermission | undefined;
	pendingTools: Map<string, PendingPiTool>;
	toolCalls: Map<string, ToolCallEntry>;
	/** Latest `usage_update.used` and the inference count of the running ACP prompt. */
	contextUsed: number | undefined;
	inferences: number;
	toolBatchTimer: ReturnType<typeof setTimeout> | undefined;
	bridge: PiMcpBridge | undefined;
	toolFingerprint: string;
	omittedTools: ToolOmission[];
	turnCompletion: Promise<void> | undefined;
	abortRequested: boolean;
	piSessionId: string | undefined;
	restored: boolean;
	lastActivity: number;
}

export interface PermissionView {
	id: string;
	title: string;
	options: Array<{ id: string; label: string; kind: string }>;
}

export interface ManualGoogleLoginInteraction {
	showAuthorizationUrl: (url: string, instructions: string) => void;
	promptForCallback: (signal: AbortSignal) => Promise<string>;
}

export interface PermissionToolResult {
	kind: typeof PERMISSION_RESULT_KIND;
	requestId: string;
	optionId?: string;
	cancelled: boolean;
}

export interface RuntimeSnapshot {
	bindings: number;
	permissionMode: PermissionMode;
	idleTtlMs: number;
	evictions: number;
	maxLiveSessions: number;
	capEvictions: number;
	capOverflows: number;
	nativeTools: NativeTools;
	sharedProcess: boolean;
	maxSessionsPerProcess: number;
	sharedProcesses: PooledProcessSnapshot[];
	metrics: ReturnType<RuntimeMetrics["snapshot"]>;
	processes: Array<{
		key: string;
		pid?: number;
		generation: number;
		sessionId: string;
		modelId: string;
		confirmedPermissionMode: PermissionMode;
		omittedTools: ToolOmission[];
		alive: boolean;
		waitingForPermission: boolean;
		waitingForTools: number;
		agentVersion: string | undefined;
		mcpHttp: boolean;
		restored: boolean;
		idleMs: number;
		ignoredStdoutNoiseLines: number;
		stderrTail?: string;
	}>;
}

export type AntigravityConnectionFactory = (options: AntigravityConnectionOptions) => AntigravityAcpConnection;

export class AntigravityRuntime {
	private readonly bindings = new Map<string, Promise<Binding>>();
	private readonly resolvedBindings = new Set<Binding>();
	private disposed = false;
	private closePromise: Promise<void> | undefined;
	private bindingEpoch = 0;
	private readonly activeConnections = new Set<AntigravityAcpConnection>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly enteringTurns = new Map<string, number>();
	private readonly sessionCwds = new Map<string, string>();
	private modeChanges = Promise.resolve();

	private readonly connectionFactory: AntigravityConnectionFactory;
	private readonly ensureAgent: boolean;
	private readonly sessionStore: AcpSessionStore | undefined;
	private readonly metrics = new RuntimeMetrics();
	private permissionMode: PermissionMode;
	private readonly idleTtlMs: number;
	private readonly idleSweep: ReturnType<typeof setInterval> | undefined;
	private evictions = 0;
	private readonly maxLiveSessions: number;
	private readonly startingBindings = new Set<symbol>();
	private capEvictions = 0;
	private capOverflows = 0;
	private readonly nativeTools: NativeTools;
	private quotaCache: AntigravityQuotaSnapshot | undefined;
	private quotaInFlight: Promise<AntigravityQuotaSnapshot> | undefined;
	private readonly pool: AcpConnectionPool | undefined;
	private readonly maxSessionsPerProcess: number;

	constructor(
		connectionFactory?: AntigravityConnectionFactory,
		permissionMode: PermissionMode = "yolo",
		sessionStore?: AcpSessionStore,
		limits: {
			idleTtlMs?: number;
			maxLiveSessions?: number;
			nativeTools?: NativeTools;
			sharedProcess?: boolean;
			maxSessionsPerProcess?: number;
		} = {},
	) {
		this.nativeTools = limits.nativeTools ?? "all";
		this.maxSessionsPerProcess = limits.maxSessionsPerProcess ?? DEFAULT_MAX_SESSIONS_PER_PROCESS;
		if (limits.sharedProcess) {
			this.pool = new AcpConnectionPool({
				maxSessionsPerProcess: this.maxSessionsPerProcess,
				recycleAfterSessions: RECYCLE_AFTER_SESSIONS,
				idleTtlMs: limits.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
			});
		}
		this.maxLiveSessions = limits.maxLiveSessions ?? DEFAULT_MAX_LIVE_SESSIONS;
		this.connectionFactory = connectionFactory ?? ((options) => new AntigravityAcpConnection(options));
		this.ensureAgent = connectionFactory === undefined;
		this.permissionMode = permissionMode;
		this.sessionStore = sessionStore ?? (this.ensureAgent ? new AcpSessionStore() : undefined);
		this.idleTtlMs = limits.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
		if (this.idleTtlMs > 0) {
			this.idleSweep = setInterval(() => this.sweepIdle(), Math.min(this.idleTtlMs, IDLE_SWEEP_MAX_MS));
			this.idleSweep.unref();
		}
	}

	stream(model: AntigravityModel, context: Context, options: SimpleStreamOptions = {}): PiEventWriter {
		const writer = new PiEventWriter(model);
		// ACP has no mid-conversation system-message API. Replay Pi's prompt/tool
		// deltas into a checkpoint; its fingerprint invalidates stale warm sessions.
		try {
			const transcript = collapseSystemMessages(normalizeContext(context));
			const resolvedContext: Context = {
				messages: transcript.messages,
				systemPrompt: getCurrentSystemPrompt(transcript.messages),
				tools: getCurrentTools(transcript.messages),
			};
			currentSystemInstructions(resolvedContext);
			// One-off requests (e.g. compaction summaries) never keep or save a session.
			const persistent = Boolean(options.sessionId) && options.cacheRetention !== "none";
			const key = persistent
				? `sid:${options.sessionId}`
				: (this.findContinuationKey(resolvedContext) ?? `ephemeral:${crypto.randomUUID()}`);
			// Reserved synchronously so cap eviction and the idle sweep never pick a session whose turn is starting.
			this.enteringTurns.set(key, (this.enteringTurns.get(key) ?? 0) + 1);
			void this.runQueued(model, resolvedContext, options, writer, key, persistent).catch((error: unknown) => {
				writer.fail(error, options.signal?.aborted === true || isAbort(error));
			}).finally(() => {
				const count = (this.enteringTurns.get(key) ?? 1) - 1;
				if (count > 0) this.enteringTurns.set(key, count);
				else this.enteringTurns.delete(key);
			});
		} catch (error) {
			writer.fail(error, options.signal?.aborted === true || isAbort(error));
		}
		return writer;
	}

	async discoverModels(apiKey: string | undefined, signal?: AbortSignal): Promise<AcpModelInfo[]> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (signal?.aborted) throw abortError();
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		if (signal?.aborted) throw abortError();
		this.assertEpoch(epoch);
		const connection = this.createConnection({ cwd: process.cwd() });
		try {
			const initialize = await connection.initialize(signal);
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			const session = await connection.newSession(process.cwd(), signal);
			this.assertEpoch(epoch);
			return sessionModels(session)?.availableModels ?? [];
		} finally {
			await connection.close();
		}
	}

	/** Live quota from agy's own `/usage`, which answers without model inference or history writes. */
	async quota(apiKey: string | undefined, signal?: AbortSignal): Promise<AntigravityQuotaSnapshot> {
		if (signal?.aborted) throw abortError();
		if (this.quotaCache && Date.now() - this.quotaCache.at < QUOTA_CACHE_MS) return this.quotaCache;
		this.quotaInFlight ??= this.fetchQuota(apiKey)
			.then((snapshot) => (this.quotaCache = snapshot))
			.finally(() => { this.quotaInFlight = undefined; });
		return waitUnlessAborted(this.quotaInFlight, signal);
	}

	// A separate short-lived process, never a user's warm session, so `/usage` cannot race user turns.
	private async fetchQuota(apiKey: string | undefined): Promise<AntigravityQuotaSnapshot> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		this.assertEpoch(epoch);
		let sessionId: string | undefined;
		let text = "";
		const connection = this.createConnection({
			cwd: process.cwd(),
			promptIdleTimeoutMs: QUOTA_TIMEOUT_MS,
			handlers: {
				onUpdate: ({ sessionId: id, update }) => {
					if (id === sessionId && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text;
				},
				onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			},
		});
		try {
			const initialize = await connection.initialize();
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey);
			this.assertEpoch(epoch);
			sessionId = (await connection.newSession(process.cwd())).sessionId;
			this.assertEpoch(epoch);
			// Sent raw: user-text neutralization would turn it into a model turn that spends quota.
			await connection.prompt({ sessionId, prompt: [{ type: "text", text: "/usage" }] });
			return parseUsageQuota(text);
		} finally {
			await connection.close();
		}
	}

	async loginGoogle(
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
		manualInteraction?: ManualGoogleLoginInteraction,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady(onProgress);
		this.assertEpoch(epoch);
		const useManualOAuth = manualInteraction !== undefined && shouldUseHeadlessOAuth();
		const relay = useManualOAuth ? new HeadlessOAuthRelay() : undefined;
		const connection = this.createConnection({
			cwd: process.cwd(),
			...(relay ? { env: relay.env } : {}),
		});
		try {
			const initialize = await connection.initialize();
			this.assertEpoch(epoch);
			const method = initialize.authMethods?.find((candidate) =>
				/log\s*in\s+with\s+google|google\s+account|oauth-personal/iu.test(
					`${candidate.id} ${candidate.name}`,
				),
			);
			if (!method) throw new AntigravityAcpError("auth", "Antigravity ACP did not advertise Google login");
			const authentication = connection.authenticate(
				{ methodId: method.id },
				signal,
				relay ? 10 * 60_000 : undefined,
			);
			void authentication.catch(() => undefined);
			if (relay && manualInteraction) {
				const captured = await raceAuthentication(relay.waitForAuthorization(signal), authentication);
				if (captured.authenticated) {
					onProgress?.("Antigravity reused the saved Google login.");
				} else {
					const instructions =
						"Open this URL in a browser on your local machine. After Google redirects to localhost, the page may fail to load; copy the complete localhost URL from the browser address bar and paste it below.";
					manualInteraction.showAuthorizationUrl(captured.value.url, instructions);
					const promptController = new AbortController();
					let entered: Awaited<ReturnType<typeof raceAuthentication<string>>>;
					try {
						entered = await raceAuthentication(
							manualInteraction.promptForCallback(promptController.signal),
							authentication,
						);
					} catch (error) {
						promptController.abort();
						throw error;
					}
					if (entered.authenticated) {
						promptController.abort();
					} else {
						await relay.forwardCallback(entered.value, captured.value, signal);
					}
				}
			}
			await authentication;
			this.assertEpoch(epoch);
			await connection.newSession(process.cwd(), signal);
			this.assertEpoch(epoch);
		} finally {
			relay?.dispose();
			await connection.close();
		}
	}

	async verifyApiKey(
		apiKey: string,
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady(onProgress);
		this.assertEpoch(epoch);
		const connection = this.createConnection({ cwd: process.cwd() });
		try {
			const initialize = await connection.initialize();
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			await connection.newSession(process.cwd(), signal);
			this.assertEpoch(epoch);
		} finally {
			await connection.close();
		}
	}

	async authHealth(apiKey?: string): Promise<AntigravityAuthHealth & { networkValid?: boolean; error?: string }> {
		const local = inspectAntigravityAuth();
		try {
			await this.discoverModels(apiKey ?? (hasUsableLocalAuth(local) ? MANAGED_AUTH_MARKER : undefined));
			return { ...local, networkValid: true };
		} catch (error) {
			return { ...local, networkValid: false, error: errorMessage(error) };
		}
	}

	async logout(): Promise<void> {
		await this.closeBindings();
		this.quotaCache = undefined;
		this.sessionStore?.clear();
		clearAntigravityCredentials();
	}

	setPermissionMode(mode: PermissionMode): Promise<void> {
		const change = this.modeChanges.then(async () => {
			this.assertActive();
			this.permissionMode = mode;
			await Promise.all([...this.resolvedBindings].map(async (binding) => {
				if (binding.mode === mode && this.confirmedMode(binding) === mode) return;
				// Never change policy under an executing turn or leave an unsupported session alive.
				if (!binding.turnCompletion && supportsMode(binding.connection.getSessionState(binding.session.sessionId), mode)) {
					try {
						await binding.connection.setMode(binding.session.sessionId, mode);
						if (this.confirmedMode(binding) === mode) { binding.mode = mode; return; }
					} catch { /* Close below; the next turn must negotiate again. */ }
				}
				await this.invalidateBinding(binding);
			}));
		});
		this.modeChanges = change.catch(() => undefined);
		return change;
	}

	getPermission(requestId: string): PermissionView | undefined {
		for (const binding of this.resolvedBindings) {
			if (binding.permission?.id === requestId) return permissionView(binding.permission);
		}
		return undefined;
	}

	async snapshot(includeStderr = false): Promise<RuntimeSnapshot> {
		const entries = [...this.bindings.entries()];
		const processes = await Promise.all(
			entries.map(async ([key, pending]) => {
				const binding = await pending;
				const pid = binding.connection.process.pid;
				return {
					key,
					...(pid === undefined ? {} : { pid }),
					generation: binding.connection.process.generation,
					sessionId: binding.session.sessionId,
					modelId: binding.modelId,
					confirmedPermissionMode: binding.mode,
					omittedTools: binding.omittedTools,
					alive: binding.connection.process.alive,
					waitingForPermission: binding.permission !== undefined,
					waitingForTools: binding.pendingTools.size,
					agentVersion: binding.initialize.agentInfo?.version,
					mcpHttp: binding.initialize.agentCapabilities?.mcpCapabilities?.http === true,
					restored: binding.restored,
					idleMs: Date.now() - binding.lastActivity,
					ignoredStdoutNoiseLines: binding.connection.process.ignoredStdoutNoiseLines,
					...(includeStderr ? { stderrTail: binding.connection.process.stderrTail } : {}),
				};
			}),
		);
		return {
			bindings: processes.length,
			permissionMode: this.permissionMode,
			idleTtlMs: this.idleTtlMs,
			evictions: this.evictions,
			maxLiveSessions: this.maxLiveSessions,
			capEvictions: this.capEvictions,
			capOverflows: this.capOverflows,
			nativeTools: this.nativeTools,
			sharedProcess: this.pool !== undefined,
			maxSessionsPerProcess: this.maxSessionsPerProcess,
			sharedProcesses: this.pool?.snapshot() ?? [],
			metrics: this.metrics.snapshot(),
			processes,
		};
	}

	close(): Promise<void> {
		this.disposed = true;
		clearInterval(this.idleSweep);
		return this.closePromise ??= this.closeBindings();
	}

	/** Sets the working directory for a Pi session's future ACP session; unset sessions use process.cwd(). */
	setSessionCwd(piSessionId: string, cwd: string): void {
		this.sessionCwds.set(piSessionId, cwd);
	}

	/** Closes one Pi session's binding but keeps its saved record so a later turn can resume it. */
	async closeSession(piSessionId: string): Promise<void> {
		const key = `sid:${piSessionId}`;
		this.sessionCwds.delete(piSessionId);
		this.queues.delete(key);
		const binding = await this.bindings.get(key)?.catch(() => undefined);
		if (!binding) return;
		const completion = binding.turnCompletion;
		if (completion) {
			abortTurn(binding);
			void binding.connection.cancel(binding.session.sessionId).catch(() => undefined);
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([completion, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1_500); })]);
			clearTimeout(timer);
		}
		await this.dropBinding(key, binding, false);
	}

	/** Drops warm sessions idle past the TTL; their saved records let the next turn resume them. */
	private sweepIdle(): void {
		const now = Date.now();
		for (const binding of [...this.resolvedBindings]) {
			if (now - binding.lastActivity < this.idleTtlMs || !this.isIdle(binding)) continue;
			this.evictions += 1;
			void this.evict(binding);
		}
	}

	/**
	 * Makes room for a new binding at the cap; busy sessions are never touched, so the cap may be exceeded.
	 * Runs synchronously up to the eviction so sessions still starting count against the cap.
	 */
	private async evictForCap(key: string): Promise<void> {
		if (this.maxLiveSessions === 0 || this.resolvedBindings.size + this.startingBindings.size < this.maxLiveSessions) return;
		// The set is kept in least-recently-used order by touch().
		const victim = [...this.resolvedBindings].find((binding) => binding.key !== key && this.isIdle(binding));
		if (!victim) {
			this.capOverflows += 1;
			return;
		}
		this.capEvictions += 1;
		await this.evict(victim);
	}

	private evict(binding: Binding): Promise<void> {
		// Leave the set now so an overlapping eviction cannot pick the same binding twice.
		this.resolvedBindings.delete(binding);
		return this.dropBinding(binding.key, binding, false).catch(() => undefined);
	}

	private touch(binding: Binding): void {
		binding.lastActivity = Date.now();
		if (this.resolvedBindings.delete(binding)) this.resolvedBindings.add(binding);
	}

	private isIdle(binding: Binding): boolean {
		return !binding.turnCompletion && !binding.permission && binding.pendingTools.size === 0 &&
			!this.queues.has(binding.key) && !this.enteringTurns.has(binding.key);
	}

	private async closeBindings(): Promise<void> {
		this.bindingEpoch += 1;
		this.pool?.closeAll();
		const pending = [...this.bindings.values()];
		this.bindings.clear();
		for (const binding of this.resolvedBindings) {
			cancelPermission(binding);
			cancelPiTools(binding, "Provider shut down before Pi returned the tool result");
		}
		this.resolvedBindings.clear();
		// Includes authentication/discovery and sessions still initializing, not just warm bindings.
		await Promise.allSettled([...this.activeConnections].map((connection) => connection.close()));
		await Promise.allSettled(
			pending.map(async (binding) => {
				const value = await binding;
				await Promise.allSettled([
					value.connection.close(),
					value.bridge?.close() ?? Promise.resolve(),
				]);
			}),
		);
	}

	private async runQueued(
		model: AntigravityModel,
		context: Context,
		options: SimpleStreamOptions,
		writer: PiEventWriter,
		key: string,
		persistent: boolean,
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		await this.modeChanges;
		this.assertEpoch(epoch);
		const tools = context.tools ?? [];
		const acpModelId = resolveAcpModelId(model, options.reasoning);
		let binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
		// Keeps the idle sweep off a binding this turn is about to use.
		this.touch(binding);
		await this.modeChanges;
		this.assertEpoch(epoch);
		// Check before continuation early returns as well as before fresh prompts.
		if (binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode ||
			binding.toolFingerprint !== piToolFingerprint(tools)) {
			await this.invalidateBinding(binding);
			binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
		}

		// A permission tool result resumes the still-running ACP prompt rather than
		// starting a second Antigravity turn.
		if (binding.permission) {
			const pending = binding.permission;
			const result = findPermissionResult(context, pending.id);
			if (!result) {
				cancelPermission(binding);
				await this.dropBinding(key, binding);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			} else {
				binding.writer = writer;
				this.noteContinuationInstructions(binding, context);
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = messagesFingerprint(context.messages);
				binding.permission = undefined;
				clearTimeout(pending.timer);
				if (
					!result.cancelled &&
					result.optionId &&
					pending.request.options.some((option) => option.optionId === result.optionId)
				) {
					pending.resolve({ outcome: { outcome: "selected", optionId: result.optionId } });
				} else {
					pending.resolve({ outcome: { outcome: "cancelled" } });
				}
				await this.awaitContinuation(binding, options.signal);
				return;
			}
		}

		if (binding.pendingTools.size > 0) {
			const results = [...binding.pendingTools.values()].map((pending) => ({
				pending,
				message: findToolResult(context, pending.invocation.id, pending.invocation.name),
			}));
			if (results.some((result) => result.message === undefined)) {
				cancelPiTools(binding, "Pi continued without returning every requested tool result");
				await this.dropBinding(key, binding);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			} else {
				binding.writer = writer;
				this.noteContinuationInstructions(binding, context);
				binding.pendingContextCount = context.messages.length;
				binding.pendingContextFingerprint = messagesFingerprint(context.messages);
				for (const { pending, message } of results) {
					binding.pendingTools.delete(pending.invocation.id);
					pending.resolve(toMcpToolResult(message as ToolResultMessage));
				}
				await this.awaitContinuation(binding, options.signal);
				return;
			}
		}

		const previous = this.queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const queue = new Promise<void>((resolve) => { release = resolve; });
		this.queues.set(key, queue);
		await previous;

		let completeTurn: (() => void) | undefined;
		let onTurnAbort: (() => void) | undefined;
		try {
			await this.modeChanges;
			this.assertEpoch(epoch);
			// A queued caller may hold an obsolete binding after shutdown/mode changes.
			binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			if (
				binding.needsReconstruction || binding.mode !== this.permissionMode ||
				this.confirmedMode(binding) !== this.permissionMode ||
				binding.toolFingerprint !== piToolFingerprint(tools) ||
				context.messages.length < binding.messageCount ||
				messagesFingerprint(context.messages.slice(0, binding.messageCount)) !==
					binding.historyFingerprint
			) {
				await this.dropBinding(key, binding, true);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			}
			binding.writer = writer;
			if (binding.modelId !== acpModelId) {
				try {
					await binding.connection.setModel(binding.session.sessionId, acpModelId, options.signal);
					binding.modelId = acpModelId;
				} catch (error) {
					// A split selection can change the base before effort fails. Neither
					// the warm cache nor its saved session is trustworthy after failure.
					await this.invalidateBinding(binding);
					throw error;
				}
			}

			const fresh = binding.messageCount === 0;
			let unseenStart = binding.messageCount;
			const expected = context.messages[unseenStart];
			if (
				!fresh &&
				expected?.role === "assistant" &&
				binding.expectedAssistantFingerprint === messageFingerprint(expected)
			) {
				unseenStart += 1;
			}
			const parts = adaptPromptToCapabilities(
				buildPromptParts(context, fresh, unseenStart),
				binding.initialize,
			);
			await this.modeChanges;
			this.assertEpoch(epoch);
			if (binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode || !binding.connection.process.alive) {
				await this.invalidateBinding(binding);
				throw new AntigravityAcpError("protocol", "Permission mode changed before prompting; retry the turn");
			}
			binding.instructionsFingerprint = instructionFingerprint(context);
			binding.needsReconstruction = false;
			binding.pendingContextCount = context.messages.length;
			binding.pendingContextFingerprint = messagesFingerprint(context.messages);
			binding.contextUsed = undefined;
			binding.inferences = 0;
			binding.turnCompletion = new Promise<void>((resolve) => {
				completeTurn = resolve;
			});
			if (options.signal) {
				const promptBinding = binding;
				onTurnAbort = () => abortTurn(promptBinding);
				options.signal.addEventListener("abort", onTurnAbort, { once: true });
				if (options.signal.aborted) onTurnAbort();
			}
			const response = await binding.connection.prompt(
				{ sessionId: binding.session.sessionId, prompt: parts.prompt },
				options.signal,
			);
			if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
			const activeWriter = binding.writer ?? writer;
			if (binding.abortRequested) throw abortError();
			const usage = usageFromPrompt(response);
			this.metrics.record(response, usage);
			// agy reports exhaustion as an ordinary reply; fail it before the turn is persisted.
			const quota = usage.totalTokens === 0 || response.stopReason === "refusal"
				? quotaExhaustion(activeWriter.message.content.map((block) => block.type === "text" ? block.text : "").join(""))
				: undefined;
			if (quota) {
				throw new AntigravityAcpError("quota",
					`Antigravity quota exceeded for ${binding.modelId}.${quota.resetAt ? ` Resets at ${quota.resetAt}.` : ""}`);
			}
			if (binding.contextUsed !== undefined) {
				// Pi sizes the context from the last message's totalTokens, but the response sums every
				// inference. agy adds cache reads to `used` twice; with one inference the response's cache
				// count is that inference's, so subtracting it is exact. Longer prompts with cache reads
				// still overcount by the last inference's cached tokens.
				activeWriter.message.usage = {
					...usage,
					totalTokens: binding.inferences === 1 ? Math.max(0, binding.contextUsed - usage.cacheRead) : binding.contextUsed,
				};
			} else activeWriter.message.usage = usage;
			activeWriter.message.rawStopReason = response.stopReason;
			binding.messageCount = binding.pendingContextCount || parts.messageCount;
			binding.historyFingerprint = binding.pendingContextFingerprint;
			binding.expectedAssistantFingerprint = messageFingerprint(activeWriter.message);
			this.persistBinding(binding);
			switch (response.stopReason) {
				case "cancelled":
					throw abortError();
				case "max_tokens":
				case "max_turn_requests":
					activeWriter.done("length");
					break;
				default:
					activeWriter.done("stop");
			}
		} catch (error) {
			binding.writer?.fail(error, isAbort(error));
			if (isAbort(error) || binding.abortRequested) abortTurn(binding);
			// A lost session keeps its saved record; the next turn restores it on another process.
			if (binding.connection.isSessionLost(binding.session.sessionId) || !binding.connection.process.alive) {
				await this.dropBinding(key, binding);
			}
			throw error;
		} finally {
			if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
			completeTurn?.();
			binding.turnCompletion = undefined;
			binding.abortRequested = false;
			binding.writer = undefined;
			this.touch(binding);
			release();
			if (this.queues.get(key) === queue) this.queues.delete(key);
			if (!persistent) await this.dropBinding(key, binding);
		}
	}

	private async awaitContinuation(binding: Binding, signal?: AbortSignal): Promise<void> {
		const completion = binding.turnCompletion;
		if (!completion) return;
		if (!signal) {
			await completion;
			return;
		}
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		const abort = () => {
			if (binding.turnCompletion !== completion || binding.abortRequested) return;
			abortTurn(binding);
			void binding.connection.cancel(binding.session.sessionId).catch(() => undefined);
			killTimer = setTimeout(() => {
				if (binding.turnCompletion !== completion) return;
				if (binding.lease) binding.connection.abandonSession(binding.session.sessionId, abortError());
				else void binding.connection.close();
			}, 1_500);
		};
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		try {
			await completion;
		} finally {
			signal.removeEventListener("abort", abort);
			if (killTimer) clearTimeout(killTimer);
		}
	}

	private findContinuationKey(context: Context): string | undefined {
		for (const binding of this.resolvedBindings) {
			if (binding.permission && findPermissionResult(context, binding.permission.id)) return binding.key;
			if (
				binding.pendingTools.size > 0 &&
				[...binding.pendingTools.values()].every((pending) =>
					findToolResult(context, pending.invocation.id, pending.invocation.name),
				)
			) {
				return binding.key;
			}
		}
		return undefined;
	}

	private async getBinding(
		key: string,
		model: AntigravityModel,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: Context["tools"],
		signal?: AbortSignal,
	): Promise<Binding> {
		this.assertActive();
		const existing = this.bindings.get(key);
		if (existing) return existing;
		const created = this.createBinding(key, model, acpModelId, apiKey, writer, tools ?? [], signal).catch((error) => {
			if (this.bindings.get(key) === created) this.bindings.delete(key);
			throw error;
		});
		this.bindings.set(key, created);
		return created;
	}

	private async createBinding(
		key: string,
		model: AntigravityModel,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: NonNullable<Context["tools"]>,
		signal?: AbortSignal,
	): Promise<Binding> {
		const epoch = this.bindingEpoch;
		const eviction = this.evictForCap(key);
		// Reserved before the first await so parallel starts see each other at the cap.
		const slot = Symbol(key);
		this.startingBindings.add(slot);
		try {
			await eviction;
			this.assertEpoch(epoch);
			return await this.startBinding(key, model, acpModelId, apiKey, writer, tools, slot, signal);
		} finally {
			this.startingBindings.delete(slot);
		}
	}

	private async startBinding(
		key: string,
		model: AntigravityModel,
		acpModelId: string,
		apiKey: string | undefined,
		writer: PiEventWriter,
		tools: NonNullable<Context["tools"]>,
		slot: symbol,
		signal?: AbortSignal,
	): Promise<Binding> {
		const piSessionId = key.startsWith("sid:") ? key.slice(4) : undefined;
		const cwd = (piSessionId ? this.sessionCwds.get(piSessionId) : undefined) ?? process.cwd();
		let binding: Binding | undefined;
		let bridge: PiMcpBridge | undefined;
		const epoch = this.bindingEpoch;
		const handlers = {
			onUpdate: (notification: SessionNotification) => this.consumeUpdate(binding, notification),
			onPermission: (request: RequestPermissionRequest) => this.requestPermission(binding, request),
		};
		const saved = piSessionId ? this.sessionStore?.get(piSessionId) : undefined;
		const lease = this.pool
			? await this.pool.acquire(poolKey(apiKey), () => this.openShared(apiKey), signal,
				(candidate) => saved !== undefined && candidate.isSessionLost(saved.acpSessionId))
			: undefined;
		const connection = lease?.connection ?? this.createConnection({ cwd, handlers });
		try {
			this.assertEpoch(epoch);
			const initialize = lease?.initialize ?? await connection.initialize();
			this.assertEpoch(epoch);
			if (!lease) await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			const omittedTools = initialize.agentCapabilities?.mcpCapabilities?.http === true
				? planToolProjection(tools)
				: tools.filter((tool) => tool.name !== PERMISSION_TOOL_NAME).map((tool) => ({ name: tool.name, reason: "Agent did not advertise MCP over HTTP" }));
			let mcpServer;
			if (tools.length > 0 && initialize.agentCapabilities?.mcpCapabilities?.http === true) {
				bridge = new PiMcpBridge({
					tools,
					onCall: (invocation) => this.requestPiTool(binding, invocation),
					// Distinct per Pi session, so sessions sharing a process never share a server name.
					...(lease ? { serverName: `pi-bridge-${createHash("sha256").update(key).digest("hex").slice(0, 8)}` } : {}),
				});
				mcpServer = await bridge.start();
			}
			const mcpServers = mcpServer ? [mcpServer] : [];
			let session: AcpNewSessionResponse | undefined;
			let restored = false;
			const meta = sessionMeta(this.nativeTools, mcpServer?.name);
			// Antigravity persists the builtin filter per session and keeps it on resume, so a session
			// saved under another filter is replaced rather than restored.
			if (saved?.cwd === cwd && saved.nativeTools === nativeToolsKey(this.nativeTools)) {
				// Registered before restoring, so a load's history replay is not counted as unknown traffic.
				const unregister = lease?.register(saved.acpSessionId, handlers);
				if (initialize.agentCapabilities?.sessionCapabilities?.resume) {
					try {
						const resumed = await connection.resumeSession(saved.acpSessionId, cwd, mcpServers, signal, meta);
						session = { sessionId: saved.acpSessionId, ...resumed };
						restored = true;
					} catch {
						// Some Antigravity builds advertise the draft method before implementing it.
					}
				}
				if (!session && initialize.agentCapabilities?.loadSession === true) {
					try {
						const loaded = await connection.loadSession(saved.acpSessionId, cwd, mcpServers, signal, meta);
						session = { sessionId: saved.acpSessionId, ...loaded };
						restored = true;
					} catch {
						this.sessionStore?.remove(saved.piSessionId);
					}
				}
				if (!session) unregister?.();
			}
			if (!session) {
				session = await connection.newSession(cwd, signal, mcpServers, meta);
				lease?.register(session.sessionId, handlers);
			}
			this.assertEpoch(epoch);
			const mode = this.permissionMode;
			if (!supportsMode(session, mode)) {
				if (piSessionId) this.sessionStore?.remove(piSessionId);
				throw new AntigravityAcpError("protocol", `Antigravity ${restored ? "restored" : "new"} session did not advertise permission mode '${mode}'; refusing to prompt`);
			}
			if (sessionModes(session)?.currentModeId !== mode) await connection.setMode(session.sessionId, mode, signal);
			if (sessionModes(connection.getSessionState(session.sessionId))?.currentModeId !== mode) {
				throw new AntigravityAcpError("protocol", "Antigravity did not confirm the requested permission mode");
			}
			const currentModel = sessionModels(session)?.currentModelId;
			if (currentModel !== acpModelId) await connection.setModel(session.sessionId, acpModelId, signal);
			this.assertEpoch(epoch);
			if (mode !== this.permissionMode) throw new AntigravityAcpError("protocol", "Permission mode changed during session setup; retry the turn");
			const createdBinding: Binding = {
				key,
				cwd,
				connection,
				lease,
				initialize,
				session,
				mode,
				instructionsFingerprint: undefined,
				needsReconstruction: false,
				modelId: acpModelId,
				messageCount: restored && saved ? saved.messageCount : 0,
				historyFingerprint: restored && saved ? saved.historyFingerprint : messagesFingerprint([]),
				expectedAssistantFingerprint: restored ? saved?.expectedAssistantFingerprint : undefined,
				pendingContextCount: 0,
				pendingContextFingerprint: messagesFingerprint([]),
				writer,
				permission: undefined,
				pendingTools: new Map(),
				toolCalls: new Map(),
				contextUsed: undefined,
				inferences: 0,
				toolBatchTimer: undefined,
				bridge,
				toolFingerprint: piToolFingerprint(tools),
				omittedTools,
				turnCompletion: undefined,
				abortRequested: false,
				piSessionId,
				restored,
				lastActivity: Date.now(),
			};
			binding = createdBinding;
			this.persistBinding(createdBinding);
			this.startingBindings.delete(slot);
			this.resolvedBindings.add(createdBinding);
			void connection.process.exited.then(() => {
				cancelPermission(createdBinding);
				cancelPiTools(createdBinding, "Antigravity process exited before Pi returned the tool result");
				this.resolvedBindings.delete(createdBinding);
				void bridge?.close().catch(() => undefined);
				const current = this.bindings.get(key);
				if (current) void current.then((value) => {
					if (value === createdBinding && this.bindings.get(key) === current) this.bindings.delete(key);
				}).catch(() => undefined);
			}).catch(() => undefined);
			return createdBinding;
		} catch (error) {
			lease?.release();
			await Promise.allSettled([lease ? Promise.resolve() : connection.close(), bridge?.close() ?? Promise.resolve()]);
			throw error;
		}
	}

	private async openShared(apiKey: string | undefined): Promise<OpenedConnection> {
		// Each session's workspace travels on session/new|load|resume; the process cwd is only inherited.
		const connection = this.createConnection({ cwd: process.cwd(), sessionScopedFaults: true });
		try {
			const initialize = await connection.initialize();
			await authenticateForCredential(connection, initialize, apiKey);
			return { connection, initialize };
		} catch (error) {
			await connection.close();
			throw error;
		}
	}

	private persistBinding(binding: Binding): void {
		if (!binding.piSessionId) return;
		if (binding.needsReconstruction) { this.sessionStore?.remove(binding.piSessionId); return; }
		const nativeTools = nativeToolsKey(this.nativeTools);
		this.sessionStore?.save({
			piSessionId: binding.piSessionId,
			acpSessionId: binding.session.sessionId,
			acpModelId: binding.modelId,
			cwd: binding.cwd,
			messageCount: binding.messageCount,
			historyFingerprint: binding.historyFingerprint,
			...(binding.expectedAssistantFingerprint
				? { expectedAssistantFingerprint: binding.expectedAssistantFingerprint }
				: {}),
			...(nativeTools ? { nativeTools } : {}),
			lastActive: Date.now(),
		});
	}

	private requestPiTool(
		binding: Binding | undefined,
		invocation: PiToolInvocation,
	): Promise<CallToolResult> {
		if (!binding?.writer || binding.writer.finished || binding.permission || binding.abortRequested) {
			return Promise.resolve({
				content: [{ type: "text", text: "Pi cannot accept this tool call in the current turn" }],
				isError: true,
			});
		}
		return new Promise<CallToolResult>((resolve) => {
			let release: (() => void) | undefined;
			try {
				release = binding.connection.holdPromptWatchdog(binding.session.sessionId);
				const held = release;
				binding.pendingTools.set(invocation.id, { invocation, resolve: (result) => { held(); resolve(result); } });
				binding.writer?.toolCall(invocation.id, invocation.name, invocation.arguments);
				if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
				binding.toolBatchTimer = setTimeout(() => {
					binding.toolBatchTimer = undefined;
					binding.writer?.done("toolUse");
				}, TOOL_BATCH_MS);
				binding.toolBatchTimer.unref();
			} catch {
				binding.pendingTools.delete(invocation.id);
				release?.();
				resolve({ content: [{ type: "text", text: "Pi could not accept the tool call" }], isError: true });
			}
		});
	}

	private requestPermission(
		binding: Binding | undefined,
		request: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		if (!binding?.writer || binding.writer.finished || binding.permission || binding.abortRequested || request.sessionId !== binding.session.sessionId) {
			return Promise.resolve({ outcome: { outcome: "cancelled" } });
		}
		const id = crypto.randomUUID();
		return new Promise<RequestPermissionResponse>((resolve) => {
			const timer = setTimeout(() => {
				if (binding.permission?.id !== id) return;
				binding.permission = undefined;
				resolve({ outcome: { outcome: "cancelled" } });
			}, PERMISSION_TIMEOUT_MS);
			timer.unref();
			binding.permission = { id, request, resolve, timer };
			try {
				binding.writer?.toolCall(id, PERMISSION_TOOL_NAME, { requestId: id });
				binding.writer?.done("toolUse");
			} catch {
				clearTimeout(timer);
				if (binding.permission?.id === id) binding.permission = undefined;
				resolve({ outcome: { outcome: "cancelled" } });
			}
		});
	}

	private consumeUpdate(binding: Binding | undefined, notification: SessionNotification): void {
		if (!binding || notification.sessionId !== binding.session.sessionId) return;
		if ((notification.update.sessionUpdate === "config_option_update" || notification.update.sessionUpdate === "current_mode_update") &&
			this.confirmedMode(binding) !== this.permissionMode) {
			binding.writer?.fail(new AntigravityAcpError("protocol", "Antigravity changed the permission mode unexpectedly; session closed"), false);
			void this.invalidateBinding(binding).catch(() => undefined);
			return;
		}
		if (!binding.writer) return;
		for (const activity of mapSessionUpdate(notification, binding.toolCalls)) {
			if (activity.type === "text") binding.writer.text(activity.delta);
			else if (activity.type === "thought") binding.writer.thinking(activity.delta);
			else if (activity.type === "tool" || activity.type === "plan") binding.writer.thinking(activity.text);
			else if (activity.type === "usage") {
				binding.contextUsed = activity.used;
				binding.inferences += 1;
				if (!binding.writer.finished) binding.writer.message.usage.totalTokens = activity.used;
			}
		}
	}

	private async dropBinding(key: string, binding: Binding, removeSaved = false): Promise<void> {
		const current = this.bindings.get(key);
		if (current && (await current) === binding && this.bindings.get(key) === current) {
			if (removeSaved && binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);
			this.bindings.delete(key);
		}
		this.resolvedBindings.delete(binding);
		cancelPermission(binding);
		cancelPiTools(binding, "Antigravity session closed before Pi returned the tool result");
		await Promise.allSettled([this.closeBindingConnection(binding), binding.bridge?.close() ?? Promise.resolve()]);
	}

	/** A shared process outlives its bindings; a turn still running there is abandoned instead. */
	private async closeBindingConnection(binding: Binding): Promise<void> {
		if (!binding.lease) {
			await binding.connection.close();
			return;
		}
		if (binding.turnCompletion) binding.connection.abandonSession(binding.session.sessionId);
		binding.lease.release();
	}

	private confirmedMode(binding: Binding): string | undefined {
		return sessionModes(binding.connection.getSessionState(binding.session.sessionId))?.currentModeId;
	}

	private noteContinuationInstructions(binding: Binding, context: Context): void {
		if (binding.instructionsFingerprint !== instructionFingerprint(context)) {
			// ACP has no system-update RPC. Finish this immutable prompt, then rebuild;
			// do not persist a fingerprint claiming the new instructions reached ACP.
			binding.needsReconstruction = true;
			if (binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);
		}
	}

	private async invalidateBinding(binding: Binding): Promise<void> {
		if (binding.turnCompletion) abortTurn(binding);
		await this.dropBinding(binding.key, binding, true);
	}

	private createConnection(options: AntigravityConnectionOptions): AntigravityAcpConnection {
		this.assertActive();
		const connection = this.connectionFactory(options);
		this.activeConnections.add(connection);
		void connection.process.exited.then(() => this.activeConnections.delete(connection)).catch(() => undefined);
		return connection;
	}

	private assertEpoch(epoch: number): void {
		this.assertActive();
		if (epoch !== this.bindingEpoch) throw new AntigravityAcpError("process_exit", "Antigravity session was closed during setup");
	}

	private assertActive(): void {
		if (this.disposed) throw new AntigravityAcpError("process_exit", "Antigravity ACP runtime is closed");
	}
}

// One shared process per account: the managed login, or each API key.
function poolKey(apiKey: string | undefined): string {
	return !apiKey || apiKey === MANAGED_AUTH_MARKER ? "managed" : `key:${createHash("sha256").update(apiKey).digest("hex")}`;
}

async function authenticateForCredential(
	connection: AntigravityAcpConnection,
	initialize: InitializeResponse,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (!apiKey || apiKey === MANAGED_AUTH_MARKER) return;
	const method = initialize.authMethods?.find((candidate) => {
		const meta = candidate._meta as Record<string, unknown> | null | undefined;
		return "api-key" in (meta ?? {}) || /api key/iu.test(candidate.name);
	});
	if (!method) throw new AntigravityAcpError("auth", "Antigravity ACP did not advertise API-key authentication");
	await connection.authenticate({ methodId: method.id, _meta: { "api-key": apiKey } }, signal);
}

function adaptPromptToCapabilities(parts: PromptParts, initialize: InitializeResponse): PromptParts {
	const capabilities = initialize.agentCapabilities?.promptCapabilities;
	const output: ContentBlock[] = [];
	for (const block of parts.prompt) {
		if (block.type === "image" && capabilities?.image !== true) {
			throw new AntigravityAcpError("invalid_input", "This Antigravity ACP runtime did not advertise image input");
		}
		if (block.type === "resource" && capabilities?.embeddedContext !== true) {
			const resource = block.resource;
			if ("text" in resource) output.push({ type: "text", text: resource.text });
			continue;
		}
		output.push(block);
	}
	return { ...parts, prompt: output };
}

function hasUsableLocalAuth(health: AntigravityAuthHealth): boolean {
	return health.status === "api-key-env" || health.status === "oauth-refreshable";
}

// Antigravity keeps neither eager servers nor the output limit across resume, so both go on every setup.
function sessionMeta(nativeTools: NativeTools, eagerServer: string | undefined): Record<string, unknown> | undefined {
	const antigravity = {
		...(nativeTools === "all" ? {} : { enabledTools: nativeTools === "none" ? [] : nativeTools }),
		...(eagerServer ? { eagerMcpServers: [eagerServer], mcpMaxOutputBytes: MCP_MAX_OUTPUT_BYTES } : {}),
	};
	return Object.keys(antigravity).length > 0 ? { antigravity } : undefined;
}

// Saved sessions record the filter they were created under; undefined means every builtin.
function nativeToolsKey(nativeTools: NativeTools): string | undefined {
	return nativeTools === "all" ? undefined : JSON.stringify(nativeTools === "none" ? [] : nativeTools);
}

function supportsMode(session: SessionState, mode: PermissionMode): boolean {
	return sessionModes(session)?.availableModes.some((candidate) => candidate.id === mode) === true;
}

function permissionView(permission: PendingPermission): PermissionView {
	const call = permission.request.toolCall;
	const details = {
		kind: call.kind,
		locations: call.locations,
		content: call.content,
		rawInput: call.rawInput,
	};
	const visibleDetails = JSON.stringify(details, null, 2).slice(0, 8_000);
	return {
		id: permission.id,
		title: `${call.title ?? "Antigravity requests permission"}\n\n${visibleDetails}`,
		options: permission.request.options.map((option) => ({
			id: option.optionId,
			label: option.name,
			kind: option.kind,
		})),
	};
}

function findPermissionResult(context: Context, requestId: string): PermissionToolResult | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (
			message?.role !== "toolResult" ||
			message.toolName !== PERMISSION_TOOL_NAME ||
			message.toolCallId !== requestId
		) {
			continue;
		}
		const details = message.details as Partial<PermissionToolResult> | undefined;
		if (
			details?.kind === PERMISSION_RESULT_KIND &&
			details.requestId === requestId &&
			typeof details.cancelled === "boolean"
		) {
			return details as PermissionToolResult;
		}
		// A missing/disabled tool or malformed output is an immediate denial,
		// never an implicit approval and never a hung ACP request.
		return {
			kind: PERMISSION_RESULT_KIND,
			requestId,
			cancelled: true,
		};
	}
	return undefined;
}

function messagesFingerprint(messages: Context["messages"]): string {
	const fingerprints = messages.map(messageFingerprint);
	return createHash("sha256").update(fingerprints.join("\n")).digest("hex");
}

function messageFingerprint(message: Context["messages"][number]): string {
	let value: unknown;
	if (message.role === "user") {
		value = { role: message.role, content: message.content };
	} else if (message.role === "assistant") {
		value = {
			role: message.role,
			provider: message.provider,
			model: message.model,
			content: message.content,
		};
	} else if (message.role === "system") {
		value = {
			role: message.role,
			content: message.content,
			sections: message.sections,
			toolsAdded: message.toolsAdded,
			toolsRemoved: message.toolsRemoved,
		};
	} else {
		value = {
			role: message.role,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: message.content,
			isError: message.isError,
		};
	}
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function findToolResult(
	context: Context,
	toolCallId: string,
	toolName: string,
): ToolResultMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (
			message?.role === "toolResult" &&
			message.toolCallId === toolCallId &&
			message.toolName === toolName
		) {
			return message;
		}
	}
	return undefined;
}

function toMcpToolResult(message: ToolResultMessage): CallToolResult {
	return {
		content: message.content.map((block) =>
			block.type === "text"
				? { type: "text" as const, text: block.text }
				: { type: "image" as const, data: block.data, mimeType: block.mimeType },
		),
		isError: message.isError,
	};
}

function cancelPermission(binding: Binding): void {
	if (!binding.permission) return;
	clearTimeout(binding.permission.timer);
	binding.permission.resolve({ outcome: { outcome: "cancelled" } });
	binding.permission = undefined;
}

function instructionFingerprint(context: Context): string {
	return createHash("sha256").update(currentSystemInstructions(context)).digest("hex");
}

function abortTurn(binding: Binding): void {
	binding.abortRequested = true;
	cancelPermission(binding);
	cancelPiTools(binding, "Pi turn was aborted before returning the tool result");
}

function cancelPiTools(binding: Binding, reason: string): void {
	if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
	binding.toolBatchTimer = undefined;
	for (const pending of binding.pendingTools.values()) {
		pending.resolve({ content: [{ type: "text", text: reason }], isError: true });
	}
	binding.pendingTools.clear();
}

async function raceAuthentication<T>(
	step: Promise<T>,
	authentication: Promise<void>,
): Promise<{ authenticated: true } | { authenticated: false; value: T }> {
	return Promise.race([
		step.then((value) => ({ authenticated: false as const, value })),
		authentication.then(() => ({ authenticated: true as const })),
	]);
}

function isAbort(error: unknown): boolean {
	return error instanceof AntigravityAcpError
		? error.code === "aborted"
		: error instanceof DOMException && error.name === "AbortError";
}
