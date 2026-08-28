/**
 * memory-daily-fallback — update-proof replacement for the pi-memory
 * node_modules patch (most-recent-prior-daily fallback).
 *
 * Problem this solves:
 *   pi-memory's buildMemoryContext() injects "today" + strict calendar
 *   "yesterday" daily logs into the system prompt. If the calendar-yesterday
 *   file is missing or empty (a calendar gap — e.g. no log was written on
 *   07-03), the yesterday slot is simply absent and the most recent real
 *   daily content (07-02) drops out of the auto-injection window. It remains
 *   reachable only via an explicit memory_search call.
 *
 * What this extension does:
 *   On every before_agent_start (after pi-memory has already appended its
 *   `## Memory` block to event.systemPrompt — packages load before
 *   auto-discovered extensions), this extension checks whether the
 *   calendar-yesterday daily file exists and has non-whitespace content.
 *   If it does, the extension is a no-op (pi-memory already injected it).
 *   If it does NOT, the extension computes mostRecentPriorDaily(today) —
 *   the most recent existing daily file strictly before today with >= 50
 *   chars of content — and appends it as an extra `## Daily log: <date>
 *   (most recent prior daily, fallback injection)` section, mimicking
 *   pi-memory's own section format and tail-truncation strategy.
 *
 * Why an extension, not a node_modules patch:
 *   A direct patch to node_modules/pi-memory/index.ts is wiped on
 *   `pi update pi-memory`. This extension lives in ~/.pi/agent/extensions/
 *   (auto-discovered, global) and survives package updates — pi-memory can
 *   be reinstalled/replaced without touching this fix.
 *
 * Why before_agent_start and not session_start:
 *   The memory context is injected by pi-memory's own before_agent_start
 *   handler by mutating event.systemPrompt. session_start fires before
 *   any prompt is submitted and before the system prompt is assembled for
 *   a turn; it is not the place to append to the system prompt. The
 *   systemPrompt is rebuilt per turn, so the fallback must be re-appended
 *   per turn too (it is byte-stable across turns as long as the daily
 *   files do not change, preserving KV-cache prefix stability — matching
 *   pi-memory's own snapshot-stability guarantees).
 *
 * Load order: packages (pi-memory, pi-observational-memory, pi-web-search)
 * are added to the extension list BEFORE auto-discovered global extensions
 * (~/.pi/agent/extensions/*.ts). Therefore pi-memory's before_agent_start
 * runs first and event.systemPrompt already contains the `## Memory` block
 * when this handler runs, so the appended fallback section sits adjacent to
 * it. This ordering is a property of pi's resource-loader/extension loader;
 * if it ever changes, this extension still functions (the block is appended
 * somewhere in the system prompt regardless).
 *
 * Debug: set PI_MEMORY_DAILY_FALLBACK_DEBUG=1 to log when the fallback fires.
 *
 * See ~/.pi/agent/memory/PATCHES.md for the maintenance note.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DAILY_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MIN_CONTENT_CHARS = 50;
const MAX_SECTION_CHARS = 3_000; // matches pi-memory CONTEXT_DAILY_MAX_CHARS
const DEBUG = process.env.PI_MEMORY_DAILY_FALLBACK_DEBUG === "1";

function resolveMemoryDir(): string {
	if (process.env.PI_MEMORY_DIR) return process.env.PI_MEMORY_DIR;
	const home =
		process.env.HOME ??
		process.env.USERPROFILE ??
		(process.env.HOMEDRIVE && process.env.HOMEPATH
			? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
			: undefined) ??
		"~";
	return path.join(home, ".pi", "agent", "memory");
}

function isValidDailyDate(date: string): boolean {
	if (!DAILY_DATE_REGEX.test(date)) return false;
	const [y, m, d] = date.split("-").map(Number);
	const p = new Date(Date.UTC(y, m - 1, d));
	return p.getUTCFullYear() === y && p.getUTCMonth() === m - 1 && p.getUTCDate() === d;
}

function dailyPath(memoryDir: string, date: string): string {
	return path.join(memoryDir, "daily", `${date}.md`);
}

function readFileSafe(p: string): string | null {
	try {
		return fs.readFileSync(p, "utf-8");
	} catch {
		return null;
	}
}

function todayStr(): string {
	return new Date().toISOString().slice(0, 10);
}

function yesterdayStr(): string {
	const d = new Date();
	d.setDate(d.getDate() - 1);
	return d.toISOString().slice(0, 10);
}

/**
 * Most recent existing daily file strictly before todayDate with >= MIN_CONTENT_CHARS
 * of trimmed content. Returns the YYYY-MM-DD date string, or null if none found.
 * Mirrors the logic that lived in the pi-memory node_modules patch so behavior is
 * identical to the proven fix.
 */
function mostRecentPriorDaily(memoryDir: string, todayDate: string): string | null {
	if (!isValidDailyDate(todayDate)) return null;
	const dailyDir = path.join(memoryDir, "daily");
	let files: string[];
	try {
		files = fs.readdirSync(dailyDir);
	} catch {
		return null;
	}
	const prior = files
		.map((f) => f.replace(/\.md$/, ""))
		.filter((d) => isValidDailyDate(d) && d < todayDate)
		.sort();
	for (let i = prior.length - 1; i >= 0; i--) {
		const candidate = prior[i];
		const content = readFileSafe(dailyPath(memoryDir, candidate));
		if (content && content.trim().length >= MIN_CONTENT_CHARS) return candidate;
	}
	return null;
}

/**
 * Tail-truncate (daily logs are append-only → the tail is the most recent and
 * most relevant). Matches pi-memory's "end" truncation strategy for daily logs.
 */
function tailTruncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const tail = text.slice(text.length - max);
	return `[…truncated head, showing last ${max} chars of daily log]\n${tail}`;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, _ctx) => {
		const memoryDir = resolveMemoryDir();
		const today = todayStr();
		const yesterday = yesterdayStr();

		// Only act when the calendar-yesterday daily is missing or whitespace-only.
		// If it has any real content, pi-memory already injected it → no-op to avoid
		// duplicating a daily section in the system prompt.
		const yesterdayContent = readFileSafe(dailyPath(memoryDir, yesterday));
		if (yesterdayContent && yesterdayContent.trim().length > 0) return;

		const fallback = mostRecentPriorDaily(memoryDir, today);
		if (!fallback) return;

		const content = readFileSafe(dailyPath(memoryDir, fallback));
		if (!content || !content.trim()) return;

		const block =
			`\n\n---\n\n## Daily log: ${fallback} (most recent prior daily, fallback injection)\n` +
			`Calendar-yesterday (${yesterday}) has no daily log; injected by the ` +
			`memory-daily-fallback extension so this content stays in the auto-injection ` +
			`window.\n\n` +
			tailTruncate(content, MAX_SECTION_CHARS);

		if (DEBUG) {
			console.error(
				`[memory-daily-fallback] yesterday ${yesterday} empty/missing; ` +
					`injecting fallback daily ${fallback} (${content.length} chars).`,
			);
		}

		return {
			systemPrompt: event.systemPrompt + block,
		};
	});
}