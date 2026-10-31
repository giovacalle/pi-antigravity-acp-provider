import { AntigravityAcpError } from "./errors.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface AntigravityQuotaSnapshot {
	at: number;
	groups: { displayName: string; buckets: { window: string; remainingFraction: number; resetTime?: string }[] }[];
}

const GROUP = /^- \*\*(.+)\*\*$/u;
const BUCKET = /^ {2}- \*\*(.+?):\*\* (\d+)% remaining(?: \(resets (.+)\))?$/u;
const RESET = new RegExp(`^(${MONTHS.join("|")}) (\\d{1,2}), (\\d{4}), (\\d{2}):(\\d{2}) UTC$`, "u");

/** Parses the Quota Limits section of agy's `/usage` reply; buckets reported as units or Available carry no fraction and are skipped. */
export function parseUsageQuota(text: string, now = Date.now()): AntigravityQuotaSnapshot {
	const section = /^### Quota Limits$([\s\S]*?)(?=^### |(?![\s\S]))/mu.exec(text)?.[1] ?? "";
	const groups: AntigravityQuotaSnapshot["groups"] = [];
	let notice: string | undefined;
	for (const line of section.split("\n")) {
		const group = GROUP.exec(line);
		if (group) {
			groups.push({ displayName: group[1]!, buckets: [] });
			continue;
		}
		const bucket = BUCKET.exec(line);
		if (bucket && groups.length) {
			const [, label, percent, reset] = bucket;
			const resetTime = reset ? resetIso(reset) : undefined;
			groups.at(-1)!.buckets.push({
				window: /weekly/iu.test(label!) ? "weekly" : /five hour/iu.test(label!) ? "5h" : label!,
				remainingFraction: Number(percent) / 100,
				...(resetTime ? { resetTime } : {}),
			});
			continue;
		}
		if (line.startsWith("- ")) notice ??= line.slice(2);
	}
	if (!groups.length) {
		throw new AntigravityAcpError("protocol", `Antigravity /usage reply had no quota groups: ${notice ?? "empty"}`);
	}
	return { at: now, groups };
}

function resetIso(text: string): string | undefined {
	const match = RESET.exec(text);
	if (!match) return undefined;
	const [, month, day, year, hours, minutes] = match;
	return new Date(Date.UTC(Number(year), MONTHS.indexOf(month!), Number(day), Number(hours), Number(minutes))).toISOString();
}
