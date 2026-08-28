#!/usr/bin/env node
/**
 * Integration check: sticky-model works when auto-discovered together with the
 * other globally installed extensions (no --no-extensions isolation).
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI =
	process.env.PI_CLI ||
	"/data/data/com.termux/files/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const TARGET = { provider: "mistral", modelId: "mistral-small-latest" };

const tmp = mkdtempSync(join(tmpdir(), "sticky-model-integration-"));
const child = spawn(process.execPath, [CLI, "--mode", "rpc", "--session-dir", join(tmp, "sessions")], {
	cwd: process.env.HOME,
	env: { ...process.env, PI_STICKY_MODEL_STATE: join(tmp, "state.json") },
	stdio: ["pipe", "pipe", "pipe"],
});

const responses = [];
let buffer = "";
let stderr = "";
child.stderr.on("data", (chunk) => {
	stderr += chunk.toString();
});
child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let index = buffer.indexOf("\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).replace(/\r$/, "");
		buffer = buffer.slice(index + 1);
		if (line.trim()) {
			try {
				const msg = JSON.parse(line);
				if (msg.type === "response") responses.push(msg);
			} catch {
				/* not a response line */
			}
		}
		index = buffer.indexOf("\n");
	}
});

function send(command) {
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

async function awaitResponse(id, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const found = responses.find((r) => r.id === id);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`timeout waiting for ${id}\nstderr:\n${stderr.slice(0, 2000)}`);
}

function modelOf(response) {
	const model = response?.data?.model;
	return model ? `${model.provider}/${model.id}` : "(none)";
}

let failed = false;
try {
	send({ id: "state-1", type: "get_state" });
	const before = await awaitResponse("state-1");
	console.log(`startup model: ${modelOf(before)}`);

	send({ id: "set-1", type: "set_model", ...TARGET });
	const set = await awaitResponse("set-1");
	if (!set.success) throw new Error(`set_model failed: ${JSON.stringify(set)}`);

	send({ id: "new-1", type: "new_session" });
	const created = await awaitResponse("new-1");
	if (!created.success || created.data?.cancelled) {
		throw new Error(`new_session failed: ${JSON.stringify(created)}`);
	}

	send({ id: "state-2", type: "get_state" });
	const after = await awaitResponse("state-2");
	const expected = `${TARGET.provider}/${TARGET.modelId}`;
	if (modelOf(after) !== expected) {
		throw new Error(`model after /new: expected ${expected}, got ${modelOf(after)}`);
	}
	console.log(`ok - model survives /new with all extensions loaded: ${expected}`);

	const extensionErrors = stderr.split("\n").filter((line) => /sticky-model/i.test(line) && /error|fail/i.test(line));
	if (extensionErrors.length > 0) {
		throw new Error(`extension errors:\n${extensionErrors.join("\n")}`);
	}
	console.log("\nSTICKY MODEL INTEGRATION TEST PASSED");
} catch (err) {
	failed = true;
	console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
} finally {
	child.stdin.end();
	child.kill("SIGTERM");
	rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
