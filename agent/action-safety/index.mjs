import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const STATUSES = Object.freeze(["PLANNED", "STARTED", "COMPLETED", "FAILED", "UNKNOWN"]);
const SECRET_KEY = /(?:api[_-]?key|api[_-]?hash|authorization|bearer|cookie|password|secret|session|token|phone|code)/i;
export class AmbiguousExternalActionError extends Error {
  constructor(operation) {
    super(`External action ${operation.operation_id} is UNKNOWN and was not repeated.`);
    this.name = "AmbiguousExternalActionError";
    this.operation = operation;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? "REDACTED" : redact(item)]));
}

function sanitizeError(error) {
  // Errors may embed raw protocol dumps with account identifiers, so keep only a
  // short leading diagnostic and strip long digit runs that can identify a user.
  const text = String(error)
    .replace(/(api[_-]?key|api[_-]?hash|authorization|bearer|cookie|password|secret|session|token|phone|code)(\s*[:=]\s*)([^\s,;}]+)/gi, "$1$2REDACTED")
    .replace(/(Bearer\s+)[^\s]+/gi, "$1REDACTED")
    .replace(/\d{5,}/g, "REDACTED");
  return text.split(/\r?\n/)[0].slice(0, 200);
}

function safeReference(result) {
  if (!result || typeof result !== "object") return { kind: typeof result };
  const pick = ["status", "id", "message_id", "peer_id", "operation_id", "deduplicated", "reconciled"];
  const reference = Object.fromEntries(pick.filter(key => result[key] !== undefined).map(key => [key, result[key]]));
  return redact(reference);
}

function targetOf(args = {}) {
  // Telegram targets first (unchanged), then local file/shell targets. Only a
  // hash is kept: paths and commands can embed private or secret material.
  const telegram = args.peer ?? args.channel ?? args.invite ?? args.from_peer;
  if (telegram !== undefined && telegram !== null && telegram !== "") {
    return { kind: typeof telegram, hash: sha256(String(telegram)) };
  }
  if (args.target !== undefined && args.target !== null && args.target !== "") {
    return { kind: typeof args.target, hash: sha256(String(args.target)) };
  }
  if (args.path) return { kind: "path", hash: sha256(String(args.path)) };
  if (args.command_hash) return { kind: "command", hash: String(args.command_hash) };
  return { kind: "none", hash: sha256("") };
}

function stableRandomId(operationId) {
  const value = BigInt(`0x${operationId.slice(3, 19)}`) & ((1n << 63n) - 1n);
  return (value || 1n).toString();
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.${randomBytes(5).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  await chmod(path, 0o600);
}

async function readJson(path, operationId = undefined) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error instanceof SyntaxError) return { operation_id: operationId, status: "UNKNOWN", journal_corrupt: true, reconciliation_error: "Corrupt operation record; external write is blocked." };
    throw error;
  }
}

