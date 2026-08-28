/**
 * sticky-model
 *
 * Keeps the model (and its thinking level) across `/new`.
 *
 * Why this is needed: on `/new` pi builds a brand-new runtime for an empty
 * session. `createAgentSessionFromServices` has no session model to restore, so
 * it falls back to `findInitialModel(defaultProvider/defaultModel from
 * settings)`. The model chosen with `/model` or Ctrl+P in the previous session
 * is lost.
 *
 * Extensions are re-instantiated for the new session, so the last active model
 * cannot live in module state. It is persisted to
 * `~/.pi/agent/state/sticky-model.json` and re-applied in `session_start` when
 * `reason === "new"`.
 *
 * Disable per-session with `PI_STICKY_MODEL=0`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface StickyState {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	updatedAt: string;
}

const STATE_FILE = process.env.PI_STICKY_MODEL_STATE || join(getAgentDir(), "state", "sticky-model.json");

function isEnabled(): boolean {
	const flag = process.env.PI_STICKY_MODEL;
	return flag !== "0" && flag !== "false";
}

function readState(): StickyState | undefined {
	try {
		const parsed = JSON.parse(readFileSync(STATE_FILE, "utf-8")) as Partial<StickyState>;
		if (typeof parsed?.provider !== "string" || typeof parsed?.modelId !== "string") return undefined;
		if (!parsed.provider || !parsed.modelId) return undefined;
		return {
			provider: parsed.provider,
			modelId: parsed.modelId,
			thinkingLevel: parsed.thinkingLevel,
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
		};
	} catch {
		return undefined;
	}
}

function writeState(state: StickyState): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
		const tmp = `${STATE_FILE}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, STATE_FILE);
	} catch {
		// Persisting is best effort: never break a session over it.
	}
}

export default function stickyModel(pi: ExtensionAPI) {
	let lastWritten: string | undefined;

	function record(provider: string | undefined, modelId: string | undefined, thinkingLevel?: ThinkingLevel): void {
		if (!provider || !modelId) return;
		const key = `${provider}/${modelId}:${thinkingLevel ?? ""}`;
		if (key === lastWritten) return;
		lastWritten = key;
		writeState({ provider, modelId, thinkingLevel, updatedAt: new Date().toISOString() });
	}

	function recordCurrent(ctx: ExtensionContext): void {
		record(ctx.model?.provider, ctx.model?.id, pi.getThinkingLevel() as ThinkingLevel);
	}

	async function restore(ctx: ExtensionContext): Promise<void> {
		const saved = readState();
		if (!saved) return;
		if (ctx.model && ctx.model.provider === saved.provider && ctx.model.id === saved.modelId) {
			// Already active; only the thinking level may still need restoring.
			if (saved.thinkingLevel && pi.getThinkingLevel() !== saved.thinkingLevel) {
				pi.setThinkingLevel(saved.thinkingLevel);
			}
			return;
		}

		const model = ctx.modelRegistry.find(saved.provider, saved.modelId);
		if (!model) {
			ctx.ui.notify(`sticky-model: ${saved.provider}/${saved.modelId} is not available, keeping default`, "warning");
			return;
		}

		let ok = false;
		try {
			ok = await pi.setModel(model);
		} catch (err) {
			ok = false;
			ctx.ui.notify(
				`sticky-model: could not restore ${saved.provider}/${saved.modelId}: ${err instanceof Error ? err.message : String(err)}`,
				"warning",
			);
		}
		if (!ok) return;

		if (saved.thinkingLevel && pi.getThinkingLevel() !== saved.thinkingLevel) {
			pi.setThinkingLevel(saved.thinkingLevel);
		}
	}

	pi.on("session_start", async (event, ctx) => {
		if (!isEnabled()) return;
		if (event.reason === "new") {
			await restore(ctx);
		}
		recordCurrent(ctx);
	});

	// Snapshot the model of the session being left, before it is torn down.
	pi.on("session_before_switch", async (_event, ctx) => {
		if (!isEnabled()) return;
		recordCurrent(ctx);
	});

	pi.on("model_select", async (event) => {
		if (!isEnabled()) return;
		record(event.model.provider, event.model.id, pi.getThinkingLevel() as ThinkingLevel);
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (!isEnabled()) return;
		record(ctx.model?.provider, ctx.model?.id, event.level as ThinkingLevel);
	});
}
