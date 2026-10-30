import {
	ClientSideConnection,
	PROTOCOL_VERSION,
	RequestError,
	type AuthenticateRequest,
	type InitializeResponse,
	type McpServer,
	type PromptRequest,
	type PromptResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";

import { PACKAGE_VERSION } from "../constants.js";
import { boundedNdjsonStream } from "./bounded-stream.js";
import { abortError, AntigravityAcpError, redact } from "./errors.js";
import { AntigravityProcess, type AntigravityProcessOptions } from "./process.js";
import { PromptWatchdog } from "./prompt-watchdog.js";
import {
	decodeSessionState,
	findSessionSelector,
	splitSessionModelId,
	type AcpNewSessionResponse,
	type SessionSelectorCategory,
	type SessionState,
} from "./session-state.js";
import { rememberSystemSkillTree, removeSystemSkillTree } from "./system-skills.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_LIVENESS_TIMEOUT_MS = 5_000;

export interface AntigravityConnectionHandlers {
	onUpdate?: (notification: SessionNotification) => void | Promise<void>;
	onPermission?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

export interface AntigravityConnectionOptions extends AntigravityProcessOptions {
	handlers?: AntigravityConnectionHandlers;
	initializeTimeoutMs?: number;
	operationTimeoutMs?: number;
	/** No inbound progress while the model is idle (default 10 minutes). */
	promptIdleTimeoutMs?: number;
	/** No inbound progress while a tool/permission is outstanding (default 60 minutes). */
	promptWorkIdleTimeoutMs?: number;
	maxFrameBytes?: number;
	/** Contain per-session faults (unacknowledged abort, prompt watchdog, session request
	 * timeout or abort) to that session instead of closing the process, which other
	 * sessions may share. A process that then fails a liveness check is still closed. */
	sessionScopedFaults?: boolean;
	livenessTimeoutMs?: number;
}

export class AntigravityAcpConnection {
	readonly process: AntigravityProcess;
	readonly initialized: Promise<InitializeResponse>;
	private readonly connection: ClientSideConnection;
	private readonly operationTimeoutMs: number;
	private readonly promptIdleTimeoutMs: number;
	private readonly promptWorkIdleTimeoutMs: number;
	private readonly watchdogs = new Map<string, PromptWatchdog>();
	private readonly protocolFailure: Promise<never>;
	private readonly processFailure: Promise<never>;
	/** Session creations, loads and resumes attempted here; agy keeps a harness for each until the process exits. */
	sessionSetups = 0;
	private readonly sessions = new Map<string, SessionState>();
	private readonly sessionCwds = new Map<string, string>();
	private readonly sessionScopedFaults: boolean;
	private readonly livenessTimeoutMs: number;
	private readonly lostSessions = new Set<string>();
	private readonly stalls = new Map<string, (error: Error) => void>();
	private livenessCheck: Promise<void> | undefined;
	private handlers: AntigravityConnectionHandlers;
	private closePromise?: Promise<void>;

	constructor(options: AntigravityConnectionOptions) {
		this.handlers = options.handlers ?? {};
		this.sessionScopedFaults = options.sessionScopedFaults ?? false;
		this.livenessTimeoutMs = options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS;
		this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
		this.promptIdleTimeoutMs = options.promptIdleTimeoutMs ?? 10 * 60_000;
		this.promptWorkIdleTimeoutMs = options.promptWorkIdleTimeoutMs ?? 60 * 60_000;
		// Validate before spawning a process, including programmatic timeout overrides.
		new PromptWatchdog(this.promptIdleTimeoutMs, this.promptWorkIdleTimeoutMs, () => undefined).dispose();
		this.process = new AntigravityProcess(options);
		let rejectProtocolFailure!: (error: Error) => void;
		this.protocolFailure = new Promise<never>((_resolve, reject) => {
			rejectProtocolFailure = reject;
		});
		// Keep the rejection observed even if output fails while no request is
		// active. Individual operations still race against the original promise.
		void this.protocolFailure.catch(() => undefined);
		this.processFailure = this.process.exited.then(({ code, signal, stderrTail }) => {
			const status = signal ? `signal ${signal}` : `code ${String(code)}`;
			const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : "";
			throw new AntigravityAcpError(
				"process_exit",
				`Antigravity ACP process exited with ${status}${detail}`,
			);
		});
		// Process exit is expected during close; observe it here while active
		// operations race against the original rejecting promise below.
		void this.processFailure.catch(() => undefined);
		const stream = boundedNdjsonStream(this.process.output, this.process.input, {
			...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
			onCompatibilityNoise: () => this.process.recordCompatibilityNoise(),
			onProtocolError: (error) => {
				rejectProtocolFailure(error);
				void this.process.close();
			},
			closeOnProtocolError: true,
		});
		this.connection = new ClientSideConnection(
			() => ({
				requestPermission: async (request) => {
					const release = this.watchdogs.get(request.sessionId)?.beginPermission();
					try {
						return (await this.handlers.onPermission?.(request)) ?? { outcome: { outcome: "cancelled" } };
					} finally {
						release?.();
					}
				},
				sessionUpdate: async (notification) => {
					this.watchdogs.get(notification.sessionId)?.noteUpdate(notification);
					if (notification.update.sessionUpdate === "config_option_update") {
						this.updateSessionState(notification.sessionId, notification.update);
					} else if (notification.update.sessionUpdate === "current_mode_update") {
						const state = this.getSessionState(notification.sessionId);
						if (state.modes) this.sessions.set(notification.sessionId, {
							...state, modes: { ...state.modes, currentModeId: notification.update.currentModeId },
						});
					}
					await this.handlers.onUpdate?.(notification);
				},
			}),
			stream,
		);
		this.initialized = this.withDeadline(
			this.connection.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: false, writeTextFile: false },
					terminal: false,
				},
				clientInfo: {
					name: "pi-antigravity-acp-provider",
					title: "Pi Antigravity ACP Provider",
					version: PACKAGE_VERSION,
				},
			}),
			options.initializeTimeoutMs ?? 30_000,
			"initialize",
		);
		// Initialization can outlive a cancelled catalog refresh.
		void this.initialized.catch(() => undefined);
	}

	setHandlers(handlers: AntigravityConnectionHandlers): void {
		this.handlers = handlers;
	}

	async initialize(signal?: AbortSignal): Promise<InitializeResponse> {
		const response = await this.withAbort(this.initialized, signal, true);
		if (response.protocolVersion !== PROTOCOL_VERSION) {
			await this.close();
			throw new AntigravityAcpError(
				"protocol",
				`Unsupported ACP protocol version ${String(response.protocolVersion)}`,
			);
		}
		return response;
	}

	async authenticate(
		request: AuthenticateRequest,
		signal?: AbortSignal,
		timeoutMs = 180_000,
	): Promise<void> {
		await this.initialize();
		await this.withAbort(
			this.withDeadline(this.connection.authenticate(request), timeoutMs, "authenticate"),
			signal,
			true,
		);
	}

	async newSession(
		cwd: string,
		signal?: AbortSignal,
		mcpServers: McpServer[] = [],
		meta?: Record<string, unknown>,
	): Promise<AcpNewSessionResponse> {
		this.sessionSetups += 1;
		await this.initialize();
		const response = await this.withSystemSkillCleanup(cwd, () => this.withAbort(
			this.withDeadline(
				this.connection.newSession({ cwd, mcpServers, ...(meta ? { _meta: meta } : {}) }),
				this.operationTimeoutMs,
				"session/new",
			),
			signal,
		));
		if (typeof response?.sessionId !== "string" || !response.sessionId) {
			throw new AntigravityAcpError("protocol", "Invalid ACP new-session response");
		}
		const session = { ...response, ...decodeSessionState(response) };
		this.sessions.set(session.sessionId, session);
		this.sessionCwds.set(session.sessionId, cwd);
		return session;
	}

	async loadSession(
		sessionId: string,
		cwd: string,
		mcpServers: McpServer[] = [],
		signal?: AbortSignal,
		meta?: Record<string, unknown>,
	): Promise<SessionState> {
		this.assertSessionUsable(sessionId);
		this.sessionSetups += 1;
		await this.initialize();
		const response = await this.withSystemSkillCleanup(cwd, () => this.withAbort(
			this.withDeadline(
				this.connection.loadSession({ sessionId, cwd, mcpServers, ...(meta ? { _meta: meta } : {}) }),
				this.operationTimeoutMs,
				"session/load",
			),
			signal,
		));
		this.sessionCwds.set(sessionId, cwd);
		return this.updateSessionState(sessionId, response);
	}

	async resumeSession(
		sessionId: string,
		cwd: string,
		mcpServers: McpServer[] = [],
		signal?: AbortSignal,
		meta?: Record<string, unknown>,
	): Promise<SessionState> {
		this.assertSessionUsable(sessionId);
		this.sessionSetups += 1;
		await this.initialize();
		const response = await this.withSystemSkillCleanup(cwd, () => this.withAbort(
			this.withDeadline(
				this.connection.resumeSession({ sessionId, cwd, mcpServers, ...(meta ? { _meta: meta } : {}) }),
				this.operationTimeoutMs,
				"session/resume",
			),
			signal,
		));
		this.sessionCwds.set(sessionId, cwd);
		return this.updateSessionState(sessionId, response);
	}

	async setModel(sessionId: string, modelId: string, signal?: AbortSignal): Promise<void> {
		await this.initializeForSession(signal);
		// Match the live selectors, not a fixed suffix list: future servers may
		// advertise levels such as `off`. Exact native model IDs take precedence.
		const state = this.getSessionState(sessionId);
		const split = splitSessionModelId(state, modelId);
		if (split) {
			const baseConfirmed = findSessionSelector(state, "model")?.currentValue === split.base ||
				await this.applySelector(sessionId, "model", split.base, signal);
			if (baseConfirmed) {
				// Changing the base may replace the effort selector. Require a fresh
				// confirmation; never report a partially applied selection as success.
				if (!await this.applySelector(sessionId, "thought_level", split.effort, signal)) {
					throw new AntigravityAcpError("protocol", "Antigravity did not confirm the requested thought_level selection");
				}
				if (findSessionSelector(this.getSessionState(sessionId), "model")?.currentValue !== split.base) {
					throw new AntigravityAcpError("protocol", "Antigravity changed the model during thought_level selection");
				}
				return;
			}
		}
		if (await this.applySelector(sessionId, "model", modelId, signal)) return;
		// Older official Antigravity builds still implement this removed draft
		// method. Preserve its classified auth/transport errors and their causes.
		await this.withAbort(
			this.withDeadline(
				this.connection.request("session/set_model", { sessionId, modelId }),
				this.operationTimeoutMs,
				"session/set_model",
			),
			signal,
		);
	}

	async setMode(sessionId: string, modeId: string, signal?: AbortSignal): Promise<void> {
		await this.initializeForSession(signal);
		if (await this.setSelector(sessionId, "mode", modeId, signal)) return;
		await this.withAbort(
			this.withDeadline(
				this.connection.setSessionMode({ sessionId, modeId }),
				this.operationTimeoutMs,
				"session/set_mode",
			),
			signal,
		);
		const state = this.getSessionState(sessionId);
		if (state.modes) this.sessions.set(sessionId, { ...state, modes: { ...state.modes, currentModeId: modeId } });
	}

	getSessionState(sessionId: string): SessionState {
		return this.sessions.get(sessionId) ?? {};
	}

	/** A parked Pi tool gets the bounded work-inactivity window, not an absolute deadline. */
	holdPromptWatchdog(sessionId: string): () => void {
		return this.watchdogs.get(sessionId)?.hold() ?? (() => undefined);
	}

	isSessionLost(sessionId: string): boolean {
		return this.lostSessions.has(sessionId);
	}

	/** Give up on a session whose turn may still run inside agy: fail its in-flight
	 * prompt, refuse any later prompt or restore of it on this process, and close the
	 * process only if it no longer answers. Restore it only on another process: agy
	 * rejects a second turn while the abandoned one may still run. */
	abandonSession(
		sessionId: string,
		error: Error = new AntigravityAcpError("session_lost", "Antigravity ACP session was abandoned after a fault"),
	): void {
		this.lostSessions.add(sessionId);
		this.stalls.get(sessionId)?.(error);
		void this.cancel(sessionId).catch(() => undefined);
		this.checkLiveness();
	}

	async prompt(request: PromptRequest, signal?: AbortSignal): Promise<PromptResponse> {
		if (signal?.aborted) throw abortError();
		this.assertSessionUsable(request.sessionId);
		const cwd = this.sessionCwds.get(request.sessionId);
		const pending = this.withProgressWatchdog(request).finally(() => {
			if (cwd) removeSystemSkillTree(cwd);
		});
		if (!signal) return pending;

		return new Promise<PromptResponse>((resolve, reject) => {
			let settled = false;
			let aborting = false;
			let cancelTimer: ReturnType<typeof setTimeout> | undefined;
			const finish = (callback: () => void) => {
				if (settled) return;
				settled = true;
				if (cancelTimer) clearTimeout(cancelTimer);
				signal.removeEventListener("abort", onAbort);
				callback();
			};
			const onAbort = () => {
				if (aborting) return;
				aborting = true;
				void this.cancel(request.sessionId).catch(() => undefined);
				cancelTimer = setTimeout(() => {
					if (this.sessionScopedFaults) {
						this.abandonSession(request.sessionId);
						finish(() => reject(abortError()));
						return;
					}
					void this.close().finally(() => finish(() => reject(abortError())));
				}, 1_500);
			};
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			pending.then(
				(value) => {
					if (aborting) finish(() => reject(abortError()));
					else finish(() => resolve(value));
				},
				(error: unknown) => finish(() => reject(aborting ? abortError() : error)),
			);
		});
	}

	async cancel(sessionId: string): Promise<void> {
		await this.connection.cancel({ sessionId });
	}

	async close(): Promise<void> {
		this.closePromise ??= this.process.close().finally(() => {
			for (const cwd of new Set(this.sessionCwds.values())) removeSystemSkillTree(cwd);
		});
		await this.closePromise;
	}

	/** With scoped faults, a cancelled session call must not close a process that
	 * other sessions may share, so it gives up before sending anything instead. */
	private async initializeForSession(signal?: AbortSignal): Promise<void> {
		await this.initialize(this.sessionScopedFaults ? undefined : signal);
		if (signal?.aborted) throw abortError();
	}

	private assertSessionUsable(sessionId: string): void {
		if (this.lostSessions.has(sessionId)) {
			throw new AntigravityAcpError("session_lost", "Antigravity ACP session was abandoned after a fault; restore it on another process or start a new one");
		}
	}

	/** Single-flight. agy answers `session/cancel` sent as a request with a
	 * method-not-found error at once; any response proves the process still serves. */
	private checkLiveness(): void {
		if (this.livenessCheck || this.closePromise) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		this.livenessCheck = Promise.race([
			this.connection.request("session/cancel", { sessionId: "liveness" }).then(() => undefined, () => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					void this.close().catch(() => undefined);
					resolve();
				}, this.livenessTimeoutMs);
				timer.unref?.();
			}),
		]).finally(() => {
			clearTimeout(timer);
			this.livenessCheck = undefined;
		});
	}

	private async withSystemSkillCleanup<T>(cwd: string, setup: () => Promise<T>): Promise<T> {
		rememberSystemSkillTree(cwd);
		try {
			return await setup();
		} finally {
			removeSystemSkillTree(cwd);
		}
	}

	private updateSessionState(sessionId: string, response: unknown): SessionState {
		const state = { ...this.sessions.get(sessionId), ...decodeSessionState(response) };
		this.sessions.set(sessionId, state);
		return state;
	}

	private async setSelector(
		sessionId: string,
		category: SessionSelectorCategory,
		value: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (!findSessionSelector(this.getSessionState(sessionId), category)) return false;
		if (await this.applySelector(sessionId, category, value, signal)) return true;
		throw new AntigravityAcpError("protocol", `Antigravity did not confirm the requested ${category} selection`);
	}

	/** A silent mismatch permits model selection to try the legacy method.
	 * Real request failures must propagate without being treated as mismatches. */
	private async applySelector(
		sessionId: string,
		category: SessionSelectorCategory,
		value: string,
		signal?: AbortSignal,
	): Promise<boolean> {
		const selector = findSessionSelector(this.sessions.get(sessionId) ?? {}, category);
		if (!selector) return false;
		const response = await this.withAbort(
			this.withDeadline(
				this.connection.setSessionConfigOption({ sessionId, configId: selector.id, value }),
				this.operationTimeoutMs,
				"session/set_config_option",
			),
			signal,
		);
		const state = this.updateSessionState(sessionId, response);
		return findSessionSelector(state, category)?.currentValue === value;
	}

	private async withAbort<T>(promise: Promise<T>, signal?: AbortSignal, processLevel = false): Promise<T> {
		// The operation has already started. Observe it before any cancellation
		// branch closes the transport, even when we will not await its result.
		void promise.catch(() => undefined);
		if (!signal) return promise;
		const closes = processLevel || !this.sessionScopedFaults;
		if (signal.aborted) {
			if (closes) await this.close();
			throw abortError();
		}
		return new Promise<T>((resolve, reject) => {
			const abort = () => {
				if (closes) void this.close();
				reject(abortError());
			};
			signal.addEventListener("abort", abort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", abort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", abort);
					reject(classifyError(error));
				},
			);
		});
	}

	private async withProgressWatchdog(request: PromptRequest): Promise<PromptResponse> {
		if (this.watchdogs.has(request.sessionId)) {
			throw new AntigravityAcpError("invalid_input", "An ACP prompt is already running for this session");
		}
		let rejectStall!: (error: Error) => void;
		const stalled = new Promise<never>((_resolve, reject) => { rejectStall = reject; });
		const watchdog = new PromptWatchdog(this.promptIdleTimeoutMs, this.promptWorkIdleTimeoutMs, (busy, ms) => {
			const error = new AntigravityAcpError("timeout",
				`Antigravity ACP session/prompt timed out: no ${busy ? "tool/permission " : ""}progress for ${ms}ms`);
			if (this.sessionScopedFaults) {
				this.abandonSession(request.sessionId, error);
				return;
			}
			rejectStall(error);
			void this.close().catch(() => undefined);
		});
		this.watchdogs.set(request.sessionId, watchdog);
		this.stalls.set(request.sessionId, rejectStall);
		watchdog.arm();
		try {
			return await Promise.race([
				this.connection.prompt(request).catch((error: unknown) => { throw classifyError(error); }),
				this.protocolFailure, this.processFailure, stalled,
			]);
		} finally {
			watchdog.dispose();
			this.watchdogs.delete(request.sessionId);
			this.stalls.delete(request.sessionId);
		}
	}

	private async withDeadline<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				promise.catch((error: unknown) => {
					throw classifyError(error);
				}),
				this.protocolFailure,
				this.processFailure,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						if (this.sessionScopedFaults && phase !== "initialize" && phase !== "authenticate") this.checkLiveness();
						else void this.close();
						reject(new AntigravityAcpError("timeout", `Antigravity ACP ${phase} timed out after ${timeoutMs}ms`));
					}, timeoutMs);
					timer.unref?.();
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
}

function classifyError(error: unknown): Error {
	if (error instanceof AntigravityAcpError) return error;
	const structured =
		error instanceof RequestError
			? error
			: error &&
				  typeof error === "object" &&
				  typeof (error as { code?: unknown }).code === "number" &&
				  typeof (error as { message?: unknown }).message === "string"
				? (error as { code: number; message: string; data?: unknown })
				: undefined;
	if (structured) {
		const detail = structuredErrorDetail(structured.data);
		const message = detail ? `${structured.message}: ${detail}` : structured.message;
		if (structured.code === -32000) {
			return new AntigravityAcpError("auth", `Antigravity authentication required: ${message}`, {
				cause: error,
			});
		}
		return new AntigravityAcpError("protocol", `Antigravity ACP error ${structured.code}: ${message}`, {
			cause: error,
		});
	}
	return error instanceof Error ? error : new Error(String(error));
}

function structuredErrorDetail(data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined;
	const detail = (data as { details?: unknown }).details;
	return typeof detail === "string" && detail.trim() ? redact(detail.trim()) : undefined;
}
