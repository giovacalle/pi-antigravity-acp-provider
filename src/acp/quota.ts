const UNIT_MS: Record<string, number> = { day: 86_400_000, hour: 3_600_000, minute: 60_000, second: 1_000 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// agy replies with this fixed notice, without usage, when the account's quota is exhausted.
const NOTICE = new RegExp(
	"(?:^|\\n)Usage Limit Reached\\n\\nYou have reached your current quota for this period\\." +
		"(?: Your limit will reset (?:in ((?:\\d+ (?:day|hour|minute|second)s?(?:, )?)+)" +
		`|on (${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}) (\\d{2}):(\\d{2}) UTC)\\.)?$`,
	"u",
);

export function quotaExhaustion(text: string, now = Date.now()): { resetAt?: string } | undefined {
	const match = NOTICE.exec(text.trim());
	if (!match) return undefined;
	const [, relative, month, day, year, hours, minutes] = match;
	if (relative) {
		let ms = 0;
		for (const [, count, unit] of relative.matchAll(/(\d+) (day|hour|minute|second)/gu)) ms += Number(count) * UNIT_MS[unit!]!;
		return { resetAt: new Date(now + ms).toISOString() };
	}
	if (month) return { resetAt: new Date(Date.UTC(Number(year), MONTHS.indexOf(month), Number(day), Number(hours), Number(minutes))).toISOString() };
	return {};
}

/** agy retries a model-path 429 forever, logging only to stderr: no update and no reply.
 * Tolerate this many retries per inference before failing the prompt. */
export const RESOURCE_EXHAUSTED_MAX_RETRIES = 2;
/** Total retry delay agy may announce per inference before failing. Bounded by announced delays, not wall
 * clock: agy logs nothing once a retry succeeds, so silence cannot tell recovery from a hang. */
export const RESOURCE_EXHAUSTED_GRACE_MS = 15_000;
const API_ERROR = /\bError \d{3}, Message: /u;
const EXHAUSTED = /\bError 429, Message: .*, Status: RESOURCE_EXHAUSTED\b/u;
const RETRY = /\bEncountered retryable api error\. retrying in ((?:\d{1,6}(?:\.\d{1,6})?(?:h|ms|m|s|us|µs|ns))+)/u;
const DURATION_MS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1, us: 1e-3, "µs": 1e-3, ns: 1e-6 };

/** Counts 429 RESOURCE_EXHAUSTED retries from agy's stderr; only a retry that follows the
 * exact 429 error counts, so prompt text, model names and other retryable errors do not. */
export class ResourceExhaustionTracker {
	private exhausted = false;
	private retries = 0;
	private nextDelayMs = 0;
	private waitedMs = 0;
	private done = false;

	constructor(private readonly onExhausted: (message: string) => void) {}

	noteStderrLine(line: string): void {
		if (this.done) return;
		// Each retry follows its own error line; another API error supersedes a 429.
		if (API_ERROR.test(line)) this.exhausted = EXHAUSTED.test(line);
		const retry = RETRY.exec(line);
		if (!retry || !this.exhausted) return;
		this.exhausted = false;
		this.retries += 1;
		this.nextDelayMs = 0;
		for (const [, count, unit] of retry[1]!.matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s|us|µs|ns)/gu)) {
			this.nextDelayMs += Number(count) * DURATION_MS[unit!]!;
		}
		this.waitedMs += this.nextDelayMs;
		if (this.retries > RESOURCE_EXHAUSTED_MAX_RETRIES || this.waitedMs > RESOURCE_EXHAUSTED_GRACE_MS) this.fire();
	}

	/** The model answered: earlier retries recovered. */
	noteProgress(): void {
		if (this.done) return;
		this.exhausted = false;
		this.retries = 0;
		this.waitedMs = 0;
	}

	dispose(): void {
		this.done = true;
	}

	private fire(): void {
		this.dispose();
		const times = this.retries === 1 ? "time" : "times";
		// "quota exceeded" makes Pi's isRetryableAssistantError return false despite "429" and "rate limit".
		this.onExhausted(
			"Antigravity quota exceeded: the model path refused requests with HTTP 429 RESOURCE_EXHAUSTED (rate limit or entitlement); " +
				`agy retried ${this.retries} ${times}, next retry in ${Number((this.nextDelayMs / 1_000).toFixed(2))}s, without a reply. ` +
				"Retry later or switch to another provider.",
		);
	}
}
