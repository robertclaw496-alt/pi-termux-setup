// Pragmatic classification of shell/file operations for the action-safety layer.
//
// This module deliberately does NOT parse bash grammar. It recognizes a small set
// of well-understood commands and treats anything else as opaque. Opaque means
// "never replayed automatically after an uncertain crash", which is the safe
// direction: a missed automatic recovery costs one question, a wrong replay can
// duplicate an irreversible side effect.

export const CLASS = Object.freeze({
  READ_ONLY: "READ_ONLY",
  SAFE_IDEMPOTENT_LOCAL: "SAFE_IDEMPOTENT_LOCAL",
  RECONCILABLE_MUTATION: "RECONCILABLE_MUTATION",
  OPAQUE: "NON_IDEMPOTENT_OPAQUE",
});

// Shell metacharacters that make a command's effective semantics non-obvious.
// `>>` is checked before `>` because it is a distinct (append) operation.
const COMPOUND = ["&&", "||", ";", "|", "$(", "`", ">>", ">", "<", "&"];
const EVAL_LIKE = ["eval", "xargs", "sh", "bash", "zsh", "source", "."];

const READ_ONLY_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "grep", "rg", "egrep", "fgrep", "find", "fd",
  "ls", "pwd", "stat", "file", "wc", "du", "df", "readlink", "realpath", "basename",
  "dirname", "diff", "cmp", "md5sum", "sha256sum", "sort", "uniq", "cut", "awk", "sed",
  "echo", "printf", "true", "false", "test", "which", "type", "env", "date", "id",
  "whoami", "uname", "ps", "top", "jq", "node", "python", "python3",
]);

// Read-only subcommands for tools whose safety depends on the subcommand.
const SUBCOMMAND_READ_ONLY = {
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "config", "describe", "rev-parse", "ls-files", "blame", "stash"]),
  npm: new Set(["ls", "list", "view", "outdated", "test", "run", "audit", "why"]),
  pip: new Set(["list", "show", "freeze"]),
  pkg: new Set(["list-installed", "search", "show"]),
  apt: new Set(["list", "show", "search"]),
  docker: new Set(["ps", "images", "logs", "inspect"]),
  gh: new Set(["auth", "repo", "pr", "issue", "run"]),
};

const SAFE_IDEMPOTENT = { mkdir: true, chmod: true, chown: true, touch: true, ln: true };
const RECONCILABLE = { cp: true, mv: true, rm: true, rmdir: true, unlink: true, install: true };

// Commands that reach outside this machine or mutate shared state. Their effects
// cannot be inferred from the local filesystem, so they are never auto-replayed.
const REMOTE_MUTATION = new Set(["ssh", "scp", "rsync", "docker", "kubectl", "aws", "gcloud", "az", "terraform", "ansible", "systemctl", "service", "psql", "mysql", "mongo", "redis-cli", "sqlite3"]);

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "pip", "pip3", "apt", "apt-get", "pkg", "brew", "cargo", "go", "gem"]);

function tokenize(command) {
  return String(command).trim().split(/\s+/).filter(Boolean);
}

function hasCompound(command) {
  const text = String(command);
  return COMPOUND.filter(token => text.includes(token));
}

function firstCommandWord(tokens) {
  // Skip leading VAR=value assignments and common no-op prefixes.
  let index = 0;
  while (index < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]) || tokens[index] === "command" || tokens[index] === "exec")) index += 1;
  const word = tokens[index] ?? "";
  return word.replace(/^.*\//, "");
}

function curlMethod(tokens) {
  const upper = tokens.map(token => token.toUpperCase());
  const flagIndex = upper.findIndex(token => token === "-X" || token === "--REQUEST");
  if (flagIndex >= 0 && tokens[flagIndex + 1]) return tokens[flagIndex + 1].toUpperCase();
  if (tokens.some(token => token === "-d" || token === "--data" || token.startsWith("--data-") || token === "-F" || token === "--form" || token === "-T" || token === "--upload-file")) return "POST";
  return "GET";
}

