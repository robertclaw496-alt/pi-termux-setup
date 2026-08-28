import assert from "node:assert/strict";
import test from "node:test";
import { CLASS, classifyCommand, classifyFileOperation, classifyHttpMethod, requiresJournal } from "../classify.mjs";
import { normalizeCommand, sanitizeCommand } from "../sanitize.mjs";

const cls = command => classifyCommand(command).classification;

test("read-only commands are classified without journal overhead", () => {
  for (const command of ["cat file.txt", "grep -n foo src", "ls -la", "pwd", "git status", "git log --oneline", "wc -l a.txt", "jq . data.json"]) {
    assert.equal(cls(command), CLASS.READ_ONLY, command);
    assert.equal(requiresJournal(cls(command)), false, command);
  }
});

test("idempotent local commands are safe to repeat", () => {
  assert.equal(cls("mkdir -p /tmp/a/b"), CLASS.SAFE_IDEMPOTENT_LOCAL);
  assert.equal(cls("chmod 600 /tmp/a"), CLASS.SAFE_IDEMPOTENT_LOCAL);
  assert.equal(cls("touch /tmp/a"), CLASS.SAFE_IDEMPOTENT_LOCAL);
});

test("mkdir without -p is not idempotent", () => {
  assert.equal(cls("mkdir /tmp/a"), CLASS.RECONCILABLE_MUTATION);
});

test("filesystem mutations are reconcilable", () => {
  for (const command of ["cp a b", "mv a b", "rm a", "rmdir d"]) {
    assert.equal(cls(command), CLASS.RECONCILABLE_MUTATION, command);
  }
});

test("recursive delete is flagged destructive", () => {
  const info = classifyCommand("rm -rf /tmp/scratch");
  assert.equal(info.classification, CLASS.RECONCILABLE_MUTATION);
  assert.equal(info.destructive, true);
});

test("compound and eval-like shell is forced opaque", () => {
  for (const command of ["cat a && rm b", "ls | xargs rm", "echo x; rm y", "eval \"$CMD\"", "bash -c 'rm x'", "sh -c 'ls'", "cat $(cat list)", "rm `cat list`"]) {
    assert.equal(cls(command), CLASS.OPAQUE, command);
  }
});

test("shell append is opaque even for otherwise safe commands", () => {
  assert.equal(cls("echo line >> /tmp/log"), CLASS.OPAQUE);
  assert.match(classifyCommand("echo line >> /tmp/log").reason, /append/i);
});

test("redirection and in-place edits are opaque", () => {
  assert.equal(cls("echo x > /tmp/f"), CLASS.OPAQUE);
  assert.equal(cls("sed -i s/a/b/ file"), CLASS.OPAQUE);
});

test("interpreters running arbitrary code are opaque", () => {
  assert.equal(cls("node script.mjs"), CLASS.OPAQUE);
  assert.equal(cls("python3 helper.py"), CLASS.OPAQUE);
});

test("unknown commands default to opaque", () => {
  assert.equal(cls("frobnicate --all"), CLASS.OPAQUE);
});

test("curl is classified by HTTP method", () => {
  assert.equal(cls("curl https://example.com/data"), CLASS.READ_ONLY);
  assert.equal(cls("curl -X POST https://example.com/api"), CLASS.OPAQUE);
  assert.equal(cls("curl -d name=x https://example.com/api"), CLASS.OPAQUE);
  assert.equal(cls("curl -X PUT https://example.com/api/1"), CLASS.OPAQUE);
  assert.equal(cls("curl -X DELETE https://example.com/api/1"), CLASS.RECONCILABLE_MUTATION);
});

test("an idempotency key upgrades a POST to reconcilable", () => {
  assert.equal(cls("curl -X POST -H Idempotency-Key:abc https://example.com/pay"), CLASS.RECONCILABLE_MUTATION);
  assert.equal(classifyHttpMethod("POST", { idempotencyKey: true }).classification, CLASS.RECONCILABLE_MUTATION);
  assert.equal(classifyHttpMethod("POST").classification, CLASS.OPAQUE);
  assert.equal(classifyHttpMethod("GET").classification, CLASS.READ_ONLY);
});

test("git subcommands are split by effect", () => {
  assert.equal(cls("git status"), CLASS.READ_ONLY);
  assert.equal(cls("git add src"), CLASS.SAFE_IDEMPOTENT_LOCAL);
  assert.equal(cls("git commit -m x"), CLASS.RECONCILABLE_MUTATION);
  assert.equal(cls("git push origin main"), CLASS.RECONCILABLE_MUTATION);
  assert.equal(classifyCommand("git push origin main").remote, true);
});

test("remote and infrastructure mutations are opaque", () => {
  for (const command of ["ssh host rm -rf /data", "scp a host:/b", "rsync -a a host:/b", "kubectl apply -f x.yaml", "psql -c 'INSERT INTO t VALUES (1)'"]) {
    assert.equal(cls(command), CLASS.OPAQUE, command);
  }
});

test("package managers are reconcilable against installed state", () => {
  assert.equal(cls("npm install"), CLASS.RECONCILABLE_MUTATION);
  assert.equal(cls("pip install requests"), CLASS.RECONCILABLE_MUTATION);
  assert.equal(cls("npm ls"), CLASS.READ_ONLY);
});

test("file operations map to their recovery class", () => {
  assert.equal(classifyFileOperation("read").classification, CLASS.READ_ONLY);
  assert.equal(classifyFileOperation("write").classification, CLASS.RECONCILABLE_MUTATION);
  assert.equal(classifyFileOperation("edit").classification, CLASS.RECONCILABLE_MUTATION);
  assert.equal(classifyFileOperation("rename").classification, CLASS.RECONCILABLE_MUTATION);
  assert.equal(classifyFileOperation("delete").classification, CLASS.RECONCILABLE_MUTATION);
  assert.equal(classifyFileOperation("mkdir").classification, CLASS.SAFE_IDEMPOTENT_LOCAL);
  assert.equal(classifyFileOperation("append").classification, CLASS.OPAQUE);
});

test("command sanitization removes credentials of every shape", () => {
  const cases = [
    ['curl -H "Authorization: Bearer sk-abcdef1234567890" https://api.example.com', /sk-abcdef1234567890/],
    ["curl -H 'Cookie: session=abc123def456' https://x", /abc123def456/],
    ["deploy --token=ghp_abcdefghijklmnopqrst", /ghp_abcdefghijklmnopqrst/],
    ["psql postgres://user:s3cr3tpass@host/db", /s3cr3tpass/],
    ["curl 'https://api.x/v1?api_key=verysecretvalue'", /verysecretvalue/],
    ["export API_KEY=supersecret123 && run", /supersecret123/],
    ["curl -u admin:hunter2 https://x", /hunter2/],
    ["login --password 'p@ssw0rd!'", /p@ssw0rd/],
  ];
  for (const [command, leak] of cases) {
    const sanitized = sanitizeCommand(command);
    assert.doesNotMatch(sanitized, leak, command);
    assert.match(sanitized, /REDACTED/, command);
  }
});

test("sanitization drops heredoc payloads and bounds length", () => {
  const sanitized = sanitizeCommand("cat <<EOF\nsecret payload line\nEOF");
  assert.doesNotMatch(sanitized, /secret payload line/);
  assert.ok(sanitizeCommand("x".repeat(5000)).length <= 420);
});

test("normalization collapses cosmetic whitespace only", () => {
  assert.equal(normalizeCommand("  ls   -la  "), "ls -la");
  assert.notEqual(normalizeCommand("ls -la"), normalizeCommand("ls -l"));
});
