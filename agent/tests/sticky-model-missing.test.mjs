#!/usr/bin/env node
/**
 * Degradation check: a saved model that no longer exists must not break `/new`.
 * pi should keep the settings default and continue working.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI =
	process.env.PI_CLI ||
	"/data/data/com.termux/files/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const EXT = join(import.meta.dirname, "..", "extensions", "sticky-model.ts");

const tmp = mkdtempSync(join(tmpdir(), "sticky-model-missing-"));
const statePath = join(tmp, "state.json");
writeFileSync(
	statePath,
	JSON.stringify({ provider: "provider-that-does-not-exist", modelId: "no-such-model", thinkingLevel: "high" }),
);

const child = spawn(
	process.execPath,
	[CLI, "--mode", "rpc", "--no-extensions", "-e", EXT, "--session-dir", join(tmp, "sessions")],
	{
		cwd: process.env.HOME,
		env: { ...process.env, PI_STICKY_MODEL_STATE: statePath },
		stdio: ["pipe", "pipe", "pipe"],
	},
);

let buffer = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
});
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString();
});

const send = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);

function responses() {
	return buffer
		.split("\n")
		.filter((line) => line.includes('"type":"response"'))
		.flatMap((line) => {
			try {
				return [JSON.parse(line)];
			} catch {
				return [];
			}
		});
}

async function wait(id, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = responses().find((r) => r.id === id);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`timeout waiting for ${id}\nstderr:\n${stderr.slice(0, 1500)}`);
}

const modelOf = (r) => (r?.data?.model ? `${r.data.model.provider}/${r.data.model.id}` : "(none)");

let failed = false;
try {
	send({ id: "a", type: "get_state" });
	const before = await wait("a");
	const startup = modelOf(before);

	send({ id: "b", type: "new_session" });
	const created = await wait("b");
	if (!created.success || created.data?.cancelled) {
		throw new Error(`new_session failed: ${JSON.stringify(created)}`);
	}

	send({ id: "c", type: "get_state" });
	const after = await wait("c");
	if (modelOf(after) !== startup) {
		throw new Error(`model changed unexpectedly: ${startup} -> ${modelOf(after)}`);
	}

	console.log(`ok - unavailable saved model ignored, kept ${startup}`);
	console.log("\nSTICKY MODEL MISSING-MODEL TEST PASSED");
} catch (err) {
	failed = true;
	console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
} finally {
	child.stdin.end();
	child.kill("SIGTERM");
	rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
