const TRIGGER_RE = /^\s*(?:пожалуйста[\s,]+)?(?:(быстро|quick|полностью|full|стандартно|standard)\s+)?(?:проверь|проверить|протестируй|протестировать|check|test)\s+(?:эту\s+)?(?:модель|model)(?=\s|$|[:=,;])/iu;

const LABELS = {
  model: new Set(['модель', 'model', 'model_id', 'model-id', 'modelid']),
  key: new Set(['ключ', 'key', 'api_key', 'api-key', 'apikey', 'token', 'токен']),
  site: new Set(['сайт', 'site', 'url', 'base_url', 'base-url', 'baseurl', 'endpoint', 'эндпоинт'])
};

const FILLER = new Set([
  'и', 'and', 'на', 'по', 'для', 'через', 'пожалуйста',
  ...LABELS.model,
  ...LABELS.key,
  ...LABELS.site
]);

const MODEL_PREFIX_RE = /^(?:gpt|chatgpt|o[1-9]|r[1-9]|claude|opus|sonnet|haiku|deepseek|qwen|kimi|glm|minimax|gemini|mistral|mixtral|llama|grok|xai|fable|command|cohere|yi|ernie|doubao|baichuan|hunyuan|internlm|phi|nemotron|qwq|coder|codex)[\w./:-]*$/i;
const KEY_PREFIX_RE = /^(?:sk[-_]|pk[-_]|api[-_]|key[-_]|token[-_]|AIza|hf_|ghp_|github_pat_|gsk_|xai[-_]|nvapi[-_]|sess[-_]|live[-_]|rk[-_])/i;

export function parseNaturalProbeRequest(text) {
  if (typeof text !== 'string') return null;
  const trigger = text.match(TRIGGER_RE);
  if (!trigger) return null;

  const rest = text.slice(trigger[0].length).trim();
  const tokens = tokenize(rest);
  const consumed = new Set();
  const labeled = {};

  for (let index = 0; index < tokens.length; index += 1) {
    const raw = tokens[index];
    const assignment = splitAssignment(raw);
    if (assignment) {
      const kind = labelKind(assignment.label);
      if (kind && assignment.value) {
        labeled[kind] = cleanValue(assignment.value);
        consumed.add(index);
        continue;
      }
    }

    const normalized = normalizeLabel(raw);
    const kind = labelKind(normalized);
    if (!kind) continue;
    const next = tokens[index + 1];
    if (next && !labelKind(normalizeLabel(next))) {
      labeled[kind] = cleanValue(next);
      consumed.add(index);
      consumed.add(index + 1);
      index += 1;
    }
  }

  let site = labeled.site || null;
  let siteIndex = -1;
  if (!site) {
    siteIndex = findBestSiteToken(tokens, consumed);
    if (siteIndex >= 0) {
      site = cleanValue(tokens[siteIndex]);
      consumed.add(siteIndex);
    }
  }
  if (site) site = normalizeSite(site);

  let apiKey = labeled.key || null;
  let keyIndex = -1;
  if (!apiKey) {
    keyIndex = findBestKeyToken(tokens, consumed);
    if (keyIndex >= 0) {
      apiKey = cleanValue(tokens[keyIndex]);
      consumed.add(keyIndex);
    }
  }

  let model = labeled.model || null;
  if (!model) {
    const candidates = tokens
      .map((value, index) => ({ value: cleanValue(value), index }))
      .filter(({ value, index }) => !consumed.has(index) && value && !FILLER.has(normalizeLabel(value)))
      .filter(({ value }) => !looksLikeSite(value) && value !== apiKey);

    const modelCandidate = candidates.find(({ value }) => looksLikeModelId(value)) ||
      (candidates.length === 1 ? candidates[0] : null);
    if (modelCandidate) model = modelCandidate.value;
  }

  const explicitMode = String(trigger[1] || '').toLowerCase();
  let mode = ['быстро', 'quick'].includes(explicitMode) ? 'quick'
    : ['стандартно', 'standard'].includes(explicitMode) ? 'standard'
      : 'full';

  if (/\b(?:быстро|quick)\b/iu.test(rest)) mode = 'quick';
  if (/\b(?:стандартно|standard)\b/iu.test(rest)) mode = 'standard';
  if (/\b(?:полностью|full)\b/iu.test(rest)) mode = 'full';

  const missing = [];
  if (!model) missing.push('model');
  if (!apiKey) missing.push('api_key');
  if (!site) missing.push('site');

  return {
    matched: true,
    mode,
    model: model ? stripTrailingPunctuation(model) : null,
    apiKey: apiKey ? stripTrailingPunctuation(apiKey) : null,
    site: site ? stripTrailingPunctuation(site) : null,
    missing,
    complete: missing.length === 0
  };
}

