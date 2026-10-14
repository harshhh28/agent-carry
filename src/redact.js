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
    /\b([A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*)(\s*[=:]\s*)(['"]?)[^\s'"]{8,}\3/g,
    (_m, name, sep, q) => `${name}${sep}${q}[REDACTED:env-secret]${q}`,
  ],
  [
    'json-secret',
    /("[A-Za-z_]*(?:secret|token|password|passwd|api_?key|private_?key)[A-Za-z_]*"\s*:\s*")[^"]{8,}(")/gi,
    (_m, a, b) => `${a}[REDACTED:json-secret]${b}`,
  ],
];

const EMAIL = ['email', /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, () => '[REDACTED:email]'];

export function makeRedactor({ emails = false } = {}) {
  const rules = emails ? [...RULES, EMAIL] : RULES;
  const counts = {};
  const fn = (s) => {
    let out = s;
    for (const [kind, re, rep] of rules) {
      out = out.replace(re, (...a) => {
        counts[kind] = (counts[kind] || 0) + 1;
        return rep(...a);
      });
    }
    return out;
  };
  return { fn, counts, apply: (value) => mapStrings(value, fn) };
}