// Classify an HTTP method on its own. Exported so HTTP writes issued outside
// curl (fetch in a helper script, for example) can reuse the same policy.
export function classifyHttpMethod(method, { idempotencyKey = false } = {}) {
  const verb = String(method || "GET").toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") return { classification: CLASS.READ_ONLY, reason: `HTTP ${verb} is read-only` };
  if (idempotencyKey) return { classification: CLASS.RECONCILABLE_MUTATION, reason: `HTTP ${verb} carries a client idempotency key` };
  if (verb === "DELETE") return { classification: CLASS.RECONCILABLE_MUTATION, reason: "HTTP DELETE state can usually be confirmed by a follow-up read" };
  if (verb === "PUT") return { classification: CLASS.OPAQUE, reason: "HTTP PUT is only idempotent when endpoint semantics are known" };
  return { classification: CLASS.OPAQUE, reason: `HTTP ${verb} is potentially non-idempotent without an idempotency key` };
}

function classifyCurl(tokens) {
  const method = curlMethod(tokens);
  const idempotencyKey = tokens.some(token => /idempotency[-_]?key/i.test(token));
  const result = classifyHttpMethod(method, { idempotencyKey });
  return { ...result, http_method: method };
}

function classifyGit(tokens) {
  const sub = tokens.find((token, index) => index > 0 && !token.startsWith("-")) ?? "";
  if (SUBCOMMAND_READ_ONLY.git.has(sub) && !tokens.includes("--hard") && !tokens.includes("-D")) {
    return { classification: CLASS.READ_ONLY, reason: `git ${sub} does not mutate state` };
  }
  if (sub === "add") return { classification: CLASS.SAFE_IDEMPOTENT_LOCAL, reason: "git add is idempotent for the same paths" };
  if (sub === "commit") return { classification: CLASS.RECONCILABLE_MUTATION, reason: "git commit can be reconciled through HEAD and the commit message" };
  if (sub === "push") return { classification: CLASS.RECONCILABLE_MUTATION, reason: "git push can be reconciled by inspecting the remote ref", remote: true };
  if (sub === "clone" || sub === "fetch" || sub === "pull") return { classification: CLASS.RECONCILABLE_MUTATION, reason: `git ${sub} can be re-checked against local refs`, remote: true };
  return { classification: CLASS.OPAQUE, reason: `git ${sub || "(unknown)"} has effects this layer does not model` };
}

function classifyPackageManager(tokens, name) {
  const sub = tokens.find((token, index) => index > 0 && !token.startsWith("-")) ?? "";
  const readOnly = SUBCOMMAND_READ_ONLY[name];
  if (readOnly?.has(sub)) return { classification: CLASS.READ_ONLY, reason: `${name} ${sub} does not mutate installed state` };
  return { classification: CLASS.RECONCILABLE_MUTATION, reason: `${name} ${sub || "(default)"} can be reconciled against installed versions and lockfiles`, package_manager: name };
}

/**
 * Classify a shell command string.
 *
 * Returns { classification, reason, ...hints }. Compound and eval-like commands
 * are forced to OPAQUE even when the leading word looks harmless, because the
 * real effect may live in a later segment or in expanded text.
 */
