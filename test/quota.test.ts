import { afterEach, describe, expect, it, vi } from "vitest";
import { quotaExhaustion, ResourceExhaustionTracker } from "../src/acp/quota.js";

const now = Date.UTC(2026, 9, 30, 12, 0);
const notice = (reset = "") => `Usage Limit Reached\n\nYou have reached your current quota for this period.${reset}`;

describe("quotaExhaustion", () => {
	it("adds a relative reset to now", () => {
		expect(quotaExhaustion(notice(" Your limit will reset in 4 days, 23 hours."), now))
			.toEqual({ resetAt: new Date(now + 119 * 3_600_000).toISOString() });
		expect(quotaExhaustion(notice(" Your limit will reset in 1 hour."), now))
			.toEqual({ resetAt: new Date(now + 3_600_000).toISOString() });
		expect(quotaExhaustion(notice(" Your limit will reset in 2 minutes, 1 second."), now))
			.toEqual({ resetAt: new Date(now + 121_000).toISOString() });
	});

	it("parses an absolute UTC reset", () => {
		expect(quotaExhaustion(notice(" Your limit will reset on Oct 2, 2026 14:00 UTC."), now))
			.toEqual({ resetAt: "2026-10-02T14:00:00.000Z" });
	});

	it("matches the notice without a reset sentence", () => {
		expect(quotaExhaustion(notice(), now)).toEqual({});
		expect(quotaExhaustion(`\n${notice()}\n`, now)).toEqual({});
	});

	it("ignores other text", () => {
		expect(quotaExhaustion("Hello", now)).toBeUndefined();
		expect(quotaExhaustion("Usage Limit Reached", now)).toBeUndefined();
		expect(quotaExhaustion(`${notice()} Anything else.`, now)).toBeUndefined();
		expect(quotaExhaustion(notice(" Your limit will reset in soon."), now)).toBeUndefined();
	});
});

const exhausted = "W1114 22:07:04.512301 48213 local_connection.py:553] Error 429, Message: Resource has been exhausted (e.g. check quota)., Status: RESOURCE_EXHAUSTED";
const retry = (delay: string) => `I1114 22:07:04.512398 48213 planner_generator.go:359] Encountered retryable api error. retrying in ${delay}`;

describe("ResourceExhaustionTracker", () => {
	afterEach(() => vi.useRealTimers());
	function tracker() {
		vi.useFakeTimers();
		const onExhausted = vi.fn();
		return { track: new ResourceExhaustionTracker(onExhausted), onExhausted };
	}

	it("tolerates two 429 retries and fails on the third", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("7.26s"));
		expect(onExhausted).not.toHaveBeenCalled();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("10.74s"));
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(
			"Antigravity is refusing model requests for resource exhaustion (HTTP 429 RESOURCE_EXHAUSTED: rate limit or entitlement); agy retried 3 times, next retry in 10.74s, without a reply. Retry later or switch to another provider.",
		);
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("25.89s"));
		expect(onExhausted).toHaveBeenCalledTimes(1);
		track.dispose();
	});

	it("accepts the error and the retry on one line", () => {
		const { track, onExhausted } = tracker();
		for (let i = 0; i < 3; i++) track.noteStderrLine(`${retry("500ms")}: ${exhausted}`);
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("agy retried 3 times, next retry in 0.5s"));
		track.dispose();
	});

	it("fails 15 s after the first retry when agy goes quiet", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("1m2.5s"));
		vi.advanceTimersByTime(14_999);
		expect(onExhausted).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("agy retried 1 time, next retry in 62.5s"));
		track.dispose();
	});

	it("starts over after model progress", () => {
		const { track, onExhausted } = tracker();
		for (let i = 0; i < 2; i++) { track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s")); }
		track.noteProgress();
		vi.advanceTimersByTime(20_000);
		for (let i = 0; i < 2; i++) { track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s")); }
		expect(onExhausted).not.toHaveBeenCalled();
		track.dispose();
		vi.advanceTimersByTime(20_000);
		expect(onExhausted).not.toHaveBeenCalled();
	});

	it("ignores other errors, bare markers, prompt text and model names", () => {
		const { track, onExhausted } = tracker();
		for (let i = 0; i < 5; i++) {
			track.noteStderrLine("I1114 22:07:04.000001 48213 local_connection.py:553] Error 503, Message: unavailable, Status: UNAVAILABLE");
			track.noteStderrLine(retry("4s"));
			track.noteStderrLine("prompt: please explain 429 RESOURCE_EXHAUSTED");
			track.noteStderrLine(exhausted);
			track.noteStderrLine("I1114 22:07:04.000002 48213 local_connection.py:553] model gemini-4-hydrogen ready");
		}
		vi.advanceTimersByTime(60_000);
		expect(onExhausted).not.toHaveBeenCalled();
		track.dispose();
	});
});
