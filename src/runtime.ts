import type {
	ContentBlock,
	InitializeResponse,
	RequestPermissionRequest,
	RequestPermissionResponse,
	SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
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
	removeConversation,
	type AntigravityAuthHealth,
} from "./acp/antigravity.js";
import { AntigravityAcpConnection, type AntigravityConnectionOptions } from "./acp/connection.js";
import { providerAcpDirectory, providerAcpEnvironment } from "./acp/credential-storage.js";
import { abortError, AntigravityAcpError, errorMessage } from "./acp/errors.js";
import { contextOverflow, quotaExhaustion } from "./acp/quota.js";
import { confirmsPermissionMode, permissionModeId, unsupportedPermissionMode } from "./acp/permission-policy.js";
import { canonicalJson } from "./acp/runtime-manifest.js";
import { AcpSessionStore } from "./acp/session-store.js";
import { sessionModels, sessionModes, type AcpModelInfo, type AcpNewSessionResponse } from "./acp/session-state.js";
import { parseUsageQuota, type AntigravityQuotaSnapshot } from "./acp/usage-quota.js";
import {
	DEFAULT_BINDING_IDLE_MS,
	DEFAULT_MAX_BINDINGS,
	PERMISSION_RESULT_KIND,
	PERMISSION_TOOL_NAME,
} from "./constants.js";
export { MANAGED_AUTH_MARKER, PERMISSION_RESULT_KIND, PERMISSION_TOOL_NAME } from "./constants.js";
import { mapSessionUpdate } from "./acp/events.js";
import { credentialIdentity, hasSavedGoogleLogin, isGoogleLoginMarker } from "./auth.js";
import { ensureAntigravityAcpReady } from "./acp/setup.js";
import { HeadlessOAuthRelay, shouldUseHeadlessOAuth } from "./acp/headless-oauth.js";
import {
	PiMcpBridge,
	piToolFingerprint,
	planToolProjection,
	type ToolOmission,
	type PiToolInvocation,
} from "./mcp/bridge.js";
import { resolveUtilityCwd, type PermissionMode, type ToolActivityMode } from "./config.js";
import { resolveAcpModelId } from "./models.js";
import { type PromptParts, buildPromptParts, currentSystemInstructions } from "./stream/context.js";
import { PiEventWriter } from "./stream/pi-events.js";
import { usageFromPrompt } from "./stream/usage.js";
import { RuntimeMetrics } from "./status.js";

const PERMISSION_TIMEOUT_MS = 120_000;
const TOOL_BATCH_MS = 100;
const QUOTA_CACHE_MS = 60_000;
const QUOTA_TIMEOUT_MS = 30_000;

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
	credentialId: string;
	cwd: string;
	connection: AntigravityAcpConnection;
	initialize: InitializeResponse;
	session: AcpNewSessionResponse;
	mode: PermissionMode;
	modeId: string;
	pendingMode?: { mode: PermissionMode; modeId: string } | undefined;
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
	lastUsedAt: number;
	lastUsedSeq: number;
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

export interface AntigravityRuntimeOptions {
	maxBindings?: number;
	idleMs?: number;
	toolActivityMode?: ToolActivityMode;
}

export interface RuntimeSnapshot {
	bindings: number;
	permissionMode: PermissionMode;
	toolActivityMode: ToolActivityMode;
	metrics: ReturnType<RuntimeMetrics["snapshot"]>;
	processes: Array<{
		key: string;
		pid?: number;
		generation: number;
		sessionId: string;
		modelId: string;
		confirmedPermissionMode: PermissionMode;
		confirmedAcpModeId: string;
		omittedTools: ToolOmission[];
		alive: boolean;
		waitingForPermission: boolean;
		waitingForTools: number;
		agentVersion: string | undefined;
		mcpHttp: boolean;
		restored: boolean;
		ignoredStdoutNoiseLines: number;
		stderrTail?: string;
		diagnosticsPath?: string;
	}>;
}

export type AntigravityConnectionFactory = (options: AntigravityConnectionOptions) => AntigravityAcpConnection;

export class AntigravityRuntime {
	private readonly bindings = new Map<string, Promise<Binding>>();
	private readonly resolvedBindings = new Set<Binding>();
	private readonly bindingPromises = new WeakMap<Binding, Promise<Binding>>();
	private disposed = false;
	private closePromise: Promise<void> | undefined;
	private logoutInFlight: Promise<void> | undefined;
	private bindingEpoch = 0;
	private readonly sessionEpochs = new Map<string, number>();
	private readonly busyKeys = new Map<string, number>();
	private readonly activeConnections = new Set<AntigravityAcpConnection>();
	private readonly queues = new Map<string, Promise<void>>();
	private modeChanges = Promise.resolve();
	private evictionQueue: Promise<void> = Promise.resolve();
	private idleCleanupTimer: ReturnType<typeof setInterval> | undefined;
	private usageSeq = 0;

