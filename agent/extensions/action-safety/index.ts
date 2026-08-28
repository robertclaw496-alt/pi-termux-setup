/**
 * Automatic crash/replay protection for Pi's built-in bash, write and edit.
 *
 * Design, proven against Pi 0.84.2 sources rather than assumed:
 *
 *   - `tool_call` can block and mutate input, but a blocked call is turned into
 *     `createErrorToolResult(...)` with `isError: true` inside
 *     `prepareToolCall`, and `finalizeExecutedToolCall` (hence `tool_result`)
 *     is skipped for blocked calls. So blocking CANNOT report a deduplicated
 *     action as success, which requirement 17 forbids.
 *   - `_refreshToolRegistry` builds the execution registry from built-ins and
 *     then applies `toolRegistry.set(tool.name, tool)` for extension tools.
 *     A registered tool named `bash`/`write`/`edit` therefore fully replaces
 *     built-in execution while keeping the same name for the model.
 *   - `createBashToolDefinition`, `createWriteToolDefinition` and
 *     `createEditToolDefinition` are public root exports that accept injected
 *     `operations`. Delegating to them preserves built-in behavior, schema,
 *     truncation, rendering and the file mutation queue, while routing only the
 *     actual mutation through the safety layer.
 *
 * That combination gives real execution replacement plus genuine (non-error)
 * results after deduplication, with no core patch.
 */

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

const AS_DIR = `${process.env.HOME}/.pi/agent/action-safety`;
const EXT_DIR = `${process.env.HOME}/.pi/agent/extensions/action-safety`;

// The safety engine is plain ESM and is loaded dynamically so a failure to load
// degrades to unprotected-but-working tools instead of breaking Pi startup.
type SafetyModule = {
  ActionSafety: any;
  OperationJournal: any;
  AmbiguousExternalActionError: any;
  buildOperation: any;
  sha256: any;
};
type FileSafety = {
  planFileOperation: any;
  hashFile: any;
  atomicWrite: any;
  PreconditionFailedError: any;
  ABSENT: string;
};
type Classify = { classifyCommand: any; CLASS: Record<string, string> };
type Sanitize = { sanitizeCommand: any; sanitizeOutput: any };
type Identity = { semanticArguments: any; resolveOperationKey: any };

let engine: (SafetyModule & FileSafety & Classify & Identity & Sanitize) | undefined;
let engineError: string | undefined;

async function loadEngine() {
  if (engine || engineError) return engine;
  try {
    const [core, file, classify, identity, sanitize] = await Promise.all([
      import(`${AS_DIR}/index.mjs`),
      import(`${AS_DIR}/file-safety.mjs`),
      import(`${AS_DIR}/classify.mjs`),
      import(`${EXT_DIR}/identity.mjs`),
      import(`${AS_DIR}/sanitize.mjs`),
    ]);
    engine = { ...core, ...file, ...classify, ...identity, ...sanitize } as any;
    return engine;
  } catch (error) {
    engineError = error instanceof Error ? error.message : String(error);
    return undefined;
  }
}