export function requestHelpText(missing = []) {
  const names = {
    model: 'ID модели',
    api_key: 'API-ключ',
    site: 'сайт или Base URL'
  };
  const missingText = missing.length
    ? `Не хватает: ${missing.map((item) => names[item] || item).join(', ')}.\n\n`
    : '';
  return `${missingText}Отправь одной строкой:\n\nПроверь модель <MODEL_ID> <API_KEY> <SITE_OR_BASE_URL>\n\nПример:\nПроверь модель deepseek-v4-flash sk-xxxxx https://api.example.com/v1\n\nДля короткой проверки: Быстро проверь модель <MODEL_ID> <API_KEY> <URL>`;
}

export function redactSecret(value, secret) {
  if (!secret || typeof value !== 'string') return value;
  return value.split(secret).join('[API_KEY_REDACTED]');
}

function tokenize(text) {
  const tokens = [];
  let current = '';
  let quote = null;
  let escaped = false;

  for (const character of text) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function splitAssignment(token) {
  const match = String(token).match(/^([^:=]+)[:=](.+)$/u);
  if (!match) return null;
  return { label: normalizeLabel(match[1]), value: match[2] };
}

function normalizeLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^[,;]+|[:,;=]+$/g, '')
    .replace(/\s+/g, '_');
}

function labelKind(value) {
  const normalized = normalizeLabel(value);
  for (const [kind, labels] of Object.entries(LABELS)) {
    if (labels.has(normalized)) return kind;
  }
  return null;
}

function cleanValue(value) {
  return String(value || '')
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .trim();
}

function stripTrailingPunctuation(value) {
  return String(value).replace(/[),;]+$/g, '');
}

function normalizeSite(value) {
  const cleaned = stripTrailingPunctuation(cleanValue(value));
  if (/^https?:\/\//i.test(cleaned)) return cleaned;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(cleaned)) {
    return `http://${cleaned}`;
  }
  return `https://${cleaned.replace(/^\/\//, '')}`;
}

function findBestSiteToken(tokens, consumed) {
  let fallback = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    if (consumed.has(index)) continue;
    const value = cleanValue(tokens[index]);
    if (/^https?:\/\//i.test(value)) return index;
    if (fallback < 0 && looksLikeSite(value)) fallback = index;
  }
  return fallback;
}

function looksLikeSite(value) {
  const cleaned = stripTrailingPunctuation(cleanValue(value));
  if (/^https?:\/\//i.test(cleaned)) return true;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(cleaned)) return true;
  return /^(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z]{2,24}(?::\d+)?(?:\/[^\s]*)?$/i.test(cleaned);
}

function findBestKeyToken(tokens, consumed) {
  let best = { index: -1, score: -Infinity };
  for (let index = 0; index < tokens.length; index += 1) {
    if (consumed.has(index)) continue;
    const value = stripTrailingPunctuation(cleanValue(tokens[index]));
    const score = scoreApiKey(value);
    if (score > best.score) best = { index, score };
  }
  return best.score >= 4 ? best.index : -1;
}

function scoreApiKey(value) {
  if (!value || value.length < 8 || looksLikeSite(value)) return -Infinity;
  const normalized = normalizeLabel(value);
  if (FILLER.has(normalized)) return -Infinity;

  let score = 0;
  if (KEY_PREFIX_RE.test(value)) score += 8;
  if (value.length >= 16) score += 2;
  if (value.length >= 24) score += 2;
  if (value.length >= 40) score += 1;
  if (/[a-z]/i.test(value) && /\d/.test(value)) score += 1;
  if (/[-_.]/.test(value)) score += 1;
  if (/^[A-Za-z0-9._~+\/-]+$/.test(value)) score += 1;
  if (MODEL_PREFIX_RE.test(value)) score -= 8;
  if (/^[a-z][\w.-]{1,80}\/[\w./:-]+$/i.test(value)) score -= 4;
  return score;
}

function looksLikeModelId(value) {
  if (!value || value.length > 200 || KEY_PREFIX_RE.test(value) || looksLikeSite(value)) return false;
  if (MODEL_PREFIX_RE.test(value)) return true;
  if (/^[A-Za-z0-9][A-Za-z0-9._:-]{1,120}$/.test(value) && /[-_.:]/.test(value)) return true;
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/-]+$/.test(value)) return true;
  return false;
}
