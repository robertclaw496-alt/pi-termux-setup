// Crash-safe execution of shell commands.
//
// This layer makes no promise of exactly-once for arbitrary shell. It promises
// something narrower and achievable: after a crash, a command is only re-run
// when the layer can show it is safe, and an opaque command in an uncertain
// state is never replayed automatically.

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { CLASS, classifyCommand } from "./classify.mjs";
import { normalizeCommand, sanitizeCommand, sanitizeOutput } from "./sanitize.mjs";
import { sha256 } from "./index.mjs";

/**
 * Read a process's start time from /proc so a recycled PID cannot be mistaken
 * for the original child. /proc/stat (boot time) is not readable on Android, so
 * the raw starttime field is used as an opaque identity token.
 */
export async function processIdentity(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    // The comm field can contain spaces and parentheses, so split after ')'.
    const tail = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
    return { pid, start_ticks: tail[19] ?? null };
  } catch {
    return null;
  }
}

/**
 * True when the recorded child is still the same live process.
 */
export async function childStillRunning(record) {
  if (!record?.child?.pid) return false;
  const current = await processIdentity(record.child.pid);
  if (!current) return false;
  if (record.child.start_ticks && current.start_ticks && record.child.start_ticks !== current.start_ticks) return false;
  return true;
}

function runCommand(command, { cwd, timeoutMs = 120000, env, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/data/data/com.termux/files/usr/bin/bash", ["-c", command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "", settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    // A bounded lifecycle keeps a hung command from leaking a handle into Pi.
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 500).unref();
      finish(reject, new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    child.on("error", error => finish(reject, error));
    child.on("close", code => finish(resolve, { exit_code: code, stdout: out, stderr: err, pid: child.pid }));
    // Record child identity before the command can finish, so a crash mid-run
    // leaves enough information to tell "still running" from "gone".
    if (child.pid && onSpawn) Promise.resolve(onSpawn(child.pid)).catch(() => {});
  });
}

/**
 * Execute a command while recording child identity in the journal, so a later
 * process can tell "still running" from "gone".
 */
async function invokeWithChildTracking({ command, cwd, timeoutMs, env, journal, operation }) {
  const onSpawn = async pid => {
    // Read-only work takes a fast path with `operation_id: null` and must never
    // create a journal record; writing one here would both violate that
    // guarantee and leave an unaddressable entry behind.
    if (!journal || !operation?.operation_id) return;
    const identity = await processIdentity(pid);
    if (identity) await journal.save({ ...operation, status: "STARTED", child: identity });
  };
  const result = await runCommand(command, { cwd, timeoutMs, env, onSpawn });
  if (result.exit_code !== 0) {
    const error = new Error(`command exited with ${result.exit_code}: ${sanitizeOutput(result.stderr || result.stdout)}`);
    error.exitCode = result.exit_code;
    throw error;
  }
  return {
    status: "executed",
    exit_code: result.exit_code,
    output_fingerprint: sha256(`${result.stdout}${result.stderr}`).slice(0, 32),
  };
}

/**
 * Plan a shell command. `verify` is an optional caller-supplied probe that
 * proves whether the effect already exists; without it, only inherently
 * idempotent classes can recover automatically.
 */
export function planShellCommand({ sessionId, turnRef, operationKey, command, cwd = process.cwd(), timeoutMs = 120000, env, journal, verify }) {
  const info = classifyCommand(command);
  const normalized = normalizeCommand(command);

  const spec = {
    sessionId,
    turnRef,
    operationKey,
    tool: "bash",
    action: info.classification === CLASS.READ_ONLY ? "read" : "shell",
    args: {
      command_hash: sha256(normalized),
      normalized_command: sanitizeCommand(normalized),
      classification: info.classification,
      cwd,
    },
  };

  const hooks = {
    classification: info.classification,
    reason: info.reason,
    invoke: operation => invokeWithChildTracking({ command, cwd, timeoutMs, env, journal, operation }),
    reconcile: async operation => {
      // A child that is still alive must never be duplicated.
      if (await childStillRunning(operation)) {
        return { state: "unknown", reason: "the original child process is still running; a second run would duplicate it" };
      }
      if (verify) {
        const verdict = await verify(operation);
        if (verdict?.state) return verdict;
      }
      if (info.classification === CLASS.SAFE_IDEMPOTENT_LOCAL) {
        return { state: "retry", reason: `${info.command_name ?? "command"} is idempotent; repeating converges to the same state` };
      }
      if (info.classification === CLASS.READ_ONLY) {
        return { state: "retry", reason: "read-only command has no side effect to duplicate" };
      }
      return { state: "unknown", reason: `${info.classification} command cannot be proven; no blind replay (${info.reason})` };
    },
  };

  return { spec, hooks, classification: info.classification, reason: info.reason };
}