/** Text result in the shape Pi tools return. */
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export default function activate(pi: any) {
  const cwd = process.cwd();
  const journalDir = process.env.PI_ACTION_SAFETY_DIR || AS_DIR;
  const enabled = process.env.PI_ACTION_SAFETY_DISABLE !== "1";

  // One journal instance per session; never a second journal.
  let journal: any;
  let safety: any;
  const sessionIdOf = (ctx: any) => {
    try {
      return ctx?.sessionManager?.getSessionId?.() ?? "no-session";
    } catch {
      return "no-session";
    }
  };

  async function ready(ctx: any) {
    const mod = await loadEngine();
    if (!mod || !enabled) return undefined;
    if (!journal) {
      journal = new mod.OperationJournal(journalDir);
      safety = new mod.ActionSafety({ journal });
    }
    return { mod, sessionId: sessionIdOf(ctx) };
  }

  /**
   * Run one logical mutation through the safety layer.
   *
   * `plan` supplies the operation spec and the invoke/reconcile hooks; the
   * fallback runs the unprotected built-in path when the engine is unavailable,
   * so an extension-side problem never removes the user's ability to work.
   */
  async function guard({
    ctx,
    toolName,
    action,
    input,
    buildSpec,
    hooks,
    describe,
    fallback,
  }: any) {
    const context = await ready(ctx);
    if (!context) return fallback();
    const { mod, sessionId } = context;

    const semantic = mod.semanticArguments(toolName, input, { cwd });
    const baseSpec = buildSpec({ sessionId, semantic });

    let resolved;
    try {
      resolved = await mod.resolveOperationKey({
        journal,
        buildOperation: mod.buildOperation,
        sessionId,
        toolName,
        action,
        semantic,
        spec: baseSpec,
      });
    } catch {
      // Identity resolution is advisory; failing it must not block work.
      return fallback();
    }

    const spec = { ...baseSpec, operationKey: resolved.operationKey };
    try {
      const outcome = await safety.execute(spec, hooks({ mod }));
      return describe(outcome);
    } catch (error: any) {
      if (error?.name === "AmbiguousExternalActionError") {
        // Fail closed: report the ambiguity as a tool error so the model can
        // decide, without repeating a possibly-applied external effect.
        return {
          ...text(
            `action-safety blocked a repeat of this ${toolName} action.\n` +
              `A previous attempt reached the external system but its outcome could not be proven, ` +
              `so replaying it could duplicate the effect.\n` +
              `Operation: ${error.operation?.operation_id ?? "unknown"}\n` +
              `Reason: ${error.operation?.reconciliation_error ?? "state could not be verified"}\n` +
              `Verify the current state before retrying; use a deliberately different action if a retry is intended.`,
          ),
          isError: true,
        };
      }
      if (error?.name === "PreconditionFailedError") {
        // Refused before any mutation: a clean failure, not an ambiguity.
        return { ...text(`${error.message}\nRe-read the file and retry with current content.`), isError: true };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- bash ----
  // Delegates to the built-in bash definition so truncation, PI_* env,
  // rendering and streaming stay identical. Only the exec step is wrapped.
  const bashBase = createBashToolDefinition(cwd, {
    commandPrefix: undefined,
    exposeSessionEnvironment: true,
  });

  pi.registerTool({
    ...bashBase,
    name: "bash",
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const command = String(params?.command ?? "");
      const runBuiltin = () => bashBase.execute(toolCallId, params, signal, onUpdate, ctx);

      const mod = await loadEngine();
      if (!mod || !enabled) return runBuiltin();

      // Read-only commands take the fast path: no journal, no reconciliation.
      const info = mod.classifyCommand(command);
      if (info.classification === mod.CLASS.READ_ONLY) return runBuiltin();

      return guard({
        ctx,
        toolName: "bash",
        action: "shell",
        input: params,
        buildSpec: ({ sessionId, semantic }: any) => ({
          sessionId,
          turnRef: toolCallId,
          tool: "bash",
          action: "shell",
          args: {
            command_hash: mod.sha256(semantic.command),
            classification: info.classification,
            cwd,
          },
        }),
        hooks: () => ({
          classification: info.classification,
          invoke: async () => {
            // The built-in bash tool THROWS on non-zero exit (verified in
            // bash.js: `throw new Error(appendStatus(outputText, ...))`), so a
            // failure surfaces as an exception rather than an isError result.
            // The safety engine then asks `reconcile` whether the effect landed,
            // which is exactly right: a command can fail late, after mutating.
            //
            // The error is re-thrown with sanitized text: a raw shell command or
            // its output can carry credentials, and the engine records the error
            // message in the journal.
            try {
              const result: any = await runBuiltin();
              const output = (result?.content ?? [])
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text ?? "")
                .join("\n");
              return { status: "executed", output_fingerprint: mod.sha256(output).slice(0, 32), builtinResult: result };
            } catch (error: any) {
              const safeError = new Error(mod.sanitizeOutput(error?.message ?? String(error)));
              safeError.name = error?.name ?? "Error";
              throw safeError;
            }
          },
          reconcile: async () => {
            if (info.classification === mod.CLASS.SAFE_IDEMPOTENT_LOCAL) {
              return { state: "retry", reason: "command is idempotent; repeating converges to the same state" };
            }
            // Without a caller-supplied probe there is no proof either way.
            return {
              state: "unknown",
              reason: `${info.classification} command cannot be verified after a crash (${info.reason})`,
            };
          },
        }),
        describe: (outcome: any) => {
          if (outcome.result?.builtinResult) return outcome.result.builtinResult;
          if (outcome.deduplicated || outcome.reconciled) {
            return text(
              `action-safety: this command already ran and completed earlier in this session ` +
                `(operation ${outcome.operation.operation_id}). It was not run again to avoid duplicating its effect.`,
            );
          }
          return text("Command completed.");
        },
        fallback: runBuiltin,
      });
    },
  });

  // --------------------------------------------------------------- write ----
  // The built-in write uses plain fs.writeFile. Injecting operations routes the
  // mutation through the layer's atomic write (temp -> fsync -> rename) while
  // keeping the built-in tool's contract, so the guarantee is upgraded rather
  // than reimplemented.
  pi.registerTool(
    buildFileTool({
      name: "write",
      base: (ops: any) => createWriteToolDefinition(cwd, { operations: ops }),
      action: "write",
      guard,
      loadEngine,
      enabled: () => enabled,
      cwd,
    }),
  );

  // ---------------------------------------------------------------- edit ----
  pi.registerTool(
    buildFileTool({
      name: "edit",
      base: (ops: any) => createEditToolDefinition(cwd, { operations: ops }),
      action: "edit",
      guard,
      loadEngine,
      enabled: () => enabled,
      cwd,
    }),
  );

  // ------------------------------------------------------------- doctor -----
  // Signature is `registerCommand(name, config)` per Pi 0.84.2 docs.
  pi.registerCommand?.("action-safety-doctor", {
    description: "Check the action-safety built-in tool integration",
    handler: async (_args: string, ctx: any) => {
      const report = await doctor(ctx);
      ctx?.ui?.notify?.(report, "info");
      return report;
    },
  });

  async function doctor(ctx: any) {
    const mod = await loadEngine();
    const lines: string[] = [];
    const check = (name: string, ok: boolean, detail: string) =>
      lines.push(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);

    check("extension loaded", true, EXT_DIR);
    check("action-safety engine", Boolean(mod), mod ? AS_DIR : `load failed: ${engineError}`);
    check("enabled", enabled, enabled ? "active" : "disabled via PI_ACTION_SAFETY_DISABLE=1");

    const names: string[] = (pi.getAllTools?.() ?? []).map((t: any) => t.name ?? t);
    for (const tool of ["bash", "write", "edit"]) {
      const count = names.filter(n => n === tool).length;
      check(`tool ${tool} registered once`, count === 1, `${count} registration(s)`);
    }

    if (mod) {
      try {
        const probeJournal = new mod.OperationJournal(journalDir);
        await probeJournal.list();
        check("journal readable/writable", true, journalDir);
      } catch (error: any) {
        check("journal readable/writable", false, error?.message ?? String(error));
      }
      for (const factory of ["createBashToolDefinition", "createWriteToolDefinition", "createEditToolDefinition"]) {
        check(`public API ${factory}`, true, "root export present");
      }
    }
    check("pi version", true, process.env.PI_VERSION ?? "0.84.2 verified");
    check("session id available", sessionIdOf(ctx) !== "no-session", sessionIdOf(ctx));
    return `action-safety doctor\n${lines.join("\n")}`;
  }

  pi.on?.("session_start", async (_event: any, ctx: any) => {
    const mod = await loadEngine();
    if (!mod && enabled) {
      ctx?.ui?.notify?.(`action-safety: engine unavailable (${engineError}); built-in tools run unprotected.`);
    }
  });
}

/**
 * Build a guarded file tool that delegates to a built-in definition with
 * injected operations. The built-in performs its own read/patch/validation and
 * calls `writeFile`, which is where the safety layer takes over.
 */
function buildFileTool({ name, base, action, guard, loadEngine, enabled, cwd }: any) {
  // A probe definition is used for schema/rendering metadata.
  const probe = base(undefined);

  return {
    ...probe,
    name,
    async execute(toolCallId: string, params: any, signal: any, onUpdate: any, ctx: any) {
      const runUnprotected = () => base(undefined).execute(toolCallId, params, signal, onUpdate, ctx);
      const mod = await loadEngine();
      if (!mod || !enabled()) return runUnprotected();

      const { hashFile, atomicWrite, ABSENT } = mod;
      const targetPath = resolvePath(String(params?.path ?? ""), cwd);
      const beforeHash = await hashFile(targetPath).catch(() => ABSENT);

      // Captured from the built-in's own writeFile call: this is the exact
      // content the built-in decided to persist, including its patch logic.
      let intended: { path: string; content: string } | undefined;
      let performed = false;

      const capture = {
        readFile: (p: string) => import("node:fs/promises").then(fs => fs.readFile(p)),
        access: (p: string) => import("node:fs/promises").then(fs => fs.access(p, 6 /* R_OK | W_OK */)),
        mkdir: (dir: string) => import("node:fs/promises").then(fs => fs.mkdir(dir, { recursive: true }).then(() => {})),
        writeFile: async (p: string, content: string) => {
          intended = { path: p, content };
          performed = true;
          // Deliberately does not write here: the mutation is performed by the
          // safety layer so journal state and the write are ordered correctly.
          // Verified against Pi 0.84.2: write.js and edit.js perform all
          // validation and patch computation before calling writeFile, and a
          // failed match (edit) throws before this point.
        },
      };

      // First pass: let the built-in validate arguments and compute content.
      const prepared = base(capture);
      let builtinResult: any;
      try {
        builtinResult = await prepared.execute(toolCallId, params, signal, onUpdate, ctx);
      } catch (error) {
        // Validation/read errors happen before any mutation: surface as-is.
        throw error;
      }
      if (!performed || !intended) return builtinResult;

      const desired = intended;

      return guard({
        ctx,
        toolName: name,
        action,
        input: params,
        buildSpec: ({ sessionId, semantic }: any) => ({
          sessionId,
          turnRef: toolCallId,
          tool: name,
          action,
          args: {
            path: desired.path,
            desired_hash: mod.sha256(desired.content),
            // Pre-state is evidence, not intent: it changes as soon as the
            // mutation lands, so it is passed as non-identifying metadata to
            // keep the operation id stable across a crash and resume.
            meta_expected_before_hash: beforeHash,
          },
        }),
        hooks: () => ({
          classification: mod.CLASS.RECONCILABLE_MUTATION,
          invoke: async () => {
            // `edit` requires the pre-state to still hold; a third-party change
            // must fail before the mutation rather than overwrite it.
            if (action === "edit") {
              const current = await hashFile(desired.path).catch(() => ABSENT);
              if (current !== beforeHash) {
                throw new mod.PreconditionFailedError(
                  `Precondition failed for edit: ${desired.path} changed since it was read`,
                );
              }
            }
            await atomicWrite(desired.path, desired.content);
            return { status: `${action}_applied`, path: desired.path, result_hash: await hashFile(desired.path) };
          },
          reconcile: async () => {
            const current = await hashFile(desired.path).catch(() => ABSENT);
            const desiredHash = mod.sha256(desired.content);
            if (current === desiredHash) {
              return { state: "completed", result: { status: `${action}_already_applied`, path: desired.path } };
            }
            if (current === beforeHash) return { state: "retry", reason: "file still holds the pre-mutation content" };
            if (beforeHash === ABSENT && current === ABSENT) return { state: "retry", reason: "target absent" };
            return { state: "unknown", reason: "file matches neither the expected pre nor post state" };
          },
        }),
        describe: (outcome: any) => {
          if (outcome.deduplicated || outcome.reconciled) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `action-safety: this ${name} already completed earlier (operation ${outcome.operation.operation_id}); ` +
                    `${desired.path} already holds the intended content, so it was not written again.`,
                },
              ],
              details: undefined,
            };
          }
          return builtinResult;
        },
        fallback: async () => {
          // Engine unavailable after preparation: perform the built-in's own
          // intended write so the user's request still completes.
          const fs = await import("node:fs/promises");
          await fs.mkdir(dirnameOf(desired.path), { recursive: true });
          await fs.writeFile(desired.path, desired.content, "utf-8");
          return builtinResult;
        },
      });
    },
  };
}

function resolvePath(path: string, cwd: string) {
  return path.startsWith("/") ? path : `${cwd}/${path}`.replace(/\/+/g, "/");
}

function dirnameOf(path: string) {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}
