// Crash-safe local file mutations built on the existing action-safety journal.
//
// Every mutation carries enough state to answer one question after a crash:
// "did this already happen?" The answer comes from the filesystem, never from
// an assumption about how far the previous process got.

import { createHash } from "node:crypto";
import { access, appendFile, copyFile, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLASS, classifyFileOperation } from "./classify.mjs";
import { sha256 } from "./index.mjs";

export const ABSENT = "ABSENT";

/**
 * Raised when a mutation is refused before it runs because the target no longer
 * matches the state the caller planned against. Nothing was written, so this is
 * a clean failure and must not be reported as an ambiguous crash outcome.
 */
export class PreconditionFailedError extends Error {
  constructor(message) {
    super(message);
    this.name = "PreconditionFailedError";
    this.preconditionFailed = true;
  }
}

async function hashFile(path) {
  try {
    const buffer = await readFile(path);
    return createHash("sha256").update(buffer).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return ABSENT;
    throw error;
  }
}

export { hashFile };

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/**
 * Write content through a temp file in the same directory, fsync it, then
 * atomically rename. A crash therefore leaves either the old file or the new
 * one, never a partially written file.
 */
async function atomicWrite(path, content, { mode = 0o600 } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.action-safety.${process.pid}.tmp`;
  const handle = await open(temp, "w", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

export { atomicWrite };

/**
 * A marked append writes a stable marker line so a crashed append can be
 * detected instead of duplicated. Unmarked appends stay unrecoverable by design.
 */
export function appendMarker(operationId) {
  return `\u2063pi-op:${operationId}`;
}

function targetHash(path) {
  return { kind: "path", hash: sha256(String(path)) };
}

/**
 * Build the spec + hooks for one file mutation.
 *
 * `action`: write | edit | append | delete | rename | copy | mkdir | chmod
 * Returns { spec, hooks, classification } for ActionSafety.execute.
 */
export async function planFileOperation({
  sessionId,
  turnRef,
  operationKey,
  action,
  path,
  content,
  expectedBeforeHash,
  destination,
  mode,
  marked = false,
}) {
  const { classification, reason } = classifyFileOperation(action);
  const desiredHash = content === undefined ? undefined : sha256(String(content));

  const spec = {
    sessionId,
    turnRef,
    operationKey,
    tool: `file_${action}`,
    action,
    args: { path, destination, mode, desired_hash: desiredHash, expected_before_hash: expectedBeforeHash, marked },
  };

  const hooks = {
    classification,
    reason,
    invoke: async operation => runFileOperation({ operation, action, path, content, destination, mode, marked, expectedBeforeHash }),
    reconcile: async operation => reconcileFileOperation({ operation, action, path, content, destination, mode, marked, expectedBeforeHash, desiredHash }),
  };

  return { spec, hooks, classification, reason };
}

async function runFileOperation({ operation, action, path, content, destination, mode, marked, expectedBeforeHash }) {
  if (action === "write") {
    if (expectedBeforeHash !== undefined) {
      const current = await hashFile(path);
      if (current !== expectedBeforeHash) throw new PreconditionFailedError(`Precondition failed for write: ${path} changed since it was read`);
    }
    await atomicWrite(path, content, { mode });
    return { status: "written", path, result_hash: await hashFile(path) };
  }
  if (action === "edit") {
    const current = await hashFile(path);
    if (expectedBeforeHash !== undefined && current !== expectedBeforeHash) {
      throw new PreconditionFailedError(`Precondition failed for edit: ${path} does not hold the expected pre-edit content`);
    }
    await atomicWrite(path, content, { mode });
    return { status: "edited", path, result_hash: await hashFile(path) };
  }
  if (action === "append") {
    const suffix = marked ? `${content}${appendMarker(operation.operation_id)}\n` : `${content}\n`;
    await appendFile(path, suffix, { mode: mode ?? 0o600 });
    return { status: "appended", path, marked };
  }
  if (action === "delete") {
    await rm(path, { force: true, recursive: false });
    return { status: "deleted", path };
  }
  if (action === "rename") {
    await rename(path, destination);
    return { status: "renamed", path, destination };
  }
  if (action === "copy") {
    await copyFile(path, destination);
    return { status: "copied", path, destination, result_hash: await hashFile(destination) };
  }
  if (action === "mkdir") {
    await mkdir(path, { recursive: true, mode: mode ?? 0o700 });
    return { status: "created", path };
  }
  if (action === "chmod") {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, mode);
    return { status: "chmod", path };
  }
  throw new Error(`Unsupported file action: ${action}`);
}

async function reconcileFileOperation({ operation, action, path, content, destination, marked, expectedBeforeHash, desiredHash }) {
  if (action === "write" || action === "edit") {
    const current = await hashFile(path);
    if (desiredHash !== undefined && current === desiredHash) {
      return { state: "completed", result: { status: `${action}_already_applied`, path, result_hash: current } };
    }
    if (expectedBeforeHash !== undefined && current === expectedBeforeHash) {
      return { state: "retry", reason: "file still holds the pre-mutation content" };
    }
    if (expectedBeforeHash === undefined && current === ABSENT) {
      return { state: "retry", reason: "target file does not exist yet" };
    }
    return { state: "unknown", reason: "file content matches neither the expected pre nor post state" };
  }

  if (action === "append") {
    if (!marked) {
      // An unmarked append leaves no evidence, so absence of proof must not be
      // read as absence of the write.
      return { state: "unknown", reason: "unmarked append cannot be verified; replay could duplicate content" };
    }
    const marker = appendMarker(operation.operation_id);
    const body = await readFile(path, "utf8").catch(() => "");
    const occurrences = body.split(marker).length - 1;
    if (occurrences === 1) return { state: "completed", result: { status: "append_already_applied", path } };
    if (occurrences === 0) return { state: "retry", reason: "append marker absent; the write did not land" };
    return { state: "unknown", reason: `append marker found ${occurrences} times` };
  }

  if (action === "delete") {
    return (await exists(path))
      ? { state: "retry", reason: "target still exists" }
      : { state: "completed", result: { status: "already_absent", path } };
  }

  if (action === "rename") {
    const sourceExists = await exists(path);
    const destExists = await exists(destination);
    if (sourceExists && !destExists) return { state: "retry", reason: "rename has not been applied" };
    if (!sourceExists && destExists) return { state: "completed", result: { status: "already_renamed", path, destination } };
    if (sourceExists && destExists) return { state: "unknown", reason: "source and destination both exist; overwrite semantics are ambiguous" };
    return { state: "unknown", reason: "source and destination are both absent" };
  }

  if (action === "copy") {
    const current = await hashFile(destination);
    if (current === ABSENT) return { state: "retry", reason: "destination absent" };
    const sourceHash = await hashFile(path);
    if (sourceHash !== ABSENT && current === sourceHash) return { state: "completed", result: { status: "already_copied", path, destination } };
    return { state: "unknown", reason: "destination exists but differs from the source" };
  }

  if (action === "mkdir") {
    return (await exists(path))
      ? { state: "completed", result: { status: "already_created", path } }
      : { state: "retry", reason: "directory absent" };
  }

  if (action === "chmod") {
    return { state: "retry", reason: "chmod to a known mode is idempotent" };
  }

  return { state: "unknown", reason: `no reconciliation strategy for ${action}` };
}

export { runFileOperation, reconcileFileOperation };