async function acquireLock(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`);
      return async () => { await handle.close(); await rm(path, { force: true }); };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // Reclaim the lock when its owner is gone. The holder's pid may be stored
      // as JSON or, after a partial or foreign write, as plain text; an
      // unreadable lock is treated as stale rather than blocking recovery.
      let ownerPid = null;
      try {
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && Number.isInteger(parsed.pid)) ownerPid = parsed.pid;
        else if (Number.isInteger(parsed)) ownerPid = parsed;
        else {
          const digits = raw.match(/\d+/);
          if (digits) ownerPid = Number(digits[0]);
        }
      } catch {
        try {
          const digits = (await readFile(path, "utf8")).match(/\d+/);
          if (digits) ownerPid = Number(digits[0]);
        } catch { ownerPid = null; }
      }
      let stale = false;
      if (ownerPid && ownerPid !== process.pid) {
        try { process.kill(ownerPid, 0); } catch (probe) { if (probe?.code === "ESRCH") stale = true; }
      } else if (!ownerPid) {
        stale = true;
      }
      if (!stale) {
        try { if ((await stat(path)).mtimeMs < Date.now() - timeoutMs) stale = true; } catch { stale = true; }
      }
      if (stale) await rm(path, { force: true });
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring action-safety lock: ${path}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}

function fault(point) {
  if (process.env.PI_ACTION_SAFETY_FAULT !== point) return;
  if (process.env.PI_ACTION_SAFETY_FAULT_MODE === "throw") throw new Error(`Injected crash at ${point}`);
  process.kill(process.pid, "SIGKILL");
}

export class OperationJournal {
  constructor(root = process.env.PI_ACTION_SAFETY_DIR || join(process.env.HOME || ".", ".pi", "agent", "action-safety")) {
    this.root = root;
    this.operations = join(root, "operations");
    this.lockFile = join(root, ".journal.lock");
  }

  path(operationId) { return join(this.operations, `${operationId}.json`); }
  async get(operationId) { return readJson(this.path(operationId), operationId); }
  async save(operation) { await atomicJson(this.path(operation.operation_id), operation); return operation; }
  async withLock(fn) { const release = await acquireLock(this.lockFile); try { return await fn(); } finally { await release(); } }
  async list() {
    try {
      const names = (await readdir(this.operations)).filter(name => name.endsWith(".json"));
      return (await Promise.all(names.map(name => readJson(join(this.operations, name,))))).filter(Boolean);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }
}

export function buildOperation({ sessionId, turnRef, tool, action, args, operationKey }) {
  const normalized = { ...args };
  delete normalized.operation_key;
  delete normalized._pi_action_safety;
  // Fields prefixed with `meta_` describe observed external state rather than
  // intent. They must not take part in identity: a pre-state hash changes the
  // moment the mutation lands, so including it would mint a different
  // operation_id on replay and defeat deduplication after a crash.
  const identifying = Object.fromEntries(Object.entries(normalized).filter(([key]) => !key.startsWith("meta_")));
  const normalized_arguments_hash = sha256(canonicalJson(identifying));
  const target = targetOf(identifying);
  const logicalRef = operationKey || turnRef;
  if (!logicalRef) throw new Error("Action safety requires a stable turn reference or operation_key.");
  const operation_id = `op_${sha256(canonicalJson({ sessionId, tool, action, target, normalized_arguments_hash, logicalRef })).slice(0, 32)}`;
  const reconcile_arguments = Object.fromEntries(Object.entries(redact(normalized)).filter(([key]) => ["message_id", "reaction", "desired_hash", "expected_before_hash", "meta_expected_before_hash", "classification", "marked"].includes(key)));
  return {
    operation_id,
    tool,
    action,
    target,
    normalized_arguments_hash,
    reconcile_arguments,
    session_id: sessionId,
    turn_reference: sha256(String(logicalRef)),
    random_id: stableRandomId(operation_id),
  };
}

export class ActionSafety {
  constructor({ journal = new OperationJournal(), now = () => new Date().toISOString() } = {}) { this.journal = journal; this.now = now; }
  async execute(spec, { invoke, reconcile, classification } = {}) {
    // Read-only work must not pay for durability: no journal record, no lock,
    // no reconciliation. This keeps ordinary research and inspection fast.
    if (classification === "READ_ONLY") return { result: await invoke({ operation_id: null, classification }), skipped: true };
    const seed = buildOperation(spec);
    return this.journal.withLock(async () => {
      fault("before_planned");
      let operation = await this.journal.get(seed.operation_id);
      if (!operation) {
        operation = { ...seed, status: "PLANNED", created_at: this.now(), started_at: null, completed_at: null, result_reference: null, attempt: 0 };
        await this.journal.save(operation);
      }
      fault("after_planned");
      if (!operation || operation.operation_id !== seed.operation_id || !STATUSES.includes(operation.status) || operation.normalized_arguments_hash !== seed.normalized_arguments_hash) {
        const unknown = { ...seed, ...(operation || {}), operation_id: seed.operation_id, status: "UNKNOWN", journal_corrupt: true, reconciliation_error: "Invalid operation record; external write is blocked." };
        await this.journal.save(unknown);
        throw new AmbiguousExternalActionError(unknown);
      }
      if (operation.status === "COMPLETED") return { operation, result: operation.result_reference, deduplicated: true };
      if (operation.status === "FAILED") throw new Error(`External action ${operation.operation_id} previously failed; explicit new operation_key is required to retry.`);
      if (operation.journal_corrupt) throw new AmbiguousExternalActionError(operation);
      if (operation.status === "STARTED" || operation.status === "UNKNOWN") {
        let recovery;
        try { recovery = await reconcile(operation); } catch (error) {
          operation = { ...operation, status: "UNKNOWN", reconciliation_error: sanitizeError(error), reconciled_at: this.now() };
          await this.journal.save(operation);
          throw new AmbiguousExternalActionError(operation);
        }
        if (recovery?.state === "completed") {
          operation = { ...operation, status: "COMPLETED", completed_at: this.now(), reconciled_at: this.now(), result_reference: safeReference({ ...recovery.result, reconciled: true }) };
          await this.journal.save(operation);
          return { operation, result: operation.result_reference, reconciled: true };
        }
        if (recovery?.state !== "retry") {
          operation = { ...operation, status: "UNKNOWN", reconciled_at: this.now(), reconciliation_error: recovery?.reason?.slice?.(0, 500) ?? "No conclusive reconciliation evidence" };
          await this.journal.save(operation);
          throw new AmbiguousExternalActionError(operation);
        }
      }
      operation = { ...operation, status: "STARTED", started_at: operation.started_at ?? this.now(), attempt: operation.attempt + 1, reconciliation_error: undefined };
      await this.journal.save(operation);
      fault("after_started");
      let result;
      try { result = await invoke(operation); } catch (error) {
        // A precondition refusal happens before any mutation, so there is nothing
        // ambiguous to reconcile: fail cleanly and let the caller re-plan.
        if (error?.preconditionFailed) {
          operation = { ...operation, status: "FAILED", failed_at: this.now(), last_error: sanitizeError(error) };
          await this.journal.save(operation);
          throw error;
        }
        // The external call may still have succeeded (transport or response-parse
        // failure after the write landed). Ask for evidence before deciding.
        let evidence;
        try { evidence = await reconcile({ ...operation, status: "UNKNOWN" }); } catch { evidence = undefined; }
        if (evidence?.state === "completed") {
          operation = { ...operation, status: "COMPLETED", completed_at: this.now(), reconciled_at: this.now(), result_reference: safeReference({ ...evidence.result, reconciled: true }), last_error: sanitizeError(error) };
          await this.journal.save(operation);
          return { operation, result: operation.result_reference, reconciled: true };
        }
        if (evidence?.state === "retry") {
          operation = { ...operation, status: "FAILED", failed_at: this.now(), last_error: sanitizeError(error) };
          await this.journal.save(operation);
          throw error;
        }
        operation = { ...operation, status: "UNKNOWN", last_error: sanitizeError(error) };
        await this.journal.save(operation);
        throw new AmbiguousExternalActionError(operation);
      }
      fault("after_external");
      operation = { ...operation, status: "COMPLETED", completed_at: this.now(), result_reference: safeReference(result), last_error: undefined };
      await this.journal.save(operation);
      fault("after_completed");
      return { operation, result, deduplicated: false };
    });
  }
}
