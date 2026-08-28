#!/usr/bin/env node
/**
 * Behavioral test for the sticky-model extension.
 *
 * Drives a real pi process in RPC mode:
 *   1. set_model to a non-default model
 *   2. new_session
 *   3. get_state must still report the chosen model (sticky)
 *   4. same flow with PI_STICKY_MODEL=0 must fall back to the settings default
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI =
	process.env.PI_CLI ||
	"/data/data/com.termux/files/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js";
const EXT = join(import.meta.dirname, "..", "extensions", "sticky-model.ts");

// Both models must be configured and reachable in the local pi installation.
// START_MODEL has to match defaultProvider/defaultModel from settings.json,
// STICKY_MODEL has to be a different, reasoning-capable model.
function modelFromEnv(name, fallback) {
	const raw = process.env[name];
	if (!raw) return fallback;
	const at = raw.indexOf("/");
	if (at <= 0 || at === raw.length - 1) {
		throw new Error(`${name} must be "provider/model-id", got: ${raw}`);
	}
	return { provider: raw.slice(0, at), modelId: raw.slice(at + 1) };
}

const START_MODEL = modelFromEnv("PI_TEST_START_MODEL", { provider: "yunma", modelId: "gpt-5.6-terra" });
const STICKY_MODEL = modelFromEnv("PI_TEST_STICKY_MODEL", { provider: "mistral", modelId: "mistral-medium-2604" });

function startRpc(env, sessionDir) {
	const child = spawn(process.execPath, [CLI, "--mode", "rpc", "--no-extensions", "-e", EXT, "--session-dir", sessionDir], {
		cwd: process.env.HOME,
		env: { ...process.env, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});

	const pending = [];
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
				let msg;
				try {
					msg = JSON.parse(line);
				} catch {
					msg = undefined;
				}
				if (msg?.type === "response") {
					const waiter = pending.find((p) => p.id === msg.id);
					if (waiter) {
						pending.splice(pending.indexOf(waiter), 1);
						waiter.resolve(msg);
					}
				}
			}
			index = buffer.indexOf("\n");
		}
	});

	let counter = 0;
	function send(command) {
		const id = `req-${++counter}`;
		const promise = new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`RPC timeout for ${command.type}\nstderr:\n${stderr}`)), 60_000);
			pending.push({
				id,
				resolve: (msg) => {
					clearTimeout(timer);
					resolve(msg);
				},
			});
		});
		child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
		return promise;
	}

	return {
		send,
		stop() {
			child.stdin.end();
			child.kill("SIGTERM");
		},
		get stderr() {
			return stderr;
		},
	};
}

function modelOf(state) {
	const model = state?.data?.model;
	return model ? `${model.provider}/${model.id}` : "(none)";
}

function assertEqual(actual, expected, label) {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${expected}, got ${actual}`);
	}
	console.log(`ok - ${label}: ${actual}`);
}

async function runScenario({ enabled, statePath, sessionDir }) {
	const env = { PI_STICKY_MODEL_STATE: statePath };
	if (!enabled) env.PI_STICKY_MODEL = "0";

	const rpc = startRpc(env, sessionDir);
	try {
		const initial = await rpc.send({ type: "get_state" });
		if (!initial.success) throw new Error(`get_state failed: ${JSON.stringify(initial)}`);
		const startModel = modelOf(initial);

		const set = await rpc.send({ type: "set_model", ...STICKY_MODEL });
		if (!set.success) throw new Error(`set_model failed: ${JSON.stringify(set)}`);

		const thinking = await rpc.send({ type: "set_thinking_level", level: "low" });
		if (!thinking.success) throw new Error(`set_thinking_level failed: ${JSON.stringify(thinking)}`);

		const afterSet = await rpc.send({ type: "get_state" });
		const created = await rpc.send({ type: "new_session" });
		if (!created.success || created.data?.cancelled) {
			throw new Error(`new_session failed: ${JSON.stringify(created)}`);
		}
		const afterNew = await rpc.send({ type: "get_state" });

		return {
			startModel,
			afterSet: modelOf(afterSet),
			afterNew: modelOf(afterNew),
			thinkingAfterSet: afterSet?.data?.thinkingLevel,
			thinkingAfterNew: afterNew?.data?.thinkingLevel,
		};
	} finally {
		rpc.stop();
	}
}

const tmp = mkdtempSync(join(tmpdir(), "sticky-model-test-"));
let failed = false;
try {
	const expectedSticky = `${STICKY_MODEL.provider}/${STICKY_MODEL.modelId}`;
	const expectedDefault = `${START_MODEL.provider}/${START_MODEL.modelId}`;

	const on = await runScenario({
		enabled: true,
		statePath: join(tmp, "state-on.json"),
		sessionDir: join(tmp, "sessions-on"),
	});
	assertEqual(on.startModel, expectedDefault, "enabled: startup uses settings default");
	assertEqual(on.afterSet, expectedSticky, "enabled: set_model applied");
	assertEqual(on.afterNew, expectedSticky, "enabled: model survives /new");
	assertEqual(on.thinkingAfterSet, "low", "enabled: thinking level applied");
	assertEqual(on.thinkingAfterNew, "low", "enabled: thinking level survives /new");

	const off = await runScenario({
		enabled: false,
		statePath: join(tmp, "state-off.json"),
		sessionDir: join(tmp, "sessions-off"),
	});
	assertEqual(off.afterSet, expectedSticky, "disabled: set_model applied");
	assertEqual(off.afterNew, expectedDefault, "disabled: /new falls back to default");

	console.log("\nALL STICKY MODEL TESTS PASSED");
} catch (err) {
	failed = true;
	console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}`);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
