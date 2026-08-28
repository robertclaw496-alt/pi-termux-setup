import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type QmdHit = {
	file?: string;
	path?: string;
	title?: string;
	score?: number;
	snippet?: string;
	content?: string;
	chunk?: string;
};

const MAX_QUERY_CHARS = 240;
const MAX_RESULTS = 3;
const MAX_RESULT_CHARS = 6_000;

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");
}

function parseHits(stdout: string): QmdHit[] {
	const cleaned = stripAnsi(stdout);
	const lines = cleaned.split(/\r?\n/);
	const firstJsonLine = lines.findIndex((line) => {
		const value = line.trimStart();
		return value.startsWith("[") || value.startsWith("{");
	});
	if (firstJsonLine === -1) return [];

	const parsed: unknown = JSON.parse(lines.slice(firstJsonLine).join("\n"));
	if (Array.isArray(parsed)) return parsed as QmdHit[];
	if (parsed && typeof parsed === "object" && "results" in parsed && Array.isArray(parsed.results)) {
		return parsed.results as QmdHit[];
	}
	return [];
}

function formatResults(hits: QmdHit[]): string {
	const sections = hits.map((hit, index) => {
		const file = hit.file ?? hit.path ?? "unknown file";
		const title = hit.title ? ` — ${hit.title}` : "";
		const score = typeof hit.score === "number" ? ` (score ${hit.score.toFixed(2)})` : "";
		const text = hit.snippet ?? hit.content ?? hit.chunk ?? "";
		return `### Result ${index + 1}: ${file}${title}${score}\n${text.trim()}`;
	});

	const formatted = sections.join("\n\n---\n\n");
	return formatted.length > MAX_RESULT_CHARS
		? `${formatted.slice(0, MAX_RESULT_CHARS)}\n\n[Memory-search output truncated]`
		: formatted;
}

export default function memoryQuery(pi: ExtensionAPI) {
	pi.registerCommand("memory", {
		description: "Search durable memory and answer using the current model: /memory <question>",
		handler: async (args, ctx) => {
			const query = args.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, MAX_QUERY_CHARS);
			if (!query) {
				ctx.ui.notify("Usage: /memory <question>", "warning");
				return;
			}

			const result = await pi.exec("qmd", ["search", "--json", "-c", "pi-memory", "-n", String(MAX_RESULTS), query], {
				timeout: 5_000,
			});

			let hits: QmdHit[] = [];
			let error: string | undefined;
			if (result.code !== 0) {
				error = result.stderr.trim() || `qmd exited with code ${result.code}`;
			} else {
				try {
					hits = parseHits(result.stdout).slice(0, MAX_RESULTS);
				} catch (err) {
					error = err instanceof Error ? err.message : String(err);
				}
			}

			const lookup = error
				? `Memory search failed: ${error}`
				: hits.length > 0
					? formatResults(hits)
					: "No matching records were found in durable memory.";

			const content = [
				"Memory lookup requested by the user.",
				`Question: ${query}`,
				"",
				lookup,
				"",
				"Answer the user's question using these records when relevant. Treat them as historical context; do not claim a record exists if search found none.",
			].join("\n");

			const message = {
				customType: "memory-query",
				content,
				display: true,
				details: { query, count: hits.length, error },
			};

			if (ctx.isIdle()) {
				pi.sendMessage(message, { triggerTurn: true });
			} else {
				pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
				ctx.ui.notify("Memory lookup queued", "info");
			}
		},
	});
}
