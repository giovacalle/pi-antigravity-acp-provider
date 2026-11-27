export type AntigravityAcpErrorCode =
	| "aborted"
	| "auth"
	| "model"
	| "protocol"
	| "quota"
	| "overflow"
	| "spawn"
	| "timeout"
	| "process_exit"
	| "invalid_input";

export class AntigravityAcpError extends Error {
	constructor(
		readonly code: AntigravityAcpErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AntigravityAcpError";
	}
}

export class AcpOperationTimeoutError extends AntigravityAcpError {
	constructor(readonly operation: string, timeoutMs: number, detail = "") {
		super("timeout", `Antigravity ACP ${operation} timed out after ${timeoutMs}ms${detail.trim() ? `: ${redact(detail.trim())}` : ""}`);
	}
}

export function abortError(message = "Antigravity ACP request aborted"): AntigravityAcpError {
	return new AntigravityAcpError("aborted", message);
}

export function errorMessage(cause: unknown): string {
	if (cause instanceof Error && cause.message) return redact(cause.message);
	return redact(String(cause));
}

export function redact(text: string): string {
	return text
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1<redacted>@")
		.replace(/(?:AIza|sk-|npm_|gh[opurs]_)[A-Za-z0-9_-]{12,}/gu, "<redacted>")
		.replace(/\b(?:ya29\.|1\/\/)[A-Za-z0-9._~+/-]{12,}/gu, "<redacted>")
		.replace(/((?:authorization|cookie|set-cookie)\s*[:=]\s*(?:(?:bearer|basic)\s+)?)[^\s,;]+/giu, "$1<redacted>")
		.replace(
			/((?:["']?(?:access_token|refresh_token|id_token|client_secret|api[-_]?key)["']?)\s*[:=]\s*["']?)[^"'\s,;&}]+/giu,
			"$1<redacted>",
		)
		.slice(0, 4_096);
}
