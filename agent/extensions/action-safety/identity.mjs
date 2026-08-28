/**
 * Stable logical identity for built-in tool calls.
 *
 * Provider-assigned tool call IDs cannot be the basis of identity: after a
 * crash and resume the model re-issues the same logical action and the provider
 * mints a NEW id (verified in session JSONL, ids look like `call_<random>`).
 * Identity is therefore derived from what stays stable across resume:
 *
 *   session id + tool name + normalized semantic arguments
 *
 * A monotonically increasing occurrence counter distinguishes a genuine repeat
 * of the same action within one session from a post-crash retry of it: the
 * counter is keyed on the durable journal, so a replayed action that is still
 * open (PLANNED/STARTED) reuses its slot instead of allocating a new one.
 */

import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(String(value)).digest("hex");

/** Canonical JSON with sorted keys so argument order cannot change identity. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

/**
 * Semantic arguments per tool. Only fields that change the external effect are
 * included, so cosmetic differences (a timeout, a relative vs absolute path
 * already resolved by the caller) do not fork identity.
 */
export function semanticArguments(toolName, input, { cwd }) {
  if (toolName === "bash") return { command: String(input?.command ?? "") };
  if (toolName === "write") return { path: String(input?.path ?? ""), content_hash: hash(String(input?.content ?? "")) };
  if (toolName === "edit") {
    const edits = Array.isArray(input?.edits) ? input.edits : [];
    return {
      path: String(input?.path ?? ""),
      edits: edits.map(e => ({ old: hash(String(e?.oldText ?? "")), new: hash(String(e?.newText ?? "")) })),
    };
  }
  return { input: canonical(input ?? null), cwd };
}

/**
 * Build the stable operation key for one logical tool action.
 *
 * `occurrence` separates deliberate repeats of an identical action (for example
 * appending the same line twice on purpose) from a post-crash replay of a
 * single action. It is resolved against the journal by `resolveOperationKey`.
 */
export function operationKeyFor({ sessionId, toolName, semantic, occurrence }) {
  const base = canonical({ sessionId, toolName, semantic });
  return `pi_tool_${hash(base).slice(0, 32)}_${occurrence}`;
}

/**
 * Find the right occurrence slot for this logical action.
 *
 * Walks occurrence 0,1,2,... and stops at the first slot that is either unused
 * or still open. A COMPLETED slot means that exact action already finished, so
 * a further identical request is a new logical action and moves to the next
 * slot; an open slot (PLANNED/STARTED/UNKNOWN) is the crash case and must be
 * reused so the safety layer can deduplicate or reconcile it.
 */
export async function resolveOperationKey({ journal, buildOperation, sessionId, toolName, action, semantic, spec, maxOccurrences = 512 }) {
  for (let occurrence = 0; occurrence < maxOccurrences; occurrence++) {
    const operationKey = operationKeyFor({ sessionId, toolName, semantic, occurrence });
    const seed = buildOperation({ ...spec, operationKey });
    let record;
    try {
      record = await journal.get(seed.operation_id);
    } catch {
      // An unreadable record is handled downstream by the safety engine, which
      // fails closed. Reuse this slot so that decision is reached.
      return { operationKey, occurrence };
    }
    if (!record) return { operationKey, occurrence };
    if (record.status !== "COMPLETED") return { operationKey, occurrence, existing: record };
  }
  // Degenerate case: never silently collapse onto a used slot.
  return { operationKey: operationKeyFor({ sessionId, toolName, semantic, occurrence: `overflow_${Date.now()}` }), occurrence: -1 };
}

export { hash as sha256Hex, canonical as canonicalJson };