	private readonly connectionFactory: AntigravityConnectionFactory;
	private readonly ensureAgent: boolean;
	private readonly sessionStore: AcpSessionStore | undefined;
	private readonly maxBindings: number;
	private readonly idleMs: number;
	private readonly metrics = new RuntimeMetrics();
	private permissionMode: PermissionMode;
	private toolActivityMode: ToolActivityMode;
	private quotaCache: { credentialId: string; snapshot: AntigravityQuotaSnapshot } | undefined;
	private quotaInFlight: { epoch: number; credentialId: string; snapshot: Promise<AntigravityQuotaSnapshot> } | undefined;

	constructor(
		connectionFactory?: AntigravityConnectionFactory,
		permissionMode: PermissionMode = "yolo",
		sessionStore?: AcpSessionStore,
		options?: AntigravityRuntimeOptions,
	) {
		this.connectionFactory = connectionFactory ?? ((connectionOptions) => new AntigravityAcpConnection(connectionOptions));
		this.ensureAgent = connectionFactory === undefined;
		this.permissionMode = permissionMode;
		this.toolActivityMode = options?.toolActivityMode ?? "compact";
		this.sessionStore = sessionStore ?? (this.ensureAgent ? new AcpSessionStore() : undefined);
		this.maxBindings = positiveInt(options?.maxBindings ?? process.env.PI_ANTIGRAVITY_MAX_BINDINGS, DEFAULT_MAX_BINDINGS, 1);
		this.idleMs = positiveInt(options?.idleMs ?? process.env.PI_ANTIGRAVITY_BINDING_IDLE_MS, DEFAULT_BINDING_IDLE_MS, 1);
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
			if (options.signal?.aborted) throw abortError();
			writer.start();
			void this.runQueued(model, resolvedContext, options, writer)
				.then(() => {
					if (!writer.finished) {
						writer.fail(
							new AntigravityAcpError("protocol", "Antigravity ACP stream ended without completing the response"),
							options.signal?.aborted === true,
						);
					}
				})
				.catch((error: unknown) => {
					writer.fail(error, options.signal?.aborted === true || isAbort(error));
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
		const cwd = resolveUtilityCwd();
		const connection = this.createConnection({ cwd }, apiKey);
		try {
			const initialize = await connection.initialize(signal);
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			const session = await connection.newSession(cwd, signal);
			this.assertEpoch(epoch);
			return sessionModels(session)?.availableModels ?? [];
		} finally {
			await connection.close();
		}
	}

	/** Live quota from agy's own `/usage`, which answers without model inference. */
	async quota(apiKey: string | undefined, signal?: AbortSignal): Promise<AntigravityQuotaSnapshot> {
		this.assertActive();
		if (signal?.aborted) throw abortError();
		const credentialId = credentialIdentity(apiKey);
		if (this.quotaCache?.credentialId === credentialId && Date.now() - this.quotaCache.snapshot.at < QUOTA_CACHE_MS) {
			return this.quotaCache.snapshot;
		}
		const epoch = this.bindingEpoch;
		if (this.quotaInFlight?.epoch !== epoch || this.quotaInFlight.credentialId !== credentialId) {
			const request = {
				epoch,
				credentialId,
				snapshot: this.fetchQuota(apiKey)
					.then((snapshot) => {
						if (this.bindingEpoch === epoch && this.quotaInFlight === request) this.quotaCache = { credentialId, snapshot };
						return snapshot;
					})
					.finally(() => { if (this.quotaInFlight === request) this.quotaInFlight = undefined; }),
			};
			this.quotaInFlight = request;
		}
		const shared = this.quotaInFlight.snapshot;
		if (!signal) return shared;
		// One caller's abort must not cancel the request other callers share.
		return new Promise((resolve, reject) => {
			const onAbort = () => reject(abortError());
			signal.addEventListener("abort", onAbort, { once: true });
			shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	}

	// A separate short-lived process, never a user's warm session, so `/usage` cannot race user turns.
	private async fetchQuota(apiKey: string | undefined): Promise<AntigravityQuotaSnapshot> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		if (this.ensureAgent) await ensureAntigravityAcpReady();
		this.assertEpoch(epoch);
		let sessionId: string | undefined;
		let text = "";
		const cwd = resolveUtilityCwd();
		const connection = this.createConnection({
			cwd,
			promptIdleTimeoutMs: QUOTA_TIMEOUT_MS,
			handlers: {
				onUpdate: ({ sessionId: id, update }) => {
					if (id === sessionId && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text;
				},
				onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
			},
		}, apiKey);
		try {
			const initialize = await connection.initialize();
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey);
			this.assertEpoch(epoch);
			sessionId = (await connection.newSession(cwd)).sessionId;
			this.assertEpoch(epoch);
			// agy answers a bare "/usage" text block itself: no model turn, no quota spent.
			await connection.prompt({ sessionId, prompt: [{ type: "text", text: "/usage" }] });
			return parseUsageQuota(text);
		} finally {
			await connection.close();
			// agy keeps no index and offers no delete RPC; remove the files only once the process is gone (close() can give up on a process that ignored SIGKILL).
			if (sessionId && !connection.process.alive) removeConversation(sessionId, providerAcpDirectory());
		}
	}

	async loginGoogle(
		signal?: AbortSignal,
		onProgress?: (message: string) => void,
		manualInteraction?: ManualGoogleLoginInteraction,
	): Promise<void> {
		this.assertActive();
		signal?.throwIfAborted();
		const epoch = this.bindingEpoch;
		const env = { ...process.env };
		delete env.GEMINI_API_KEY;
		const useManualOAuth = manualInteraction !== undefined && shouldUseHeadlessOAuth();
		const relay = useManualOAuth ? new HeadlessOAuthRelay(env) : undefined;
		let connection: AntigravityAcpConnection | undefined;
		try {
			if (this.ensureAgent) await ensureAntigravityAcpReady(onProgress);
			this.assertEpoch(epoch);
			signal?.throwIfAborted();
			// An explicit /login must not authenticate by silently reusing the old account.
			await this.logout();
			signal?.throwIfAborted();
			const loginEpoch = this.bindingEpoch;
			const cwd = resolveUtilityCwd();
			connection = this.createConnection({ cwd, env: relay?.env ?? env });
			const initialize = await connection.initialize(signal);
			this.assertEpoch(loginEpoch);
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
				if (!captured.authenticated) {
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
			this.assertEpoch(loginEpoch);
			await connection.newSession(cwd, signal);
			this.assertEpoch(loginEpoch);
			if (!hasSavedGoogleLogin()) {
				throw new AntigravityAcpError("auth", "Antigravity did not save a Google login for this Pi profile");
			}
		} finally {
			relay?.dispose();
			await connection?.close();
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
		const cwd = resolveUtilityCwd();
		const connection = this.createConnection({ cwd });
		try {
			const initialize = await connection.initialize();
			this.assertEpoch(epoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertEpoch(epoch);
			await connection.newSession(cwd, signal);
			this.assertEpoch(epoch);
		} finally {
			await connection.close();
		}
	}

	inspectLocalAuth(): AntigravityAuthHealth {
		return inspectAntigravityAuth(providerAcpDirectory());
	}

	logout(): Promise<void> {
		return this.logoutInFlight ??= this.resetAuthentication().finally(() => {
			this.logoutInFlight = undefined;
		});
	}

	private async resetAuthentication(): Promise<void> {
		this.quotaCache = undefined;
		await this.closeBindings();
		clearAntigravityCredentials(providerAcpDirectory());
		this.sessionStore?.clear();
	}

	setPermissionMode(mode: PermissionMode): Promise<void> {
		const change = this.modeChanges.then(async () => {
			this.assertActive();
			this.permissionMode = mode;
			await Promise.all([...this.resolvedBindings].map(async (binding) => {
				if (binding.mode === mode && this.confirmedMode(binding) === mode) return;
				// Never change policy under an executing turn or leave an unsupported session alive.
				const modeId = permissionModeId(binding.connection.getSessionState(binding.session.sessionId), mode);
				if (!binding.turnCompletion && modeId !== undefined) {
					binding.pendingMode = { mode, modeId };
					try {
						await binding.connection.setMode(binding.session.sessionId, modeId);
						if (this.resolvedBindings.has(binding) && confirmsPermissionMode(binding.connection.getSessionState(binding.session.sessionId), mode, modeId)) {
							binding.mode = mode;
							binding.modeId = modeId;
							return;
						}
					} catch { /* Close below; the next turn must negotiate again. */ }
					finally {
						if (binding.pendingMode?.mode === mode && binding.pendingMode.modeId === modeId) {
							binding.pendingMode = undefined;
						}
					}
				}
				await this.invalidateBinding(binding);
			}));
		});
		this.modeChanges = change.catch(() => undefined);
		return change;
	}

	setToolActivityMode(mode: ToolActivityMode): void {
		this.toolActivityMode = mode;
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
					confirmedAcpModeId: binding.modeId,
					omittedTools: binding.omittedTools,
					alive: binding.connection.process.alive,
					waitingForPermission: binding.permission !== undefined,
					waitingForTools: binding.pendingTools.size,
					agentVersion: binding.initialize.agentInfo?.version,
					mcpHttp: binding.initialize.agentCapabilities?.mcpCapabilities?.http === true,
					restored: binding.restored,
					ignoredStdoutNoiseLines: binding.connection.process.ignoredStdoutNoiseLines,
					...(includeStderr ? { stderrTail: binding.connection.process.stderrTail } : {}),
					...(binding.connection.diagnosticsPath ? { diagnosticsPath: binding.connection.diagnosticsPath } : {}),
				};
			}),
		);
		return {
			bindings: processes.length,
			permissionMode: this.permissionMode,
			toolActivityMode: this.toolActivityMode,
			metrics: this.metrics.snapshot(),
			processes,
		};
	}

	close(): Promise<void> {
		this.disposed = true;
		return this.closePromise ??= this.closeBindings();
	}

	/** Closes one Pi session's binding but keeps its saved record so a later turn can resume it. */
	async closeSession(piSessionId: string): Promise<void> {
		const key = `sid:${piSessionId}`;
		this.bumpSessionEpoch(key);
		this.queues.delete(key);
		const binding = await this.bindings.get(key)?.catch(() => undefined);
		if (!binding) return;
		const completion = binding.turnCompletion;
		if (completion) {
			abortTurn(binding);
			void binding.connection.cancel(binding.session.sessionId).catch(() => undefined);
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([completion, new Promise<void>((resolve) => {
				timer = setTimeout(resolve, 1_500);
				timer.unref?.();
			})]);
			clearTimeout(timer);
		}
		await this.dropBinding(key, binding, false);
	}

	private async closeBindings(): Promise<void> {
		this.bindingEpoch += 1;
		const pending = [...this.bindings.values()];
		this.bindings.clear();
		for (const binding of this.resolvedBindings) {
			cancelPermission(binding);
			cancelPiTools(binding, "Provider shut down before Pi returned the tool result");
		}
		this.resolvedBindings.clear();
		this.syncIdleCleanupTimer(true);
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
	): Promise<void> {
		this.assertActive();
		const epoch = this.bindingEpoch;
		// One-off requests (e.g. compaction summaries) never keep or save a session.
		const persistent = Boolean(options.sessionId) && options.cacheRetention !== "none";
		const key = persistent
			? `sid:${options.sessionId}`
			: (this.findContinuationKey(context) ?? `ephemeral:${crypto.randomUUID()}`);
		const sessionEpoch = this.sessionEpoch(key);
		this.retainBusyKey(key);
		try {
			if (this.ensureAgent) await ensureAntigravityAcpReady();
			await this.modeChanges;
			this.assertSessionEpoch(key, epoch, sessionEpoch);
			const tools = context.tools ?? [];
			const acpModelId = resolveAcpModelId(model, options.reasoning);
			let binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			await this.modeChanges;
			this.assertSessionEpoch(key, epoch, sessionEpoch);
			// Check before continuation early returns as well as before fresh prompts.
			if (binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode ||
				binding.toolFingerprint !== piToolFingerprint(tools)) {
				await this.invalidateBinding(binding);
				this.assertSessionEpoch(key, epoch, sessionEpoch);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			} else if (isConnectionDead(binding.connection)) {
				await this.dropBinding(key, binding, false);
				this.assertSessionEpoch(key, epoch, sessionEpoch);
				binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
			}

			// Permission and Pi tool results resume the still-running ACP prompt rather than
			// starting a second Antigravity turn. One inference can raise a pi-bridge call and a
			// permission request together; Pi answers both in one continuation, so resolve both.
			if (!binding.turnCompletion) {
				if (binding.permission) cancelPermission(binding);
				if (binding.pendingTools.size > 0) cancelPiTools(binding, "Antigravity turn ended before Pi returned the tool result");
			}
			if (binding.permission || binding.pendingTools.size > 0) {
				const permission = binding.permission;
				const permissionResult = permission ? findPermissionResult(context, permission.id) : undefined;
				const results = [...binding.pendingTools.values()].map((pending) => ({
					pending,
					message: findToolResult(context, pending.invocation.id, pending.invocation.name),
				}));
				if ((permission && !permissionResult) || results.some((result) => result.message === undefined)) {
					cancelPermission(binding);
					cancelPiTools(binding, "Pi continued without returning every requested tool result");
					await this.dropBinding(key, binding);
					this.assertSessionEpoch(key, epoch, sessionEpoch);
					binding = await this.getBinding(key, model, acpModelId, options.apiKey, writer, tools, options.signal);
				} else {
					binding.writer = writer;
					this.touchBinding(binding);
					this.noteContinuationInstructions(binding, context);
					binding.pendingContextCount = context.messages.length;
					binding.pendingContextFingerprint = messagesFingerprint(context.messages);
					this.commitProgress(binding);
					for (const { pending, message } of results) {
						binding.pendingTools.delete(pending.invocation.id);
						pending.resolve(toMcpToolResult(message as ToolResultMessage));
					}
					if (permission && permissionResult) {
						binding.permission = undefined;
						clearTimeout(permission.timer);
						if (
							!permissionResult.cancelled &&
							permissionResult.optionId &&
							permission.request.options.some((option) => option.optionId === permissionResult.optionId)
						) {
							permission.resolve({ outcome: { outcome: "selected", optionId: permissionResult.optionId } });
						} else {
							permission.resolve({ outcome: { outcome: "cancelled" } });
						}
					}
					await this.awaitContinuation(binding, options.signal);
					if (!writer.finished) {
						writer.fail(
							new AntigravityAcpError("protocol", permission
								? "Antigravity ACP permission continuation ended without completing the response"
								: "Antigravity ACP tool continuation ended without completing the response"),
							options.signal?.aborted === true,
						);
					}
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
				this.assertSessionEpoch(key, epoch, sessionEpoch);
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
					this.assertSessionEpoch(key, epoch, sessionEpoch);
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
				this.assertSessionEpoch(key, epoch, sessionEpoch);
				if (binding.mode !== this.permissionMode || this.confirmedMode(binding) !== this.permissionMode) {
					await this.invalidateBinding(binding);
					throw new AntigravityAcpError("protocol", "Permission mode changed before prompting; retry the turn");
				}
				if (isConnectionDead(binding.connection)) {
					await this.dropBinding(key, binding, false);
					throw new AntigravityAcpError("process_exit", "Antigravity ACP connection closed before prompting");
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
				this.touchBinding(binding);
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
				const usage = usageFromPrompt(response, model);
				this.metrics.record(response, usage);
				// agy reports exhaustion and overflow as ordinary replies; fail them before the turn is persisted.
				const reply = activeWriter.message.content.map((block) => block.type === "text" ? block.text : "").join("");
				const quota = usage.totalTokens === 0 || response.stopReason === "refusal" ? quotaExhaustion(reply) : undefined;
				if (quota) {
					throw new AntigravityAcpError("quota",
						`Antigravity quota exceeded for ${binding.modelId}.${quota.resetAt ? ` Resets at ${quota.resetAt}.` : ""}`);
				}
				const overflow = contextOverflow(reply);
				if (overflow) throw new AntigravityAcpError("overflow", overflow);
				if (binding.contextUsed !== undefined) {
					// Pi checks input + cacheRead for silent overflow, not totalTokens. For multiple inferences,
					// only the latest context size is known, not its cache split; metrics above keep billed totals.
					// Legacy agy can count cache reads twice in `used`; ACP 1.5.0 does not. Correct only
					// a single inference whose reconciled prompt total proves that exact discrepancy.
					// Never subtract aggregate cache reads from a multi-inference context update.
					const contextUsed = binding.inferences === 1 && binding.contextUsed === usage.totalTokens + usage.cacheRead
						? usage.totalTokens
						: binding.contextUsed;
					activeWriter.message.usage = {
						...usage,
						input: binding.inferences > 1 ? binding.contextUsed : usage.input,
						cacheRead: binding.inferences > 1 ? 0 : usage.cacheRead,
						totalTokens: contextUsed,
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
				if ((binding.permission || binding.pendingTools.size > 0) && (binding.writer ?? writer).finished) {
					this.commitProgress(binding, (binding.writer ?? writer).message);
				}
				if (isAbort(error) || binding.abortRequested) abortTurn(binding);
				const refused = error instanceof AntigravityAcpError && (error.code === "quota" || error.code === "overflow");
				// Evict closing connections before failing the stream can wake a retry.
				if (!refused && isConnectionDead(binding.connection)) await this.dropBinding(key, binding);
				binding.writer?.fail(error, isAbort(error));
				// agy keeps a refused prompt in its session while Pi does not count it as seen, so a retry on that
				// session would append the unseen tail again; rebuild the next turn from Pi history instead.
				// Closing first would fail the stream with a generic error. A retry waits for this turn's queue.
				if (refused) await this.dropBinding(key, binding, true);
				throw error;
			} finally {
				if (onTurnAbort) options.signal?.removeEventListener("abort", onTurnAbort);
				// ACP can time out before Pi's tool finishes; replay late results in a new prompt, not a dead continuation.
				cancelPermission(binding);
				cancelPiTools(binding, "Antigravity prompt ended before Pi returned the tool result");
				completeTurn?.();
				binding.turnCompletion = undefined;
				binding.abortRequested = false;
				binding.writer = undefined;
				this.touchBinding(binding);
				release();
				if (this.queues.get(key) === queue) this.queues.delete(key);
				if (!persistent) await this.dropBinding(key, binding);
				else if (this.bindings.size > this.maxBindings) void this.evictForCapacity();
			}
		} finally {
			this.releaseBusyKey(key);
		}
	}

	private async awaitContinuation(binding: Binding, signal?: AbortSignal): Promise<void> {
		const completion = binding.turnCompletion;
		if (!completion) throw new AntigravityAcpError("protocol", "Antigravity prompt ended before Pi could continue");
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
				if (binding.turnCompletion === completion) void binding.connection.close();
			}, 1_500);
			killTimer.unref?.();
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
			if (!binding.turnCompletion) continue;
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
		const credentialId = credentialIdentity(apiKey);
		for (;;) {
			this.assertActive();
			const existing = this.bindings.get(key);
			if (!existing) break;
			const resolved = await existing;
			if (resolved.credentialId !== credentialId) {
				await this.invalidateBinding(resolved);
				continue;
			}
			if (!isConnectionDead(resolved.connection)) {
				this.touchBinding(resolved);
				return resolved;
			}
			await this.dropBinding(key, resolved, false);
		}
		let created!: Promise<Binding>;
		created = (async () => {
			await this.evictForCapacity();
			this.assertActive();
			return this.createBinding(key, model, acpModelId, apiKey, credentialId, writer, tools ?? [], created, signal);
		})().catch((error) => {
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
		credentialId: string,
		writer: PiEventWriter,
		tools: NonNullable<Context["tools"]>,
		entryPromise: Promise<Binding>,
		signal?: AbortSignal,
	): Promise<Binding> {
		const cwd = process.cwd();
		let binding: Binding | undefined;
		let bridge: PiMcpBridge | undefined;
		const epoch = this.bindingEpoch;
		const sessionEpoch = this.sessionEpoch(key);
		const connection = this.createConnection({
			cwd,
			handlers: {
				onUpdate: (notification) => this.consumeUpdate(binding, notification),
				onPermission: (request) => this.requestPermission(binding, request),
			},
		}, apiKey);
		try {
			const initialize = await connection.initialize(signal);
			this.assertSessionEpoch(key, epoch, sessionEpoch);
			await authenticateForCredential(connection, initialize, apiKey, signal);
			this.assertSessionEpoch(key, epoch, sessionEpoch);
			const omittedTools = initialize.agentCapabilities?.mcpCapabilities?.http === true
				? planToolProjection(tools)
				: tools.filter((tool) => tool.name !== PERMISSION_TOOL_NAME).map((tool) => ({ name: tool.name, reason: "Agent did not advertise MCP over HTTP" }));
			let mcpServer;
			if (tools.length > 0 && initialize.agentCapabilities?.mcpCapabilities?.http === true) {
				bridge = new PiMcpBridge({
					tools,
					onCall: (invocation) => this.requestPiTool(binding, invocation),
				});
				mcpServer = await bridge.start();
			}
			const mcpServers = mcpServer ? [mcpServer] : [];
			const piSessionId = key.startsWith("sid:") ? key.slice(4) : undefined;
			const saved = piSessionId ? this.sessionStore?.get(piSessionId) : undefined;
			let session: AcpNewSessionResponse | undefined;
			let restored = false;
			if (saved?.cwd === cwd && saved.credentialId === credentialId) {
				if (initialize.agentCapabilities?.sessionCapabilities?.resume) {
					try {
						const resumed = await connection.resumeSession(saved.acpSessionId, cwd, mcpServers, signal);
						session = { sessionId: saved.acpSessionId, ...resumed };
						restored = true;
					} catch {
						// Some Antigravity builds advertise the draft method before implementing it.
					}
				}
				if (!session && initialize.agentCapabilities?.loadSession === true) {
					try {
						const loaded = await connection.loadSession(saved.acpSessionId, cwd, mcpServers, signal);
						session = { sessionId: saved.acpSessionId, ...loaded };
						restored = true;
					} catch {
						this.sessionStore?.remove(saved.piSessionId);
					}
				}
			}
			session ??= await connection.newSession(cwd, signal, mcpServers);
			this.assertSessionEpoch(key, epoch, sessionEpoch);
			const mode = this.permissionMode;
			const modeId = permissionModeId(session, mode);
			if (modeId === undefined) {
				if (piSessionId) this.sessionStore?.remove(piSessionId);
				throw new AntigravityAcpError("protocol", `Antigravity ${restored ? "restored" : "new"} session ${unsupportedPermissionMode(session, mode)}`);
			}
			if (sessionModes(session)?.currentModeId !== modeId) await connection.setMode(session.sessionId, modeId, signal);
			if (!confirmsPermissionMode(connection.getSessionState(session.sessionId), mode, modeId)) {
				throw new AntigravityAcpError("protocol", "Antigravity did not confirm the requested permission mode");
			}
			const currentModel = sessionModels(session)?.currentModelId;
			if (currentModel !== acpModelId) await connection.setModel(session.sessionId, acpModelId, signal);
			this.assertSessionEpoch(key, epoch, sessionEpoch);
			if (mode !== this.permissionMode) throw new AntigravityAcpError("protocol", "Permission mode changed during session setup; retry the turn");
			const createdBinding: Binding = {
				key,
				credentialId,
				cwd,
				connection,
				initialize,
				session,
				mode,
				modeId,
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
				lastUsedAt: Date.now(),
				lastUsedSeq: ++this.usageSeq,
			};
			binding = createdBinding;
			this.bindingPromises.set(createdBinding, entryPromise);
			this.persistBinding(createdBinding);
			this.resolvedBindings.add(createdBinding);
			this.syncIdleCleanupTimer();
			void connection.process.exited.then(() => {
				cancelPermission(createdBinding);
				cancelPiTools(createdBinding, "Antigravity process exited before Pi returned the tool result");
				this.resolvedBindings.delete(createdBinding);
				this.syncIdleCleanupTimer();
				void bridge?.close().catch(() => undefined);
				if (this.bindings.get(key) === entryPromise) this.bindings.delete(key);
			}).catch(() => undefined);
			return createdBinding;
		} catch (error) {
			await Promise.allSettled([connection.close(), bridge?.close() ?? Promise.resolve()]);
			throw error;
		}
	}

	private commitProgress(binding: Binding, assistantMessage?: Context["messages"][number]): void {
		if (binding.pendingContextCount <= 0) return;
		binding.messageCount = binding.pendingContextCount;
		binding.historyFingerprint = binding.pendingContextFingerprint;
		binding.expectedAssistantFingerprint = assistantMessage ? messageFingerprint(assistantMessage) : undefined;
		this.persistBinding(binding);
	}

	private persistBinding(binding: Binding): void {
		if (!binding.piSessionId) return;
		if (binding.needsReconstruction) { this.sessionStore?.remove(binding.piSessionId); return; }
		this.sessionStore?.save({
			piSessionId: binding.piSessionId,
			acpSessionId: binding.session.sessionId,
			acpModelId: binding.modelId,
			credentialId: binding.credentialId,
			cwd: binding.cwd,
			messageCount: binding.messageCount,
			historyFingerprint: binding.historyFingerprint,
			...(binding.expectedAssistantFingerprint
				? { expectedAssistantFingerprint: binding.expectedAssistantFingerprint }
				: {}),
			lastActive: Date.now(),
		});
	}

	private requestPiTool(
		binding: Binding | undefined,
		invocation: PiToolInvocation,
	): Promise<CallToolResult> {
		const batchWriter = binding?.writer;
		if (!binding || !batchWriter || batchWriter.finished || binding.permission || binding.abortRequested) {
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
				// End the slice that received this call; by the time the timer fires Pi may already
				// be streaming the continuation through a newer writer.
				batchWriter.toolCall(invocation.id, invocation.name, invocation.arguments);
				if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
				const batchTimer = setTimeout(() => {
					if (binding.toolBatchTimer === batchTimer) binding.toolBatchTimer = undefined;
					batchWriter.done("toolUse");
				}, TOOL_BATCH_MS);
				binding.toolBatchTimer = batchTimer;
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
				// This ends the slice, including any Pi tool calls still in the batching window.
				if (binding.toolBatchTimer) clearTimeout(binding.toolBatchTimer);
				binding.toolBatchTimer = undefined;
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
		const expected = binding.pendingMode ?? { mode: binding.mode, modeId: binding.modeId };
		if ((notification.update.sessionUpdate === "config_option_update" || notification.update.sessionUpdate === "current_mode_update") &&
			this.confirmedMode(binding, expected) !== this.permissionMode) {
			binding.writer?.fail(new AntigravityAcpError("protocol", "Antigravity changed the permission mode unexpectedly; session closed"), false);
			void this.invalidateBinding(binding).catch(() => undefined);
			return;
		}
		if (!binding.writer) return;
		for (const activity of mapSessionUpdate(notification)) {
			if (activity.type === "text") binding.writer.text(activity.delta);
			else if (activity.type === "thought") binding.writer.thinking(activity.delta);
			else if (activity.type === "plan") binding.writer.thinking(activity.text);
			else if (activity.type === "tool") {
				if (this.toolActivityMode === "full") {
					binding.writer.thinking(activity.text);
				} else if (this.toolActivityMode === "compact" && !activity.isUpdate) {
					binding.writer.thinking(activity.compactText);
				}
			} else if (activity.type === "usage") {
				binding.contextUsed = activity.used;
				binding.inferences += 1;
				if (!binding.writer.finished) binding.writer.message.usage.totalTokens = activity.used;
			}
		}
	}

	private async dropBinding(key: string, binding: Binding, removeSaved = false): Promise<void> {
		this.resolvedBindings.delete(binding);
		this.syncIdleCleanupTimer();
		const entryPromise = this.bindingPromises.get(binding);
		const current = this.bindings.get(key);
		if (current && (entryPromise ? entryPromise === current : (await current.catch(() => undefined)) === binding && this.bindings.get(key) === current)) {
			if (removeSaved && binding.piSessionId) this.sessionStore?.remove(binding.piSessionId);
			this.bindings.delete(key);
		}
		cancelPermission(binding);
		cancelPiTools(binding, "Antigravity session closed before Pi returned the tool result");
		await Promise.allSettled([binding.connection.close(), binding.bridge?.close() ?? Promise.resolve()]);
	}

	private touchBinding(binding: Binding): void {
		binding.lastUsedAt = Date.now();
		binding.lastUsedSeq = ++this.usageSeq;
	}

	private isBindingIdle(binding: Binding): boolean {
		return (
			binding.turnCompletion === undefined &&
			binding.permission === undefined &&
			binding.pendingTools.size === 0 &&
			!this.queues.has(binding.key) &&
			(this.busyKeys.get(binding.key) ?? 0) === 0
		);
	}

	private syncIdleCleanupTimer(forceStop = false): void {
		if (forceStop || this.disposed || this.resolvedBindings.size === 0) {
			if (this.idleCleanupTimer) {
				clearInterval(this.idleCleanupTimer);
				this.idleCleanupTimer = undefined;
			}
			return;
		}
		if (this.idleCleanupTimer) return;
		const intervalMs = Math.max(10, Math.min(Math.floor(this.idleMs / 2), 30_000));
		this.idleCleanupTimer = setInterval(() => {
			void this.evictExpiredBindings();
		}, intervalMs);
		this.idleCleanupTimer.unref();
	}

	private runEviction(task: () => Promise<void>): Promise<void> {
		const next = this.evictionQueue.then(task, task);
		this.evictionQueue = next.catch(() => undefined);
		return next;
	}

	private evictExpiredBindings(): Promise<void> {
		return this.runEviction(async () => {
			if (this.disposed) return;
			const now = Date.now();
			const expired = [...this.resolvedBindings].filter(
				(binding) => this.isBindingIdle(binding) && now - binding.lastUsedAt >= this.idleMs,
			);
			await Promise.all(expired.map((binding) => this.dropBinding(binding.key, binding, false)));
		});
	}

	private evictForCapacity(): Promise<void> {
		return this.runEviction(async () => {
			if (this.disposed || this.bindings.size <= this.maxBindings) return;
			const excess = this.bindings.size - this.maxBindings;
			const candidates = [...this.resolvedBindings]
				.filter((binding) => this.isBindingIdle(binding))
				.sort((left, right) => left.lastUsedAt - right.lastUsedAt || left.lastUsedSeq - right.lastUsedSeq)
				.slice(0, excess);
			await Promise.all(candidates.map((binding) => this.dropBinding(binding.key, binding, false)));
		});
	}

	private confirmedMode(binding: Binding, expected = { mode: binding.mode, modeId: binding.modeId }): string | undefined {
		return confirmsPermissionMode(binding.connection.getSessionState(binding.session.sessionId), expected.mode, expected.modeId)
			? expected.mode : undefined;
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

	private createConnection(options: AntigravityConnectionOptions, apiKey?: string): AntigravityAcpConnection {
		this.assertActive();
		if (this.logoutInFlight) throw new AntigravityAcpError("auth", "Antigravity ACP logout is in progress");
		const env = providerAcpEnvironment(options.env);
		if (apiKey && isGoogleLoginMarker(apiKey)) delete env.GEMINI_API_KEY;
		const connection = this.connectionFactory({ ...options, env });
		this.activeConnections.add(connection);
		void connection.process.exited.then(() => this.activeConnections.delete(connection)).catch(() => undefined);
		return connection;
	}

	private sessionEpoch(key: string): number {
		return this.sessionEpochs.get(key) ?? 0;
	}

	private bumpSessionEpoch(key: string): void {
		this.sessionEpochs.set(key, this.sessionEpoch(key) + 1);
	}

	private retainBusyKey(key: string): void {
		this.busyKeys.set(key, (this.busyKeys.get(key) ?? 0) + 1);
	}

	private releaseBusyKey(key: string): void {
		const count = this.busyKeys.get(key) ?? 0;
		if (count <= 1) this.busyKeys.delete(key);
		else this.busyKeys.set(key, count - 1);
	}

	private assertSessionEpoch(key: string, epoch: number, sessionEpoch: number): void {
		this.assertEpoch(epoch);
		if (this.sessionEpoch(key) !== sessionEpoch) {
			throw new AntigravityAcpError("process_exit", "Antigravity session was closed during setup");
		}
	}

	private assertEpoch(epoch: number): void {
		this.assertActive();
		if (epoch !== this.bindingEpoch) throw new AntigravityAcpError("process_exit", "Antigravity session was closed during setup");
	}

	private assertActive(): void {
		if (this.disposed) throw new AntigravityAcpError("process_exit", "Antigravity ACP runtime is closed");
	}
}

function positiveInt(value: number | string | undefined, fallback: number, minimum = 1): number {
	if (value === undefined || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

async function authenticateForCredential(
	connection: AntigravityAcpConnection,
	initialize: InitializeResponse,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<void> {
	if (!apiKey || isGoogleLoginMarker(apiKey)) return;
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

function isConnectionDead(connection: AntigravityAcpConnection): boolean {
	return connection.closed === true || !connection.process.alive;
}

function isAbort(error: unknown): boolean {
	return error instanceof AntigravityAcpError
		? error.code === "aborted"
		: error instanceof DOMException && error.name === "AbortError";
}