export function classifyCommand(command) {
  const text = String(command ?? "").trim();
  if (!text) return { classification: CLASS.OPAQUE, reason: "empty command" };

  const tokens = tokenize(text);
  const name = firstCommandWord(tokens);
  const compound = hasCompound(text);

  // `>>` is an append: non-idempotent by nature, so it stays opaque regardless
  // of the leading command.
  if (text.includes(">>")) {
    return { classification: CLASS.OPAQUE, reason: "shell append (>>) can duplicate content on replay", command_name: name, compound };
  }

  if (compound.length > 0) {
    return { classification: CLASS.OPAQUE, reason: `compound shell semantics (${compound.join(" ")}) are not modelled`, command_name: name, compound };
  }

  if (EVAL_LIKE.includes(name)) {
    return { classification: CLASS.OPAQUE, reason: `${name} executes text this layer cannot inspect`, command_name: name, compound };
  }

  if (name === "curl" || name === "wget" || name === "http" || name === "httpie") {
    const result = name === "curl" ? classifyCurl(tokens) : { classification: CLASS.READ_ONLY, reason: `${name} without an explicit write method is treated as a fetch` };
    return { ...result, command_name: name, compound, remote: true };
  }

  if (name === "git") return { ...classifyGit(tokens), command_name: name, compound };
  if (PACKAGE_MANAGERS.has(name)) return { ...classifyPackageManager(tokens, name), command_name: name, compound };
  if (REMOTE_MUTATION.has(name)) {
    const sub = tokens.find((token, index) => index > 0 && !token.startsWith("-")) ?? "";
    if (SUBCOMMAND_READ_ONLY[name]?.has(sub)) return { classification: CLASS.READ_ONLY, reason: `${name} ${sub} is read-only`, command_name: name, compound };
    return { classification: CLASS.OPAQUE, reason: `${name} mutates state outside this machine`, command_name: name, compound, remote: true };
  }

  if (SAFE_IDEMPOTENT[name]) {
    if (name === "mkdir" && !tokens.includes("-p")) return { classification: CLASS.RECONCILABLE_MUTATION, reason: "mkdir without -p fails if the directory exists", command_name: name, compound };
    return { classification: CLASS.SAFE_IDEMPOTENT_LOCAL, reason: `${name} converges to the same state when repeated`, command_name: name, compound };
  }

  if (RECONCILABLE[name]) {
    if (name === "rm" && (tokens.includes("-rf") || tokens.includes("-r") || tokens.includes("-R"))) {
      return { classification: CLASS.RECONCILABLE_MUTATION, reason: "recursive delete is reconcilable by absence but destructive", command_name: name, compound, destructive: true };
    }
    return { classification: CLASS.RECONCILABLE_MUTATION, reason: `${name} can be reconciled from filesystem state`, command_name: name, compound };
  }

  if (READ_ONLY_COMMANDS.has(name)) {
    // node/python/sed/awk are read-only only when nothing is redirected or edited
    // in place; the redirection and -i checks below catch the mutating forms.
    if ((name === "sed" || name === "awk") && tokens.some(token => token === "-i" || token.startsWith("-i"))) {
      return { classification: CLASS.OPAQUE, reason: `${name} -i edits files in place with effects this layer cannot predict`, command_name: name, compound };
    }
    if (name === "node" || name === "python" || name === "python3") {
      return { classification: CLASS.OPAQUE, reason: `${name} runs arbitrary code with unknown side effects`, command_name: name, compound };
    }
    return { classification: CLASS.READ_ONLY, reason: `${name} does not mutate state`, command_name: name, compound };
  }

  return { classification: CLASS.OPAQUE, reason: `unknown command ${name || "(none)"}; treated conservatively`, command_name: name, compound };
}

const FILE_ACTION_CLASS = {
  read: CLASS.READ_ONLY,
  mkdir: CLASS.SAFE_IDEMPOTENT_LOCAL,
  chmod: CLASS.SAFE_IDEMPOTENT_LOCAL,
  write: CLASS.RECONCILABLE_MUTATION,
  edit: CLASS.RECONCILABLE_MUTATION,
  delete: CLASS.RECONCILABLE_MUTATION,
  rename: CLASS.RECONCILABLE_MUTATION,
  move: CLASS.RECONCILABLE_MUTATION,
  copy: CLASS.RECONCILABLE_MUTATION,
  append: CLASS.OPAQUE,
};

/**
 * Classify a structured file operation. Unlike shell strings these carry an
 * explicit action, so only append stays opaque (a replayed append duplicates
 * content unless it is marked, which the file layer handles separately).
 */
export function classifyFileOperation(action) {
  const classification = FILE_ACTION_CLASS[action];
  if (!classification) return { classification: CLASS.OPAQUE, reason: `unknown file action ${action}` };
  const reason = classification === CLASS.OPAQUE
    ? "append is not idempotent; replay would duplicate content"
    : `file ${action} state can be verified after a crash`;
  return { classification, reason, file_action: action };
}

export function requiresJournal(classification) {
  return classification !== CLASS.READ_ONLY;
}
