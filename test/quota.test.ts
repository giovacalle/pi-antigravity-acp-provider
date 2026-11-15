import { afterEach, describe, expect, it, vi } from "vitest";
import {
	quotaExhaustion,
	RESOURCE_EXHAUSTED_STARTUP_MARGIN_MS,
	RESOURCE_EXHAUSTED_UNKNOWN_DELAY_MS,
	ResourceExhaustionTracker,
} from "../src/acp/quota.js";

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
			"Antigravity quota exceeded: the model path refused requests with HTTP 429 RESOURCE_EXHAUSTED (rate limit or entitlement); agy retried 3 times, next retry in 10.74s, without a reply. Retry later or switch to another provider.",
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

	it("fails at once when the announced retry delays pass 15 s", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("1m2.5s"));
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("agy retried 1 time, next retry in 62.5s"));
		track.dispose();
	});

	it("fails when two announced delays together pass 15 s", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("10s"));
		expect(onExhausted).not.toHaveBeenCalled();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("5.001s"));
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("agy retried 2 times, next retry in 5s"));
		track.dispose();
	});

	it("lets a turn recover after two retries even when the first update comes late", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		vi.advanceTimersByTime(4_000);
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("7.26s"));
		// The third call succeeds after 7.26 s; the model takes 8 s more to emit its first update.
		vi.advanceTimersByTime(7_260 + 8_000);
		expect(onExhausted).not.toHaveBeenCalled();
		track.noteProgress();
		vi.advanceTimersByTime(60_000);
		expect(onExhausted).not.toHaveBeenCalled();
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

	it("fails when agy goes quiet past the announced delay plus the start-up margin", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		vi.advanceTimersByTime(4_000 + RESOURCE_EXHAUSTED_STARTUP_MARGIN_MS - 1);
		expect(onExhausted).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("agy retried 1 time, next retry in 4s"));
		track.dispose();
	});

	it("re-arms the quiet timer on each retry", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		vi.advanceTimersByTime(4_000);
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("7.26s"));
		vi.advanceTimersByTime(7_260 + RESOURCE_EXHAUSTED_STARTUP_MARGIN_MS - 1);
		expect(onExhausted).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("agy retried 2 times, next retry in 7.26s"));
		track.dispose();
	});

	it("never fires during the announced delay of a call that then recovers", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("15s"));
		vi.advanceTimersByTime(15_000 + RESOURCE_EXHAUSTED_STARTUP_MARGIN_MS - 1);
		track.noteProgress();
		vi.advanceTimersByTime(10 * 60_000);
		expect(onExhausted).not.toHaveBeenCalled();
		track.dispose();
	});

	it("stops the quiet timer on dispose", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4s"));
		track.dispose();
		vi.advanceTimersByTime(10 * 60_000);
		expect(onExhausted).not.toHaveBeenCalled();
	});

	it("parses Go durations with nanosecond precision", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("4.000000001s"));
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("7.262817364s"));
		expect(onExhausted).not.toHaveBeenCalled();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("1.5h0m0.123456789s"));
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("agy retried 3 times, next retry in 5400.12s"));
		track.dispose();
	});

	it("counts a retry whose delay cannot be parsed and assumes the default delay", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry("a moment"));
		vi.advanceTimersByTime(RESOURCE_EXHAUSTED_UNKNOWN_DELAY_MS + RESOURCE_EXHAUSTED_STARTUP_MARGIN_MS - 1);
		expect(onExhausted).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("agy retried 1 time, next retry delay unknown, without a reply"));
		track.dispose();
	});

	it("counts assumed delays toward the 15 s budget", () => {
		const { track, onExhausted } = tracker();
		track.noteStderrLine(exhausted); track.noteStderrLine(retry(""));
		expect(onExhausted).not.toHaveBeenCalled();
		// 10 s + 10 s assumed > 15 s.
		track.noteStderrLine(exhausted); track.noteStderrLine(retry(""));
		expect(onExhausted).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("agy retried 2 times, next retry delay unknown"));
		track.dispose();
	});

	// Accepted risk, unproven live: agy is not known to echo prompts to stderr. A prompt carrying both the exact
	// 429 line and the retry line on stderr would count; anchoring on the glog prefix is not an option because
	// real stderr interleaves several glog segments on one line.
	it("counts a stderr echo of a prompt that quotes both the 429 and the retry lines", () => {
		const { track, onExhausted } = tracker();
		for (let i = 0; i < 3; i++) track.noteStderrLine(`I1114 22:07:04.000003 48213 local_connection.py:553] prompt: ${exhausted} ${retry("4s")}`);
		expect(onExhausted).toHaveBeenCalledOnce();
		track.dispose();
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
