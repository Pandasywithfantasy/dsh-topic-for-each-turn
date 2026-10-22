import { createHash } from 'node:crypto';
export const CONTINUITY_VERSION = 1;
export const RELATIONS = ['continue', 'return', 'branch'];
const clean = (value, max) => {
  if (typeof value !== 'string') throw new Error('事项名称必须是文本');
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text || [...text].length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('事项名称无效');
  return text;
};
export function subject(name, seq) {
  name = clean(name, 16);
  return { id: 's-' + createHash('sha256').update(`${seq}:${name}`).digest('hex').slice(0, 16), name };
}
export function validItems(turns, items) {
  return items.filter(i => turns.some(t => t.seq === i.seq && t.fingerprint === i.fingerprint));
}
export function contextFor(turn, turns, items, enabled = true) {
  if (!enabled) return { enabled: false, history: [], subjects: [] };
  const earlier = turns.filter(t => t.seq < turn.seq && t.turn < turn.turn);
  const valid = validItems(earlier, items).sort((a,b) => a.seq - b.seq);
  const bySeq = new Map(valid.map(i => [i.seq, i]));
  const selected = new Map();
  const add = i => { if (i && selected.size < 12) selected.set(i.seq, i); };
  // Explicit references take priority over recency. Never include future rounds.
  for (const match of turn.input.question.matchAll(/第\s*(\d+)\s*轮/g)) add(valid.find(i => i.turn === Number(match[1])));
  for (const t of earlier.slice(-6)) add(bySeq.get(t.seq));
  const subjects = new Map();
  for (const i of [...valid].reverse()) for (const s of i.subjects ?? []) {
    if (subjects.size < 12 && !subjects.has(s.id)) subjects.set(s.id, { ...s, lastTurn: i.turn });
  }
  // Include the latest representative of each retained subject, within the cap.
  for (const s of subjects.values()) add([...valid].reverse().find(i => i.subjects?.some(x => x.id === s.id)));
  // Local exact-name retrieval is only a candidate hint, not evidence of a relation.
  for (const i of [...valid].reverse()) if (i.subjects?.some(s => turn.input.question.includes(s.name))) add(i);
  return { enabled: true, previousTurn: earlier.at(-1)?.turn ?? null,
    history: [...selected.values()].sort((a,b) => a.seq - b.seq).map(i => ({ seq: i.seq, turn: i.turn, topic: i.topic, summary: i.summary.slice(0, 100), subjects: i.subjects ?? [], revision: i.updatedAt, fingerprint: i.fingerprint })),
    subjects: [...subjects.values()] };
}
export function normalizeContinuity(value, context, turn) {
  const subjects = [];
  if (context.enabled && Array.isArray(value.subjects)) for (const candidate of value.subjects.slice(0, 2)) {
    try {
      const existing = context.subjects.find(s => s.id === candidate?.id);
      const named = candidate?.name && context.subjects.find(s => s.name === candidate.name.trim());
      const s = existing ?? named ?? subject(candidate?.name, turn.seq);
      if (!subjects.some(x => x.id === s.id)) subjects.push({ id: s.id, name: s.name });
    } catch { /* malformed auxiliary fields do not discard the summary */ }
  }
  let relation = null;
  const proposed = value.relation;
  const target = context.history.find(i => i.seq === proposed?.seq);
  if (context.enabled && target && target.seq < turn.seq && target.turn < turn.turn && RELATIONS.includes(proposed.kind)) {
    relation = { seq: target.seq, turn: target.turn, kind: proposed.kind, fingerprint: target.fingerprint, revision: target.revision };
  }
  return { subjects, relation, continuityVersion: context.enabled ? CONTINUITY_VERSION : 0,
    contextSnapshot: context.history.map(i => ({ seq: i.seq, revision: i.revision, fingerprint: i.fingerprint })) };
}
export function visibleRelation(item, turns, items) {
  const r = item?.relation;
  if (!r) return { relation: null, relationChanged: false };
  const targetTurn = turns.find(t => t.seq === r.seq && t.turn === r.turn && t.seq < item.seq && t.turn < item.turn);
  const target = items.find(i => i.seq === r.seq && i.fingerprint === targetTurn?.fingerprint);
  const changed = !target || target.fingerprint !== r.fingerprint || target.updatedAt !== r.revision;
  return { relation: changed ? null : { seq: r.seq, turn: r.turn, kind: r.kind }, relationChanged: changed };
}
