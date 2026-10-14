import { recordKey } from './transcript.js';

/**
 * Union of two transcripts keyed by record identity. The local file is the
 * source of truth: its lines are kept byte for byte and in order, and records
 * that only exist in the incoming copy are appended. A session that continued
 * on two machines therefore becomes a DAG with two branches, which is exactly
 * what it is, and merging the same bundle twice changes nothing.
 */
export function mergeEntries(local, incoming) {
  const localKeys = new Set(local.map(recordKey));
  const lines = local.map((e) => e.raw);
  const seenUuid = new Set();
  let added = 0;
  for (const e of incoming) {
    const k = recordKey(e);
    if (localKeys.has(k)) continue;
    // Conversation records are unique by uuid. Bookkeeping records (mode,
    // last-prompt, ...) have no identity and their *order* carries meaning
    // (the last one wins), so repeats inside the incoming copy are kept.
    if (k.startsWith('u:')) {
      if (seenUuid.has(k)) continue;
      seenUuid.add(k);
    }
    lines.push(e.raw);
    added++;
  }
  return { lines, added, kept: local.length, skipped: incoming.length - added };
}
