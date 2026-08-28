// Command-line sanitization. Shell commands frequently carry credentials as
// arguments, so nothing reaches the journal or logs before passing through here.

const REPLACEMENT = "REDACTED";

const PATTERNS = [
  // Header-style credentials: -H "Authorization: Bearer xyz". The scheme is kept
  // for readability but the token itself must go, including when the scheme and
  // token are both present (an earlier version redacted only the scheme).
  [/((?:authorization|proxy-authorization)\s*:\s*)(?:bearer|basic|token)?\s*[^"'\s]+/gi, `$1${REPLACEMENT}`],
  [/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REPLACEMENT}`],
  // Cookies and set-cookie headers.
  [/((?:set-)?cookie\s*:\s*)[^"'\n]+/gi, `$1${REPLACEMENT}`],
  // key=value and key: value forms for sensitive names.
  [/\b(api[_-]?key|api[_-]?hash|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|client[_-]?secret|secret[_-]?key|secret|password|passwd|pwd|token|credential|private[_-]?key|session[_-]?string)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&|)"']+)/gi, `$1$2${REPLACEMENT}`],
  // Sensitive names followed by a bare value: `aws_secret_access_key wJalr...`,
  // `set client_secret abc`. Without this, CLI tools that take the value as a
  // positional argument leak it.
  [/\b((?:aws[_-]?)?(?:secret[_-]?access[_-]?key|access[_-]?key[_-]?id|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|password|passwd|token|secret))\s+("[^"]*"|'[^']*'|[A-Za-z0-9._~+/=-]{6,})/gi, `$1 ${REPLACEMENT}`],
  // CLI flags that take a credential value.
  [/(--(?:password|token|api-key|apikey|secret|access-token|auth-token|client-secret)(?:\s+|=))("[^"]*"|'[^']*'|[^\s]+)/gi, `$1${REPLACEMENT}`],
  [/(-u\s+)[^\s:]+:[^\s]+/g, `$1${REPLACEMENT}`],
  // Key/identity file paths: `ssh -i /home/u/.ssh/id_rsa`. The path itself is
  // sensitive because it names the credential in use.
  [/(-i\s+)("[^"]*"|'[^']*'|[^\s]*(?:id_[a-z0-9]+|\.pem|\.key|\.ppk)[^\s]*)/gi, `$1${REPLACEMENT}`],
  [/[^\s"']*\/\.ssh\/[^\s"']+/g, REPLACEMENT],
  // Credentials embedded in URLs: https://user:pass@host
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REPLACEMENT}@`],
  // Query-string credentials.
  [/([?&](?:api[_-]?key|access[_-]?token|token|key|secret|password)=)[^&\s"']+/gi, `$1${REPLACEMENT}`],
  // Standalone high-entropy credential shapes (provider keys, PATs, JWTs).
  [/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|AIza|ya29|glpat)[-_][A-Za-z0-9_-]{10,}/g, REPLACEMENT],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, REPLACEMENT],
  // PEM private key blocks.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REPLACEMENT],
  [/\b(ssh-rsa|ssh-ed25519)\s+[A-Za-z0-9+/=]{20,}/g, `$1 ${REPLACEMENT}`],
];

/**
 * Redact credential-shaped content from a command string. Truncates the result
 * so a long inline payload cannot bloat or leak through the journal.
 */
export function sanitizeCommand(command, { maxLength = 400 } = {}) {
  let text = String(command ?? "");
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  // Heredocs can carry arbitrary payloads; keep only the opening line.
  text = text.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*/g, "<<$1 REDACTED_HEREDOC");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…[truncated]` : text;
}

/**
 * Normalize a command for identity purposes: collapse whitespace so cosmetic
 * differences do not create a second operation id for the same logical action.
 */
export function normalizeCommand(command) {
  return String(command ?? "").replace(/\s+/g, " ").trim();
}

export function sanitizeOutput(text, { maxLength = 300 } = {}) {
  return sanitizeCommand(text, { maxLength });
}
