import { mapStrings } from './portable.js';

/**
 * Secret scrubbing for text that is about to leave the machine. Deliberately
 * pattern-based and conservative: it removes well-known credential shapes, it
 * does not promise to find every secret. The export report says how many were
 * removed so the user can judge, and `carry inspect` shows what a bundle holds.
 */
const RULES = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, () => '[REDACTED:private-key]'],
  ['anthropic-key', /sk-ant-[A-Za-z0-9_-]{20,}/g, () => '[REDACTED:anthropic-key]'],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g, () => '[REDACTED:openai-key]'],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/g, () => '[REDACTED:github-token]'],
  ['aws-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, () => '[REDACTED:aws-key]'],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/g, () => '[REDACTED:google-key]'],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, () => '[REDACTED:slack-token]'],
  ['stripe-key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, () => '[REDACTED:stripe-key]'],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => '[REDACTED:jwt]'],
  ['bearer', /(\bBearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g, (_m, p) => `${p}[REDACTED:bearer]`],
  ['url-credentials', /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]{3,}(@)/gi, (_m, a, b) => `${a}[REDACTED:password]${b}`],
  [
    'env-secret',
    // Name may follow an ANSI colour code directly ("\x1b[31mDB_PASSWORD=..."), where \b would not fire.
    /(?:(?<![A-Za-z0-9_])|(?<=(?:\x1b|u001b)\[[0-9;]*m))([A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Za-z0-9_]*)(\s*[=:]\s*)(['"]?)(?!\[REDACTED)[^\s'"\\\x1b]{8,}\3/gi,
    (m, name, sep, q, offset, whole) => {
      // ALL_CAPS is env-var style: always redact. Mixed or lower case is often code (`max_tokens`,
      // `token = parseToken(x)`), so there the value must look like a credential, not an identifier.
      if (name !== name.toUpperCase()) {
        const value = m.slice(name.length + sep.length + q.length, m.length - q.length);
        if (/tokens|count|hash|limit|budget|usage|type|len/i.test(name)) return m;
        if (!/[0-9]/.test(value) || /[()<>{}]/.test(value)) return m;
      }
      return `${name}${sep}${q}[REDACTED:env-secret]${q}`;
    },
  ],
  [
    'json-secret',
    // Tolerates any number of escaping backslashes: a JSON document stored inside a JSON string, and so on.
    /(\\*"[A-Za-z_]*(?:secret|token|password|passwd|api_?key|private_?key)[A-Za-z_]*\\*"\s*:\s*\\*")(?!\[REDACTED)[^"\\]{8,}(\\*")/gi,
    (_m, a, b) => `${a}[REDACTED:json-secret]${b}`,
  ],
];

/** Base64 blobs are only redacted when they decode to text that the rules above would redact. */
const looksPrintable = (t) => t.length > 0 && [...t].filter((c) => c >= ' ' && c <= '~' || c === '\n' || c === '\t').length / t.length > 0.95;
const BASE64 = [
  'base64-secret',
  /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{24,}={0,2}(?![A-Za-z0-9+/=])/g,
  (m) => {
    let decoded;
    try {
      decoded = Buffer.from(m, 'base64').toString('utf8');
    } catch {
      return m;
    }
    if (!looksPrintable(decoded)) return m;
    const changed = RULES.some(([, re, rep]) => decoded.replace(re, rep) !== decoded);
    return changed ? '[REDACTED:base64-secret]' : m;
  },
];

const EMAIL = ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => '[REDACTED:email]'];

export function makeRedactor({ emails = false } = {}) {
  const rules = emails ? [...RULES, BASE64, EMAIL] : [...RULES, BASE64];
  const counts = {};
  const fn = (s) => {
    let out = s;
    for (const [kind, re, rep] of rules) {
      out = out.replace(re, (...a) => {
        const r = rep(...a);
        if (r !== a[0]) counts[kind] = (counts[kind] || 0) + 1;
        return r;
      });
    }
    return out;
  };
  return { fn, counts, apply: (value) => mapStrings(value, fn) };
}
