#!/usr/bin/env node
// gitpp-intent-ledger — an append-only INTENT LEDGER for git.pp nudges.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GAP THIS FILLS
//
//   spec §5.6  made nudging reliably EXPRESSIBLE  (parent on the setter).
//   gitpp-nudge made it VERIFIABLE after the fact  (did it land? yes/no).
//   gitpp-gate  asks "should this apply at all?" before writing, and fails
//               closed when the model gives no signal.
//
// None of them record what was INTENDED versus what OUTCOME was, over time.
//
// A nudge can land and still be wrong. A gate can be miscalibrated. A gate can
// authorise a nudge against a state that a later override has already
// invalidated — the authorisation was real, the world it authorised for is
// gone. Nothing in the substrate today compares intention to outcome across a
// history. That is the ledger's job, and only the ledger's job.
//
// THE ONE CASE THAT MATTERS:
//
//   override-0007 lands in the record set. Nobody proposed it. No gate saw
//   it. No ledger entry mentions it. It is in `setters`. It is in state. It
//   won by class precedence, so the fold is *right* and the system is
//   *wrong*. Nothing else can see this, because the fold is pure and has no
//   idea what anybody meant.
//
// THE SHAPE OF THE THING
//
//   ledger : append-only, hash-chained sequence of entries (JSONL on disk)
//            entry kinds: intent | decision | approval | override | observed
//   check  : (ledger, record set) -> findings + exit code
//
//   The check RE-DERIVES every outcome by folding the record set. It never
//   trusts the ledger's own claims about landing — it compares them. A ledger
//   entry is a claim; the fold is the referee. When they disagree, that
//   disagreement is itself a finding (OUTCOME_CLAIM_FALSE).
//
//   No network. No TYPESAFE_AI_TOKEN. Stdlib only. Node 18+.
//
// ─────────────────────────────────────────────────────────────────────────────

import { createHash } from "node:crypto";

export const VERSION = "0.1.0";

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 0 — canonical form and hashing
//
// The spec pins a byte-exact leaf encoding for RECORDS (§2, §3). That is the
// substrate's problem, not ours; we never reimplement it. What we need is our
// own deterministic serialisation so that the ledger's chain hashes are stable
// across machines and runs. Sorted keys, no whitespace. Stated here because a
// hash chain whose canonical form is unstated is not a hash chain.
// ═══════════════════════════════════════════════════════════════════════════

export const GENESIS = "0".repeat(64);

/** Deterministic JSON: object keys sorted by code point, no whitespace. */
export function canon(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort(cmpCodePoint);
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
}

export function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Unicode code-point order. NOT localeCompare — spec §5.4. */
export function cmpCodePoint(a, b) {
  const A = Array.from(String(a));
  const B = Array.from(String(b));
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i].codePointAt(0);
    const y = B[i].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return A.length - B.length;
}

/** Value equality by canonical form. Used for "did the value actually change". */
export function sameValue(a, b) {
  return canon(a) === canon(b);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — THE FOLD (git.pp spec §5)
//
// gitpp-doctor is the Python reference for derive(). This PoC could not reach
// it (private to the author's token), so the fold is reimplemented here from
// the spec text. It is deliberately NOT advertised as conformant — it is a
// faithful reading of §5.1–§5.6, and the deviations are listed at the bottom
// of this section so they can be checked against the referee.
//
// derive(records) -> { state, setters, order, conflicts, orphans, ... }
// ═══════════════════════════════════════════════════════════════════════════

/** §5.1 class precedence, absolute: override > task > witness. */
const CLASS = { override: 3, task: 2, witness: 1 };

/** Unknown kinds are accepted by the spec but semantically out of scope. Lowest. */
export function classOf(kind) {
  return Object.prototype.hasOwnProperty.call(CLASS, kind) ? CLASS[kind] : 0;
}

/**
 * §1.1. `id` is required; the other four default when absent. A field that is
 * PRESENT but of the wrong type is malformed — the fold excludes it and says
 * so, rather than guessing.
 */
function normaliseRecord(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return { ok: false, why: "not an object" };
  if (typeof r.id !== "string" || r.id.length === 0) return { ok: false, why: "missing or non-string id" };
  if (r.id.includes("\n") || r.id.includes(":")) return { ok: false, why: "id contains a reserved delimiter" };
  let parents = [];
  if (r.parents !== undefined && r.parents !== null) {
    if (!Array.isArray(r.parents)) return { ok: false, why: "parents is not an array" };
    if (r.parents.some((p) => typeof p !== "string")) return { ok: false, why: "parents holds a non-string" };
    parents = [...new Set(r.parents)].sort(cmpCodePoint);
  }
  if (r.kind !== undefined && r.kind !== null && typeof r.kind !== "string") return { ok: false, why: "bad kind" };
  if (r.effects !== undefined && r.effects !== null) {
    if (typeof r.effects !== "object" || Array.isArray(r.effects)) return { ok: false, why: "effects is not an object" };
  }
  if (r.reason !== undefined && r.reason !== null && typeof r.reason !== "string") return { ok: false, why: "bad reason" };
  return {
    ok: true,
    rec: {
      id: r.id,
      parents,
      kind: r.kind ?? null,
      effects: r.effects ?? {},
      reason: r.reason ?? null,
    },
  };
}

export function validateRecord(r) {
  return normaliseRecord(r);
}

/**
 * THE FOLD. Pure function of the record set. §5.
 */
export function derive(records, opts = {}) {
  const tieBreak = opts.tieBreak ?? "asc"; // "asc" | "desc" — only "desc" is for the self-check

  // ---- index ---------------------------------------------------------------
  const byId = new Map();
  const malformed = [];
  const shadowed = [];
  for (const raw of records ?? []) {
    const v = normaliseRecord(raw);
    if (!v.ok) {
      malformed.push({ id: raw?.id ?? null, why: v.why });
      continue;
    }
    // §9: the collection pipeline owns deduplication. If a same-id pair shows
    // up anyway, last wins and we NAME it — silently taking the last one is
    // exactly the kind of quiet behaviour a ledger exists to remove.
    if (byId.has(v.rec.id)) shadowed.push(v.rec.id);
    byId.set(v.rec.id, v.rec);
  }

  // ---- §5.5 orphans: any parent not present in the set ----------------------
  const missingParent = new Map();
  for (const [id, r] of byId) {
    const missing = r.parents.filter((p) => !byId.has(p));
    if (missing.length) missingParent.set(id, missing);
  }

  // ---- §5.4 order: Kahn, smallest-id-first, cycle-affected excluded ---------
  const nodes = [...byId.keys()].filter((id) => !missingParent.has(id)).sort(cmpCodePoint);
  const indeg = new Map(nodes.map((id) => [id, 0]));
  const children = new Map(nodes.map((id) => [id, []]));
  for (const id of nodes) {
    for (const p of byId.get(id).parents) {
      if (!byId.has(p) || missingParent.has(p)) continue;
      children.get(p).push(id);
      indeg.set(id, indeg.get(id) + 1);
    }
  }
  // Ready set kept sorted by code point at every step: this is "smallest-id
  // first" read as the lexicographically smallest topological order, which is
  // what "ties broken by Unicode code point" means inside Kahn's algorithm.
  const ready = nodes.filter((id) => indeg.get(id) === 0);
  ready.sort(tieBreak === "desc" ? (a, b) => -cmpCodePoint(a, b) : cmpCodePoint);
  const order = [];
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const c of children.get(id)) {
      indeg.set(c, indeg.get(c) - 1);
      if (indeg.get(c) === 0) {
        ready.push(c);
        ready.sort(tieBreak === "desc" ? (a, b) => -cmpCodePoint(a, b) : cmpCodePoint);
      }
    }
  }
  // Anything Kahn could not reach is cycle-affected (a cycle member, or a
  // descendant of one). §5.5: excluded from the fold AND reported as orphans.
  const cycleAffected = nodes.filter((id) => !order.includes(id));

  const orphans = [
    ...[...missingParent.entries()].map(([id, missing]) => ({ id, why: "missing-parent", missing })),
    ...cycleAffected.map((id) => ({ id, why: "cycle-affected", missing: [] })),
  ].sort((a, b) => cmpCodePoint(a.id, b.id));

  const orphanIds = new Set(orphans.map((o) => o.id));
  const applied = order.map((id) => byId.get(id));

  // ---- ancestry, cycle-safe ------------------------------------------------
  // §5.2 tie-break: within a class, the MORE DERIVED record wins. A candidate
  // is dominated when it is an ANCESTOR of another candidate. Note the
  // direction — the spec calls out four ports that asked the inverse question
  // and silently reversed every contested key in a chain.
  const ancCache = new Map();
  function ancestorsOf(id) {
    if (ancCache.has(id)) return ancCache.get(id);
    const seen = new Set();
    const stack = [...byId.get(id).parents];
    while (stack.length) {
      const p = stack.pop();
      if (p === undefined || seen.has(p)) continue;
      seen.add(p);
      const pr = byId.get(p);
      if (pr) stack.push(...pr.parents);
    }
    const s = seen;
    ancCache.set(id, s);
    return s;
  }

  // ---- §5.2 streaming per-key resolution -----------------------------------
  const state = {};
  const setters = {}; // §5.6 — for EVERY key in state, not only contested ones
  const setterClass = {};
  const loserOf = new Map(); // key -> Map(id -> value) every record that lost K
  const valuesFor = new Map(); // key -> Set(canon(value)) across ALL candidates

  for (const r of applied) {
    const cR = classOf(r.kind);
    for (const [k, v] of Object.entries(r.effects)) {
      if (!valuesFor.has(k)) valuesFor.set(k, new Set());
      valuesFor.get(k).add(canon(v));

      const cur = setters[k];
      if (cur === undefined) {
        setters[k] = r.id;
        state[k] = v;
        setterClass[k] = cR;
        continue;
      }
      const cC = setterClass[k];
      let rWins;
      if (cR > cC) rWins = true; // §5.1 outranks, ancestry irrelevant
      else if (cR < cC) rWins = false; // outranked, even by an ancestor
      else rWins = ancestorsOf(r.id).has(cur); // same class: more derived wins

      if (!loserOf.has(k)) loserOf.set(k, new Map());
      if (rWins) {
        loserOf.get(k).set(cur, state[k]);
        setters[k] = r.id;
        state[k] = v;
        setterClass[k] = cR;
      } else {
        loserOf.get(k).set(r.id, v);
      }
    }
  }

  // ---- §5.3 conflict detection ---------------------------------------------
  // "2+ DISTINCT values across the candidates" — a record that sets the same
  // value is agreement, not conflict, and is not named a loser.
  const conflicts = [];
  for (const [k, vals] of valuesFor) {
    if (vals.size < 2) continue;
    const win = setters[k];
    const winVal = canon(state[k]);
    const losers = [...(loserOf.get(k) ?? new Map()).entries()]
      .filter(([, v]) => canon(v) !== winVal)
      .map(([id]) => id)
      .sort(cmpCodePoint);
    conflicts.push({ key: k, winner: win, losers });
  }
  conflicts.sort((a, b) => cmpCodePoint(a.key, b.key));

  return {
    state,
    setters,
    order,
    conflicts,
    orphans,
    // Not part of the spec's return, but the ledger needs them and they cost
    // nothing: which keys each id actually won, and which it tried and lost.
    landedKeys: Object.fromEntries(
      Object.entries(setters).map(([k, id]) => [k, id]),
    ),
    losers: Object.fromEntries([...loserOf.entries()].map(([k, m]) => [k, [...m.keys()].sort(cmpCodePoint)])),
    applied: applied.map((r) => r.id),
    malformed,
    shadowed,
  };
}

// ── reading of §5, stated so it can be argued with ───────────────────────────
//  1. §1.1 defaults parents/kind/effects/reason to []/null/{}/null when absent
//     and treats a PRESENT-but-wrong-typed field as malformed. The spec's §1.1
//     says both "defaults to []" and "missing any of the five is malformed";
//     this takes the defaults as governing absence and the type rule as
//     governing presence. Flagged because it is a choice, not a quote.
//  2. §5.3 conflicts are emitted for keys with >= 2 DISTINCT values, per that
//     section's own wording. §5.2's "one entry per key" describes the loser
//     ledger, which is exposed separately as `.losers`.
//  3. Cycle-affected records = everything Kahn could not emit, i.e. cycle
//     members AND their descendants. §5.5's "the fold runs on what stands"
//     means descendants of an excluded record are still folded.
//  4. Duplicate ids: last wins, and `.shadowed` names them.
//  5. This fold is NOT claimed conformant to the referee corpus. It is a
//     reading. Point it at gitpp-doctor and diff the two before trusting it
//     where the two could disagree.

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — AUTHORING A NUDGE (§5.6)
//
// A nudge is reliable only if it is parented on the CURRENT SETTER. That is
// the whole content of §5.6. This function therefore takes the fold, not the
// raw records, and refuses to invent a parent.
// ═══════════════════════════════════════════════════════════════════════════

export function setterOf(folded, key) {
  return folded?.setters?.[key] ?? null;
}

export function kindOfRecords(records, id) {
  const r = (records ?? []).find((x) => x?.id === id);
  return r ? r.kind : null;
}

/**
 * Build a nudge proposal WITHOUT writing it.
 * Returns the proposal plus the read-half of the read-then-write loop, so the
 * ledger can record not just "what was proposed" but "what it was proposed
 * against" — without that context a stale authorisation is indistinguishable
 * from a fresh one, and that distinction is the whole point.
 */
export function proposeNudge(records, folded, key, value, opts = {}) {
  const setter = setterOf(folded, key);
  const priorKind = kindOfRecords(records, setter);
  const id = opts.id ?? nextNudgeId(records, opts.counter);
  // `parentOverride` exists to model the §5.6 failure mode in the worked
  // example: an agent that authored the nudge without reading the setter. It is
  // the only way to get a WRONG parent out of this function, which is the point
  // — the correct one is the default and you have to go out of your way.
  const parents = opts.parentOverride ?? (setter ? [setter] : []);
  const misparented = setter !== null && !parents.includes(setter);
  const proposal = {
    id,
    key,
    value,
    record: {
      id,
      kind: opts.kind ?? priorKind ?? "task",
      parents: [...parents].sort(cmpCodePoint),
      effects: { [key]: value },
      reason: opts.reason ?? `nudge ${key}`,
    },
    // The read half. `stateAtRead` is what the gate's answer was about.
    read: {
      setter,
      priorKind,
      wasUnset: setter === null,
      misparented,
      stateAtRead: canon(folded?.state ?? {}),
      // A nudge that would not change the value is a no-op. Say so now,
      // rather than letting it land as a pointless override later.
      isNoOp: setter !== null && sameValue(folded?.state?.[key], value),
    },
  };
  return proposal;
}

/** Promote a proposal to a real record. Only called once the ledger says so. */
export function commitNudge(proposal, kind) {
  return { ...proposal.record, kind: kind ?? proposal.record.kind };
}

export function nextNudgeId(records, counter) {
  let n = (records?.length ?? 0) + 1;
  if (counter && typeof counter === "object" && typeof counter.n === "number") {
    counter.n += 1;
    n = counter.n;
  }
  let id = `nudge-${String(n).padStart(4, "0")}`;
  const taken = new Set((records ?? []).map((r) => r?.id));
  while (taken.has(id)) {
    n += 1;
    id = `nudge-${String(n).padStart(4, "0")}`;
  }
  return id;
}

/**
 * gitpp-nudge's verifyNudge, restated as "is this record the setter right
 * now" — which is the stronger and more honest question, because the nudge may
 * have landed and then been displaced.
 */
export function outcomeOf(folded, recordId) {
  const landed = Object.entries(folded.setters).filter(([, id]) => id === recordId).map(([k]) => k).sort(cmpCodePoint);
  const rec = folded.applied.includes(recordId);
  return {
    present: rec,
    landed,
    landedNow: landed.length > 0,
    // If it is not the setter for any key it set, what beat it?
    displacedBy: Object.fromEntries(
      Object.entries(folded.losers ?? {}).flatMap(([k, ids]) =>
        ids.includes(recordId) ? [[k, folded.setters[k] ?? null]] : [],
      ),
    ),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — THE GATE ADAPTER
//
// Mirrors gitpp-gate's route(). Deliberately reimplemented rather than
// imported: this file must stand alone with no sibling checkout.
//
// The routing rule lives in CODE, not in whatever model answered:
//     act     every required gate is confident enough
//     review  close to threshold, or the gates disagree
//     block   a gate is confidently NO, or there was no signal at all
//
// §5.7's one rule that outranks the rest: ABSENT SIGNAL IS NOT CONSENT.
// `gateDecide` with no fixture for a nudge returns `block`. It cannot return
// `act`. There is no code path from "we don't know" to "yes".
//
// The core check NEVER calls this. Gate data is a fixture, or it is absent, and
// absent fixture data means the ledger has no `decision` entry — which the
// check reports as UNGATED_LANDING. No token, no network, no lie.
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_THRESHOLD = 0.8;
/** The parent gate, which does separate (0.61 vs 0.15), carries the blocking. */
export const PARENT_BLOCK_BELOW = 0.5;

export function gateDecide(proposal, opts = {}) {
  const t = opts.threshold ?? DEFAULT_THRESHOLD;
  const pb = opts.parentBlockBelow ?? PARENT_BLOCK_BELOW;
  const fx = opts.fixture ?? null;
  const answers = fx ? lookupFixture(fx, proposal) : null;

  if (!answers) {
    return {
      action: opts.onMissing ?? "block",
      reason: "no signal from fixture — absent signal is not consent (§5.7)",
      apply: null,
      parent: null,
      threshold: t,
      source: opts.source ?? "fixture:none",
    };
  }

  const applyP = answers.apply ?? null;
  const parentP = answers.parent ?? null;

  // Fail closed on partial signal too: a half-answer is not a whole answer.
  if (applyP === null || parentP === null) {
    const missing = [];
    if (applyP === null) missing.push("should_apply");
    if (parentP === null) missing.push("parent_is_current_setter");
    return {
      action: opts.onMissing ?? "block",
      reason: `no signal from: ${missing.join(", ")}`,
      apply: applyP,
      parent: parentP,
      threshold: t,
      source: opts.source ?? "fixture:partial",
    };
  }

  if (parentP < pb) {
    // The wrong-parent case. This nudge is parented on something that is not
    // the setter, so the fold will decide on id order, not on merit.
    return {
      action: "block",
      reason: `confidently no: parent_is_current_setter=${parentP.toFixed(3)} < ${pb}`,
      apply: applyP,
      parent: parentP,
      threshold: t,
      source: opts.source ?? "fixture:jev",
    };
  }
  if (applyP < t) {
    // Measured: a well-founded nudge scored 0.35 and an unjustified one 0.07.
    // Real separation, wrong scale. A cutoff that admits the bad case blocks
    // the good one, so weak INTENT reviews and never blocks (§5.7).
    return {
      action: "review",
      reason: `should_apply=${applyP.toFixed(3)} below ${t}`,
      apply: applyP,
      parent: parentP,
      threshold: t,
      source: opts.source ?? "fixture:jev",
    };
  }
  if (parentP < t) {
    return {
      action: "review",
      reason: `parent confidence=${parentP.toFixed(3)} below ${t}`,
      apply: applyP,
      parent: parentP,
      threshold: t,
      source: opts.source ?? "fixture:jev",
    };
  }
  return {
    action: "act",
    reason: "all gates confident",
    apply: applyP,
    parent: parentP,
    threshold: t,
    source: opts.source ?? "fixture:jev",
  };
}

function lookupFixture(fixture, proposal) {
  if (!fixture) return null;
  if (typeof fixture === "function") return fixture(proposal);
  return fixture[proposal?.id] ?? fixture[proposal?.key] ?? fixture["*"] ?? null;
}

/**
 * OPTIONAL live gate. NOT used by the check, NOT used by the example, and NOT
 * part of the conformance claim. It exists so the fixture path can be shown to
 * be a real shape and not a fiction. Exercised separately; see README.
 */
export async function liveGate(proposal, context, opts = {}) {
  const base = opts.base ?? "https://api.typesafe.ai/v1/systemone";
  const key = opts.apiKey ?? process.env.TYPESAFE_AI_TOKEN;
  if (!key) throw new Error("TYPESAFE_AI_TOKEN is not set — the core check does not need it; this path is optional");
  const state = [
    ...Object.entries(context?.state ?? {}).map(([k, v]) => `${k}=${canon(v)}`),
    `current setter of ${proposal.key} is "${setterOf(context?.folded, proposal.key)}"`,
    `proposed: ${proposal.key} -> ${canon(proposal.value)} because ${proposal.record.reason}`,
  ].join("; ");
  const res = await fetch(base, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      state,
      model: opts.model ?? "jev-latest",
      questions: {
        should_apply: {
          type: "noul",
          instructions:
            "The proposed change is a well-founded update to the current state: it follows from the current setter, it does not contradict a higher-precedence record, and its stated reason matches the change.",
        },
        parent_is_current_setter: {
          type: "noul",
          instructions: `The record that currently sets this key is "${setterOf(context?.folded, proposal.key)}". The proposed nudge names "${proposal.record.parents?.[0] ?? "nothing"}" as its parent. The parent choice is correct.`,
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const answers = (await res.json()).answers;
  return gateDecide(
    proposal,
    {
      threshold: opts.threshold,
      source: "typesafe:jev",
      // A FUNCTION fixture, not a keyed one. The keyed form is looked up by
      // nudge id; an object with `apply`/`parent` keys is simply never found,
      // which fails closed and looks exactly like a model that had no opinion.
      // That bug shipped once in this file and the probe caught it.
      fixture: () => ({
        apply: typeof answers?.should_apply?.noul === "number" ? answers.should_apply.noul : null,
        parent:
          typeof answers?.parent_is_current_setter?.noul === "number"
            ? answers.parent_is_current_setter.noul
            : null,
      }),
    },
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — THE LEDGER
//
// Append-only. Every entry commits to its predecessor's hash, so the sequence
// is a chain: editing entry 4 breaks entry 5 and every entry after it, and the
// break is detectable without a server, a signature, or a notary.
//
// This is the property that makes the ledger worth more than a log file. A log
// file can be rewritten wholesale. A chain cannot, without rewriting the
// present, and the present is the part the fold can see.
// ═══════════════════════════════════════════════════════════════════════════

/** The five entry kinds. Anything else is malformed and rejected at append. */
export const ENTRY_KINDS = ["intent", "decision", "approval", "override", "observed"];

/**
 * What each entry kind must carry. Deliberately shallow — the ledger's job is
 * to make claims checkable, and a claim with no required fields is a comment.
 */
const ENTRY_REQUIRED = {
  // someone meant something
  intent: ["nudge_id", "key", "value", "record", "read"],
  // a gate answered, with its confidence
  decision: ["nudge_id", "action", "confidence"],
  // a human cleared a review
  approval: ["nudge_id", "by"],
  // a human wrote a record by hand, and said so
  override: ["record", "by"],
  // a claim about what happened — CHECKED against the fold, never trusted
  observed: ["nudge_id", "landed"],
};

export function validateEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { ok: false, why: "not an object" };
  if (typeof entry.kind !== "string") return { ok: false, why: "missing kind" };
  if (!ENTRY_KINDS.includes(entry.kind)) return { ok: false, why: `unknown entry kind "${entry.kind}"` };
  for (const f of ENTRY_REQUIRED[entry.kind]) {
    if (entry[f] === undefined || entry[f] === null) return { ok: false, why: `${entry.kind} entry missing "${f}"` };
  }
  if (entry.kind === "decision") {
    if (!["act", "review", "block"].includes(entry.action)) return { ok: false, why: `bad action "${entry.action}"` };
    const c = entry.confidence;
    if (typeof c !== "object" || c === null) return { ok: false, why: "confidence must be an object" };
    for (const k of Object.keys(c)) {
      if (typeof c[k] !== "number" || c[k] < 0 || c[k] > 1) return { ok: false, why: `confidence.${k} out of range` };
    }
  }
  if (entry.record !== undefined) {
    const v = normaliseRecord(entry.record);
    if (!v.ok) return { ok: false, why: `record malformed: ${v.why}` };
  }
  return { ok: true };
}

/** Compute an entry's hash over its own body plus its predecessor's hash. */
export function entryHash(entry, prev) {
  const body = { ...entry };
  delete body.hash;
  delete body.prev;
  return sha256(canon({ prev: prev ?? GENESIS, body }));
}

/**
 * Append one entry. Refuses malformed entries. Refuses a broken chain —
 * you cannot extend a history that has been tampered with, because extending
 * it would launder the tamper into the new entry.
 */
export function append(ledger, entry, opts = {}) {
  const v = validateEntry(entry);
  if (!v.ok) return { ok: false, why: v.why, ledger };
  const prev = ledger.length ? ledger[ledger.length - 1].hash : GENESIS;
  if (opts.expectPrev !== undefined && opts.expectPrev !== prev) {
    return { ok: false, why: `chain break: expected prev ${opts.expectPrev}, head is ${prev}`, ledger };
  }
  const seq = ledger.length + 1;
  const full = {
    seq,
    ts: opts.ts ?? new Date().toISOString(),
    kind: entry.kind,
    ...entry,
    prev,
  };
  full.hash = entryHash(full, prev);
  return { ok: true, entry: full, ledger: [...ledger, full] };
}

/** Convenience wrappers, one per entry kind. */
export const recordIntent = (ledger, e, o) => append(ledger, { kind: "intent", ...e }, o);
export const recordDecision = (ledger, e, o) => append(ledger, { kind: "decision", ...e }, o);
export const recordApproval = (ledger, e, o) => append(ledger, { kind: "approval", ...e }, o);
export const recordOverride = (ledger, e, o) => append(ledger, { kind: "override", ...e }, o);
export const recordObserved = (ledger, e, o) => append(ledger, { kind: "observed", ...e }, o);

/**
 * Verify the chain and sequence numbers.
 * Every problem is reported; verification continues past the first fault,
 * because "the chain broke at 4" and "and also at 7" is a better report than
 * the first one alone.
 */
export function verifyChain(ledger) {
  const findings = [];
  let prev = GENESIS;
  let lastSeq = 0;
  for (let i = 0; i < ledger.length; i++) {
    const e = ledger[i];
    const where = `#${i + 1}`;
    if (e.seq !== i + 1) findings.push({ where, code: "SEQ_GAP", detail: `seq ${e.seq}, expected ${i + 1}` });
    if (e.prev !== prev) findings.push({ where, code: "PREV_MISMATCH", detail: `prev ${String(e.prev).slice(0, 12)}…, expected ${String(prev).slice(0, 12)}…` });
    const want = entryHash(e, e.prev);
    if (e.hash !== want) findings.push({ where, code: "HASH_MISMATCH", detail: `entry claims ${String(e.hash).slice(0, 12)}…, content hashes to ${want.slice(0, 12)}…` });
    const v = validateEntry(e);
    if (!v.ok) findings.push({ where, code: "MALFORMED_ENTRY", detail: v.why });
    prev = e.hash;
    lastSeq = e.seq;
  }
  return { ok: findings.length === 0, findings, length: ledger.length, head: prev, lastSeq };
}

// ---- JSONL transport -------------------------------------------------------
// One entry per line. A log format with no pretty-printing mode, because a
// ledger you can reformat is a ledger you can reorder by accident.

export function serialise(ledger) {
  return ledger.map((e) => JSON.stringify(e)).join("\n") + (ledger.length ? "\n" : "");
}

export function parseLedger(text) {
  const out = [];
  const bad = [];
  const lines = String(text ?? "").split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      bad.push({ line: i + 1, why: err.message });
    }
  });
  return { entries: out, unparseable: bad };
}

export function loadLedger(path) {
  return parseLedger(readFileSafe(path));
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — THE CHECK
//
// Two questions, asked over the whole history:
//
//   Q1  did any nudge LAND that the gate did not authorise?
//   Q2  did any gate AUTHORISE a nudge that did not land?
//
// And the one underneath them both:
//
//   Q3  what did the gate get right?
//
// Q3 is not decoration. A ledger that only reports failures trains its readers
// to disable it. The calibration block is what turns "we found 3 problems" into
// "the gate authorised 4 things and 1 of them was a no-op" — which is the fact
// that actually changes a threshold.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW "LANDED" IS DECIDED
//
// Not from the ledger. From the fold. A record has landed iff the fold made it
// the setter of at least one key. §5.2 decides that, not us, and if the fold
// says a nudge lost the key then it lost the key no matter what anybody wrote
// down at the time.
//
// The ledger's own `observed` entries are treated as CLAIMS and compared. A
// claim that disagrees with the fold is itself a finding.
// ═══════════════════════════════════════════════════════════════════════════

const SEVERITY = { critical: 0, major: 1, warn: 2, info: 3 };

function finding(severity, code, title, detail, extra = {}) {
  return { severity, code, title, detail, ...extra };
}

/** Index the ledger by the id each entry is about. */
function indexProvenance(ledger) {
  const prov = new Map();
  const get = (id) => {
    if (!prov.has(id)) prov.set(id, { id, intent: null, decisions: [], approvals: [], override: null, observed: [] });
    return prov.get(id);
  };
  for (const e of ledger) {
    if (e.kind === "override") {
      const p = get(e.record.id);
      if (p.override) p.overrideDupes = (p.overrideDupes ?? 0) + 1;
      p.override = e;
      continue;
    }
    const id = e.nudge_id;
    if (typeof id !== "string") continue;
    const p = get(id);
    if (e.kind === "intent") p.intent = p.intent ?? e;
    else if (e.kind === "decision") p.decisions.push(e);
    else if (e.kind === "approval") p.approvals.push(e);
    else if (e.kind === "observed") p.observed.push(e);
  }
  return prov;
}

/**
 * Is this nudge CLEARED to apply?
 *   act                     → cleared by the gate
 *   review + approval       → cleared by a human
 *   review, no approval     → held
 *   block                   → refused
 *   no decision at all      → never asked
 */
function clearance(p) {
  if (!p) return { state: "unknown", why: "no ledger entry of any kind" };
  if (p.override && !p.intent) return { state: "declared", why: "hand-authored and declared in the ledger" };
  if (!p.intent) return { state: "unknown", why: "no intent entry" };
  if (p.decisions.length === 0) return { state: "never-asked", why: "intent recorded, no gate decision" };
  const last = p.decisions[p.decisions.length - 1];
  if (last.action === "act") return { state: "cleared", why: `gate said act (${fmtConf(last)})` };
  if (last.action === "block") return { state: "refused", why: `gate said block: ${last.reason ?? "no reason given"}` };
  if (last.action === "review") {
    if (p.approvals.length > 0) {
      const a = p.approvals[p.approvals.length - 1];
      return { state: "cleared", why: `gate said review, approved by ${a.by}` };
    }
    return { state: "held", why: `gate said review: ${last.reason ?? "no reason given"}` };
  }
  return { state: "unknown", why: "unrecognised clearance state" };
}

const fmtConf = (e) => {
  const c = e.confidence ?? {};
  const parts = [];
  for (const k of Object.keys(c).sort()) parts.push(`${k}=${typeof c[k] === "number" ? c[k].toFixed(2) : c[k]}`);
  return parts.join(" ") || "no confidence recorded";
};

const pct = (n, d) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(0)}%`);

/**
 * THE CHECK. Pure. No network, no clock, no filesystem, no model.
 *
 * @param {object[]} ledger   parsed ledger entries
 * @param {object[]} records  the current record set (git.pp records)
 * @param {object}   opts     { deep: boolean }  deep adds the order-sensitivity probe
 * @returns {{ok, findings, counts, calibration, folded}}
 */
export function check(ledger, records, opts = {}) {
  const findings = [];
  const ledgerArr = Array.isArray(ledger) ? ledger : (ledger?.entries ?? []);

  // ---- 0. can we trust this ledger at all? ---------------------------------
  const chain = verifyChain(ledgerArr);
  for (const f of chain.findings) {
    findings.push(
      finding(
        f.code === "SEQ_GAP" ? "major" : "critical",
        f.code,
        "ledger chain broken",
        `${f.where}: ${f.detail}`,
        { where: f.where },
      ),
    );
  }
  if (opts.unparseable?.length) {
    for (const u of opts.unparseable) {
      findings.push(finding("critical", "UNPARSEABLE_ENTRY", "ledger line is not JSON", `line ${u.line}: ${u.why}`));
    }
  }

  // ---- 1. re-derive the world ----------------------------------------------
  const folded = derive(records);
  const prov = indexProvenance(ledgerArr);
  const byId = new Map((records ?? []).filter((r) => r?.id).map((r) => [r.id, r]));
  const outcomes = new Map();
  for (const id of byId.keys()) outcomes.set(id, outcomeOf(folded, id));

  const isWinner = (id) => Object.values(folded.setters).includes(id);
  const describeOutcome = (id) => {
    if (!byId.has(id)) return "never written to the record set";
    const o = outcomes.get(id);
    return o.landedNow
      ? `landed as setter of ${o.landed.map((k) => `"${k}"`).join(", ")}`
      : `written but LOST every key it set${Object.keys(o.displacedBy).length ? ` (displaced by ${Object.entries(o.displacedBy).map(([k, w]) => `${w} on "${k}"`).join(", ")})` : ""}`;
  };

  // ---- 2. Q1 — landings, walking the record set ----------------------------
  // Walks RECORDS, not ledger entries. That direction is the entire design:
  // a landing with no authorisation is invisible to any check that starts
  // from the ledger and asks what happened to it.
  const winners = [...new Set(Object.values(folded.setters))];
  const unauthorised = [];
  for (const id of [...winners].sort(cmpCodePoint)) {
    const p = prov.get(id) ?? null;
    const c = clearance(p);
    const out = describeOutcome(id);
    if (c.state === "cleared") continue;

    const code =
      c.state === "declared"
        ? "DECLARED_OVERRIDE"
        : c.state === "unknown"
          ? "SILENT_LANDING"
          : c.state === "never-asked"
            ? "UNGATED_LANDING"
            : c.state === "refused"
              ? "BLOCKED_BUT_LANDED"
              : "REVIEW_LANDED_UNAPPROVED";
    const sev =
      c.state === "declared" ? "warn" : c.state === "held" ? "major" : "critical";

    findings.push(
      finding(sev, code, LANDING_TITLE[code], `${id} — ${c.why}; ${out}`, {
        record_id: id,
        keys: outcomes.get(id).landed,
        kind: byId.get(id)?.kind ?? null,
        question: "Q1",
        effect: LANDING_EFFECT[code],
      }),
    );
    if (sev === "critical") unauthorised.push(id);
  }

  // ---- 2b. say out loud what this check CANNOT see -------------------------
  // Q1 walks the current winners. A record that landed and was LATER
  // displaced is no longer a winner, so Q1 cannot see it — and "was it ever a
  // winner?" is unanswerable without a snapshot taken at the time. Rather
  // than let that be a silent gap, name every record that tried to set a key,
  // is not winning one now, and has no ledger entry at all. One info line, not
  // N criticals: most of them are pre-existing substrate, and pretending
  // otherwise would train readers to ignore the finding that matters.
  const contenders = new Set(winners);
  for (const list of Object.values(folded.losers ?? {})) for (const id of list) contenders.add(id);
  const unaccounted = [...contenders]
    .filter((id) => !winners.includes(id) && !prov.has(id))
    .sort(cmpCodePoint);
  if (unaccounted.length) {
    findings.push(
      finding("info", "UNACCOUNTED_RECORDS", "records that set keys, are not winning them, and have no ledger entry", `${unaccounted.join(", ")} — each of these tried to set at least one key and lost the fold. Whether it ever WON is unanswerable here: this check reads the present, and nothing recorded the past. That is a gap in the evidence, not an accusation.`, {
        records: unaccounted,
        question: "Q1",
        effect: "blind spot, stated rather than hidden",
      }),
    );
  }

  // ---- 3. Q2 — authorisations that did not become outcomes -----------------
  const authorised = [];
  const holdCounts = { cleared: 0, held: 0, refused: 0, unknown: 0, declared: 0, "never-asked": 0 };
  for (const [id, p] of [...prov.entries()].sort((a, b) => cmpCodePoint(a[0], b[0]))) {
    const c = clearance(p);
    holdCounts[c.state] = (holdCounts[c.state] ?? 0) + 1;
    if (c.state === "declared") continue;
    if (c.state !== "cleared") continue;
    authorised.push(id);

    const o = outcomes.get(id);
    if (!byId.has(id)) {
      findings.push(
        finding("major", "AUTHORISED_NEVER_LANDED", "gate authorised a nudge that was never written", `${id} — ${c.why}; ${describeOutcome(id)}`, {
          record_id: id,
          question: "Q2",
          effect: "an approval was given for nothing",
        }),
      );
      continue;
    }
    if (!o.landedNow) {
      // THE TOCTOU CASE. The gate authorised this against a state that no
      // longer exists. The authorisation was real; the world it was for is
      // gone. Nothing but a ledger makes that visible.
      findings.push(
        finding("major", "AUTHORISED_BUT_LOST", "gate authorised a nudge that lost the fold", `${id} — ${c.why}; ${describeOutcome(id)}`, {
          record_id: id,
          question: "Q2",
          displaced_by: o.displacedBy,
          effect: "an approval was given and had no effect on state",
        }),
      );
    }
  }

  // ---- 4. Q3 — did the ledger itself lie? ----------------------------------
  // Compare every observed claim to the fold. A writer that observes is
  // making a falsifiable claim; this is where it gets falsified.
  for (const e of ledgerArr) {
    if (e.kind !== "observed") continue;
    const id = e.nudge_id;
    const present = byId.has(id);
    const landed = present ? isWinner(id) : false;
    const claimed = e.landed === true;
    if (claimed === landed) continue;
    if (!present) continue; // AUTHORISED_NEVER_LANDED already carries this
    findings.push(
      finding("major", "OUTCOME_CLAIM_FALSE", "the ledger claims an outcome the fold contradicts", `${id} — observed.landed=${claimed}, fold says ${landed ? "landed" : "not landed"}`, {
        record_id: id,
        question: "Q3",
        effect: "the record of what happened disagrees with what happened",
      }),
    );
  }

  // ---- 5. context findings --------------------------------------------------
  for (const o of folded.orphans) {
    const p = prov.get(o.id);
    if (!p) continue; // pre-existing substrate noise is not this ledger's business
    findings.push(
      finding("warn", "ORPHANED_NUDGE", "a nudge in the ledger is an orphan in the fold", `${o.id} — ${o.why}${o.missing?.length ? `: missing parent(s) ${o.missing.join(", ")}` : ""}`, {
        record_id: o.id,
        question: "Q3",
        effect: "the record exists and reads as intent, but never reaches state",
      }),
    );
  }
  for (const id of folded.shadowed ?? []) {
    findings.push(
      finding("critical", "SHADOWED_RECORD", "two records share an id", `${id} — the fold took the last; the ledger cannot say which one a gate was shown`, {
        record_id: id,
        question: "Q3",
        effect: "provenance for this id is ambiguous",
      }),
    );
  }

  // ---- 6. deep: is "landed" even stable? ------------------------------------
  // If the setter map changes when the fold's tie-break is reversed, then the
  // fact "it landed" was an artefact of an ordering the spec calls a tie. A
  // ledger built on an unstable fact is a ledger of coin flips.
  if (opts.deep) {
    const alt = derive(records, { tieBreak: "desc" });
    const drift = [];
    for (const k of new Set([...Object.keys(folded.setters), ...Object.keys(alt.setters)])) {
      if (folded.setters[k] !== alt.setters[k]) drift.push({ key: k, asc: folded.setters[k] ?? null, desc: alt.setters[k] ?? null });
    }
    for (const d of drift) {
      findings.push(
        finding("warn", "ORDER_SENSITIVE", "a key's setter depends on the fold's tie-break order", `key "${d.key}" is set by ${d.asc} under code-point order and ${d.desc} under reverse order`, {
          key: d.key,
          question: "Q3",
          effect: "the outcome recorded here is not robust",
        }),
      );
    }
  }

  // ---- 7. calibration — Q3 in numbers ---------------------------------------
  const cleared = authorised;
  const clearedLanded = cleared.filter((id) => outcomes.get(id)?.landedNow);
  const clearedLost = cleared.filter((id) => byId.has(id) && !outcomes.get(id)?.landedNow);
  const clearedNeverWritten = cleared.filter((id) => !byId.has(id));
  const refusedIds = [...prov.entries()].filter(([, p]) => clearance(p).state === "refused").map(([id]) => id);
  const heldIds = [...prov.entries()].filter(([, p]) => clearance(p).state === "held").map(([id]) => id);
  const neverAskedIds = [...prov.entries()].filter(([, p]) => clearance(p).state === "never-asked").map(([id]) => id);
  const refusedLeaked = refusedIds.filter((id) => outcomes.get(id)?.landedNow);
  const heldLeaked = heldIds.filter((id) => outcomes.get(id)?.landedNow);
  const neverAskedLanded = neverAskedIds.filter((id) => outcomes.get(id)?.landedNow);

  const calibration = {
    authorised: cleared.length,
    authorisedLanded: clearedLanded.length,
    authorisedLost: clearedLost.length,
    authorisedNeverWritten: clearedNeverWritten.length,
    refused: refusedIds.length,
    refusedLeaked: refusedLeaked.length,
    held: heldIds.length,
    heldLeaked: heldLeaked.length,
    neverAsked: neverAskedIds.length,
    neverAskedLanded: neverAskedLanded.length,
    declaredOverrides: holdCounts.declared ?? 0,
    // The two numbers a captain actually reads.
    authorityYield: pct(clearedLanded.length, cleared.length),
    leakRate: pct(refusedLeaked.length + heldLeaked.length + neverAskedLanded.length, refusedIds.length + heldIds.length + neverAskedIds.length),
    verdict: calibrationVerdict(cleared.length, clearedLost.length, clearedNeverWritten.length, refusedLeaked.length, heldLeaked.length, neverAskedLanded.length),
  };

  findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || cmpCodePoint(a.code, b.code) || cmpCodePoint(a.record_id ?? "", b.record_id ?? ""));
  const counts = {
    critical: findings.filter((f) => f.severity === "critical").length,
    major: findings.filter((f) => f.severity === "major").length,
    warn: findings.filter((f) => f.severity === "warn").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
  return {
    ok: counts.critical === 0 && counts.major === 0,
    chain,
    findings,
    counts,
    calibration,
    unauthorised,
    folded,
  };
}

function calibrationVerdict(cleared, lost, neverWritten, refusedLeaked, heldLeaked, neverLanded) {
  const leaks = refusedLeaked + heldLeaked + neverLanded;
  if (cleared === 0) return "no gate decision in this history — nothing to calibrate against";
  if (lost + neverWritten > 0) return `the gate gave ${cleared} approvals and ${lost + neverWritten} did not take effect; it is confident about a world that is not there`;
  if (leaks > 0) return `the gate refused or held ${leaks} nudges that landed anyway; the gate is not load-bearing`;
  return `the gate's ${cleared} approvals all took effect and nothing it did not approve landed; it is load-bearing`;
}

const LANDING_TITLE = {
  DECLARED_OVERRIDE: "a hand-authored record landed (declared)",
  SILENT_LANDING: "a record landed that nobody intended",
  UNGATED_LANDING: "a nudge landed with no gate decision",
  BLOCKED_BUT_LANDED: "a nudge the gate blocked landed anyway",
  REVIEW_LANDED_UNAPPROVED: "a held nudge landed with no approval",
};
const LANDING_EFFECT = {
  DECLARED_OVERRIDE: "accounted for — listed so it stays visible, not hidden",
  SILENT_LANDING: "state contains something no agent proposed and no gate saw",
  UNGATED_LANDING: "the gate was skipped, not outvoted",
  BLOCKED_BUT_LANDED: "the gate is not load-bearing",
  REVIEW_LANDED_UNAPPROVED: "a human hold was bypassed",
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — THE WORKED EXAMPLE
//
// Five cases, one record set, one ledger. Between them they answer both
// headline questions and the one underneath.
//
//   A  nudge-0005    gate says BLOCK.           never written.      correct
//   B  nudge-0006    gate says REVIEW, human approves, lands.       correct
//   C  override-0007 lands with NO ledger entry at all.             ← THE CASE
//   C2 override-0008 lands, hand-authored, DECLARED in the ledger.  accounted
//   D  nudge-0009    gate says ACT... and loses the fold to a later
//                    override. The authorisation was real; the world it
//                    authorised for is gone.                      ← TOCTOU
//   E  nudge-0011    gate says ACT, never written.                 ← Q2
//
// Gate data is a fixture. No token is read. No network call is made.
// ═══════════════════════════════════════════════════════════════════════════

export function workedExample(opts = {}) {
  const ts = opts.ts ?? "2026-10-16T00:00:00.000Z";
  const o = { ts }; // every entry stamped the same instant: this is a fixture

  // ---- the substrate before anybody did anything clever --------------------
  let records = [
    { id: "task-0001", kind: "task", parents: [], effects: { "release.channel": "stable" }, reason: "ship stable" },
    { id: "task-0002", kind: "task", parents: [], effects: { "build.green": true }, reason: "ci green" },
    { id: "witness-0003", kind: "witness", parents: ["task-0002"], effects: { "build.green": false }, reason: "flaked once" },
    { id: "task-0004", kind: "task", parents: [], effects: { version: "0.3.0" }, reason: "current release" },
  ];
  let ledger = [];
  const log = [];
  const say = (s) => log.push(s);

  // ---- A. an agent proposes a nudge parented on the WRONG record ----------
  // Not a hypothetical: §5.6 exists because this is what happens. The gate
  // sees it and refuses, which is the gate doing its job.
  say("A. agent proposes release.channel -> canary, parented on task-0002 (wrong setter)");
  let a = proposeNudge(records, derive(records), "release.channel", "canary", {
    id: "nudge-0005",
    parentOverride: ["task-0002"],
    reason: "let's try canary",
  });
  ledger = recordIntent(ledger, { nudge_id: a.id, key: a.key, value: a.value, record: a.record, read: a.read, author: "agent:wesley" }, o).ledger;
  const dA = gateDecide(a, { fixture: GATE_FIXTURE, source: "fixture:jev" });
  ledger = recordDecision(ledger, { nudge_id: a.id, action: dA.action, confidence: { apply: dA.apply, parent: dA.parent }, threshold: dA.threshold, reason: dA.reason, source: dA.source }, o).ledger;
  say(`   gate -> ${dA.action.toUpperCase()}  (${dA.reason})`);
  say("   never written. the gate is load-bearing here.");
  say("");

  // ---- B. a well-formed nudge, reviewed, approved, lands -------------------
  say('B. agent proposes version -> "0.4.0", parented on task-0004 (correct setter)');
  const b = proposeNudge(records, derive(records), "version", "0.4.0", { id: "nudge-0006", reason: "cut 0.4.0" });
  ledger = recordIntent(ledger, { nudge_id: b.id, key: b.key, value: b.value, record: b.record, read: b.read, author: "agent:wesley" }, o).ledger;
  const dB = gateDecide(b, { fixture: GATE_FIXTURE, source: "fixture:jev" });
  ledger = recordDecision(ledger, { nudge_id: b.id, action: dB.action, confidence: { apply: dB.apply, parent: dB.parent }, threshold: dB.threshold, reason: dB.reason, source: dB.source }, o).ledger;
  say(`   gate -> ${dB.action.toUpperCase()}  (${dB.reason})`);
  ledger = recordApproval(ledger, { nudge_id: b.id, by: "captain", note: "0.4.0 is right" }, o).ledger;
  records = [...records, commitNudge(b)];
  const ob = outcomeOf(derive(records), b.id);
  ledger = recordObserved(ledger, { nudge_id: b.id, landed: ob.landedNow, setter: foldedSetter(derive(records), b.key) }, o).ledger;
  say(`   captain approves. written. ${describe(outcomeOf(derive(records), b.id))}`);
  say("");

  // ---- C. somebody writes a record by hand and says NOTHING ---------------
  // The headline. No intent, no decision, no approval, no override entry. The
  // fold is perfectly happy: override outranks task, so it wins and it is
  // correct. Nothing about the fold is wrong. The SYSTEM is wrong.
  say("C. a human hand-authors override-0007 (release.channel -> bleeding) and writes NOTHING to the ledger");
  const silent = { id: "override-0007", kind: "override", parents: [], effects: { "release.channel": "bleeding" }, reason: "yolo" };
  records = [...records, silent];
  say("   written. it wins on class precedence. no trace.");
  say("");

  // ---- C2. the same act, DECLARED ------------------------------------------
  say("C2. the same human hand-authors override-0008 but this time declares it");
  const declared = { id: "override-0008", kind: "override", parents: [], effects: { "docs.owner": "wesley" }, reason: "docs are mine" };
  ledger = recordOverride(ledger, { record: declared, by: "captain", note: "declaring, so the ledger can show it" }, o).ledger;
  records = [...records, declared];
  say("   declared. still visible in the report, but accounted for.");
  say("");

  // ---- D. the TOCTOU case --------------------------------------------------
  say("D. agent proposes build.green -> false. gate says ACT.");
  const d0 = proposeNudge(records, derive(records), "build.green", false, { id: "nudge-0009", reason: "re-run failed" });
  ledger = recordIntent(ledger, { nudge_id: d0.id, key: d0.key, value: d0.value, record: d0.record, read: d0.read, author: "agent:wesley" }, o).ledger;
  const dD = gateDecide(d0, { fixture: GATE_FIXTURE, source: "fixture:jev" });
  ledger = recordDecision(ledger, { nudge_id: d0.id, action: dD.action, confidence: { apply: dD.apply, parent: dD.parent }, threshold: dD.threshold, reason: dD.reason, source: dD.source }, o).ledger;
  say(`   gate -> ${dD.action.toUpperCase()}  (${dD.reason})`);
  // ...and then, before the write lands, a human overrides the key.
  const stale = { id: "override-0010", kind: "override", parents: [], effects: { "build.green": true }, reason: "rerun is green, ignore" };
  ledger = recordOverride(ledger, { record: stale, by: "captain", note: "the gate read a state that is no longer there" }, o).ledger;
  records = [...records, stale];
  say("   MEANWHILE captain hand-authors override-0010 setting build.green -> true.");
  // The authorised nudge is then written. It lands in the record set...
  records = [...records, commitNudge(d0)];
  const foldedD = derive(records);
  // ...and the writer, watching the write succeed, records "it landed".
  ledger = recordObserved(ledger, { nudge_id: d0.id, landed: true, setter: foldedSetter(foldedD, "build.green") }, o).ledger;
  say(`   nudge-0009 written. observed.landed=true recorded.`);
  say(`   but the fold says: ${describe(outcomeOf(foldedD, d0.id))}`);
  say("   the approval was real. the world it authorised for is gone.");
  say("");

  // ---- E. authorised and never written -------------------------------------
  say('E. agent proposes deploy.window -> "02:00". gate says ACT. the write never happens.');
  const e = proposeNudge(records, derive(records), "deploy.window", "02:00", { id: "nudge-0011", reason: "overnight deploys" });
  ledger = recordIntent(ledger, { nudge_id: e.id, key: e.key, value: e.value, record: e.record, read: e.read, author: "agent:wesley" }, o).ledger;
  const dE = gateDecide(e, { fixture: GATE_FIXTURE, source: "fixture:jev" });
  ledger = recordDecision(ledger, { nudge_id: e.id, action: dE.action, confidence: { apply: dE.apply, parent: dE.parent }, threshold: dE.threshold, reason: dE.reason, source: dE.source }, o).ledger;
  say(`   gate -> ${dE.action.toUpperCase()}  (${dE.reason})`);
  say("   ...and nothing else happens. ever.");
  say("");

  return { records, ledger, log, fixture: GATE_FIXTURE, narrative: NARRATIVE };
}

const foldedSetter = (folded, key) => folded.setters?.[key] ?? null;
const describe = (o) => (o.landedNow ? `landed on ${o.landed.join(", ")}` : "NOT the setter of any key");

/** Gate answers as a fixture. This is what a real Jev run would have produced. */
export const GATE_FIXTURE = {
  // parented on task-0002, which does NOT set release.channel. confidently no.
  "nudge-0005": { apply: 0.44, parent: 0.15 },
  // correctly parented, but weak intent -> review, not block (§5.7)
  "nudge-0006": { apply: 0.71, parent: 0.97 },
  // confident on both -> act
  "nudge-0009": { apply: 0.93, parent: 0.96 },
  "nudge-0011": { apply: 0.88, parent: 0.99 },
};

const NARRATIVE = {
  "override-0007":
    "Nobody proposed this. It won the fold because `override` outranks `task` — which is the fold working exactly as specified. The fold has no idea what anybody meant, and that is correct; purity is the point. This record exists because the ledger has nothing to say about it.",
  "nudge-0009":
    "The gate was asked about a world in which task-0002 still set build.green. override-0010 changed that between the decision and the write. The authorisation was not wrong — it was about a state that no longer existed. Only a record of both events makes that visible.",
};

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — SELF-TEST
//
// Assertions, not prose. Run it: `node intent-ledger.mjs selftest`.
// ═══════════════════════════════════════════════════════════════════════════

import assert from "node:assert/strict";
import fs from "node:fs";

export function selftest() {
  const t = [];
  const it = (name, fn) => {
    try {
      fn();
      t.push({ name, ok: true });
    } catch (e) {
      t.push({ name, ok: false, why: e.message });
    }
  };

  // ── canonical form ──────────────────────────────────────────────────────
  it("canon is order-independent", () => {
    assert.equal(canon({ b: 1, a: 2 }), canon({ a: 2, b: 1 }));
  });
  it("canon distinguishes 1 from \"1\"", () => {
    assert.notEqual(canon({ x: 1 }), canon({ x: "1" }));
  });
  it("codepoint order puts the rocket after the ASCII ids (§5.4)", () => {
    assert.ok(cmpCodePoint("a", "\u{1F680}") < 0);
    assert.ok(cmpCodePoint("~", "\u{1F680}") < 0);
  });

  // ── the fold, §5 ────────────────────────────────────────────────────────
  const base = [
    { id: "t1", kind: "task", parents: [], effects: { x: 1 }, reason: null },
    { id: "w1", kind: "witness", parents: ["t1"], effects: { x: 2 }, reason: null },
  ];
  it("§5.1 an override outranks a task even when the witness descends", () => {
    const f = derive([...base, { id: "o1", kind: "override", parents: [], effects: { x: 3 }, reason: null }]);
    assert.equal(f.setters.x, "o1");
    assert.equal(f.state.x, 3);
  });
  it("§5.1 a task outranks a descendant witness", () => {
    const f = derive(base);
    assert.equal(f.setters.x, "t1", "the witness must not displace the task");
    assert.equal(f.state.x, 1);
  });
  it("§5.6 setters are returned for UNCONTESTED keys too", () => {
    const f = derive([{ id: "solo", kind: "task", parents: [], effects: { lonely: "yes" }, reason: null }]);
    assert.deepEqual(f.setters, { lonely: "solo" });
    assert.equal(f.conflicts.length, 0, "an uncontested key is not a conflict");
  });
  it("§5.3 a contest with 2 distinct values is a conflict, and losers are named", () => {
    const f = derive([...base, { id: "o1", kind: "override", parents: [], effects: { x: 3 }, reason: null }]);
    assert.equal(f.conflicts.length, 1);
    assert.equal(f.conflicts[0].winner, "o1");
    assert.deepEqual(f.conflicts[0].losers, ["t1", "w1"]);
  });
  it("§5.3 two records with the SAME value are agreement, not conflict", () => {
    const f = derive([
      { id: "t1", kind: "task", parents: [], effects: { x: 1 }, reason: null },
      { id: "t2", kind: "task", parents: ["t1"], effects: { x: 1 }, reason: null },
    ]);
    assert.equal(f.conflicts.length, 0);
  });
  it("§5.2 within a class the MORE DERIVED record wins (ancestry direction)", () => {
    const f = derive([
      { id: "a", kind: "task", parents: [], effects: { x: "old" }, reason: null },
      { id: "z", kind: "task", parents: ["a"], effects: { x: "new" }, reason: null },
    ]);
    assert.equal(f.setters.x, "z");
  });
  it("§5.2 the ancestry direction is not inverted (child id sorts FIRST)", () => {
    // The inverse question would pick the ancestor here. This is corpus case
    // d03's failure mode and it silently reverses every contested key.
    const f = derive([
      { id: "child", kind: "task", parents: ["zzz-ancestor"], effects: { x: "new" }, reason: null },
      { id: "zzz-ancestor", kind: "task", parents: [], effects: { x: "old" }, reason: null },
    ]);
    assert.equal(f.setters.x, "child", "the more derived record wins even when it sorts first");
  });
  it("§5.2 an equal-class record with NO ancestry does not displace", () => {
    const f = derive([
      { id: "a", kind: "task", parents: [], effects: { x: "a" }, reason: null },
      { id: "b", kind: "task", parents: [], effects: { x: "b" }, reason: null },
    ]);
    assert.equal(f.setters.x, "a", "no ancestry relation: the earlier order position wins");
  });
  it("§5.5 a record with a missing parent is an orphan and does not reach state", () => {
    const f = derive([
      { id: "o", kind: "task", parents: ["nope"], effects: { x: 9 }, reason: null },
      { id: "ok", kind: "task", parents: [], effects: { y: 1 }, reason: null },
    ]);
    assert.equal(f.orphans.length, 1);
    assert.equal(f.orphans[0].id, "o");
    assert.equal(f.state.x, undefined);
  });
  it("§5.5 an orphan's DESCENDANTS are not auto-orphaned", () => {
    const f = derive([
      { id: "o", kind: "task", parents: ["nope"], effects: { x: 9 }, reason: null },
      { id: "kid", kind: "task", parents: ["o"], effects: { y: 1 }, reason: null },
    ]);
    assert.equal(f.orphans.length, 1);
    assert.equal(f.state.y, 1, "the fold runs on what stands");
  });
  it("§5.5 a cycle is reported, not swallowed", () => {
    const f = derive([
      { id: "a", kind: "task", parents: ["b"], effects: { x: 1 }, reason: null },
      { id: "b", kind: "task", parents: ["a"], effects: { y: 1 }, reason: null },
    ]);
    assert.equal(f.orphans.length, 2, "both cycle members are orphans for output");
    assert.equal(f.state.x, undefined);
    assert.equal(f.state.y, undefined);
  });
  it("§1.1 a malformed record is excluded and NAMED, not guessed at", () => {
    const f = derive([{ id: "bad", kind: "task", parents: "not-an-array", effects: {}, reason: null }]);
    assert.equal(f.malformed.length, 1);
    assert.equal(f.applied.length, 0);
  });
  it("§1.1 defaults apply for absent optional fields", () => {
    const f = derive([{ id: "only-id" }]);
    assert.equal(f.state.x, undefined);
    assert.deepEqual(f.applied, ["only-id"]);
  });
  it("a duplicate id is named, not silently resolved", () => {
    const f = derive([
      { id: "d", kind: "task", parents: [], effects: { x: 1 }, reason: null },
      { id: "d", kind: "task", parents: [], effects: { x: 2 }, reason: null },
    ]);
    assert.deepEqual(f.shadowed, ["d"]);
  });

  // ── §5.6 the whole reason this exists ───────────────────────────────────
  it("§5.6 a correctly-parented nudge lands whatever its own id sorts as", () => {
    for (const id of ["nudge-aaaa", "nudge-zzzz"]) {
      const recs = [
        { id: "t1", kind: "task", parents: [], effects: { x: "old" }, reason: null },
        { id, kind: "task", parents: ["t1"], effects: { x: "new" }, reason: null },
      ];
      assert.equal(derive(recs).setters.x, id, `${id} must land`);
    }
  });
  it("§5.6 a MIS-parented nudge's outcome depends on nothing but its id", () => {
    // The defect §5.6 was written about, demonstrated rather than described.
    // `s` is emitted first. `w` is the real setter of x. The nudge is parented
    // on `s` instead, so it and `w` land in the SAME tier and the tier's
    // code-point order is the only thing left deciding. Same record, same
    // kind, same reason, opposite outcome — and the difference is the nudge's
    // own id.
    const mk = (id) => [
      { id: "s", kind: "task", parents: [], effects: { seed: 1 }, reason: null },
      { id: "w", kind: "task", parents: ["s"], effects: { x: "old" }, reason: null },
      { id, kind: "task", parents: ["s"], effects: { x: "new" }, reason: null },
    ];
    assert.equal(derive(mk("a-nudge")).setters.x, "a-nudge", "sorts first: lands");
    assert.equal(derive(mk("z-nudge")).setters.x, "w", "sorts last: silently discarded");
  });

  // ── the ledger ──────────────────────────────────────────────────────────
  it("the chain verifies when nothing is touched", () => {
    const { ledger } = workedExample();
    const v = verifyChain(ledger);
    assert.ok(v.ok, JSON.stringify(v.findings));
  });
  it("editing an entry breaks the chain at that entry and every one after", () => {
    const { ledger } = workedExample();
    const tampered = ledger.map((e, i) => (i === 3 ? { ...e, nudge_id: "nudge-6666" } : e));
    const v = verifyChain(tampered);
    assert.ok(!v.ok);
    assert.ok(v.findings.some((f) => f.code === "HASH_MISMATCH"));
  });
  it("re-parenting a record without re-hashing it is detected", () => {
    const { ledger } = workedExample();
    const tampered = ledger.map((e) => (e.kind === "decision" ? { ...e, action: "act" } : e));
    assert.ok(!verifyChain(tampered).ok);
  });
  it("the chain refuses an unknown entry kind", () => {
    const r = append([], { kind: "rumour", nudge_id: "x" });
    assert.ok(!r.ok);
  });
  it("a decision with no confidence is refused", () => {
    const r = append([], { kind: "decision", nudge_id: "x", action: "act" });
    assert.ok(!r.ok);
  });
  it("append refuses to extend a history whose head moved", () => {
    const { ledger } = workedExample();
    const r = recordDecision(ledger, { nudge_id: "z", action: "act", confidence: { apply: 1, parent: 1 } }, {
      expectPrev: "deadbeef",
    });
    assert.ok(!r.ok);
    assert.match(r.why, /chain break/);
  });
  it("serialise -> parseLedger round-trips", () => {
    const { ledger } = workedExample();
    assert.deepEqual(parseLedger(serialise(ledger)).entries, ledger);
  });

  // ── the gate ────────────────────────────────────────────────────────────
  it("§5.7 no signal means BLOCK — there is no path from unknown to act", () => {
    const p = { id: "nudge-x", key: "x", record: { parents: [] }, read: {} };
    const d = gateDecide(p, { fixture: null });
    assert.equal(d.action, "block");
    assert.equal(d.apply, null);
  });
  it("§5.7 partial signal also blocks", () => {
    const p = { id: "nudge-x", key: "x", record: { parents: [] }, read: {} };
    assert.equal(gateDecide(p, { fixture: { "nudge-x": { apply: 0.99 } } }).action, "block");
    assert.equal(gateDecide(p, { fixture: { "nudge-x": { parent: 0.99 } } }).action, "block");
  });
  it("the wrong parent blocks (§5.7: this gate carries the blocking)", () => {
    const p = { id: "n", key: "x", record: { parents: ["wrong"] }, read: {} };
    assert.equal(gateDecide(p, { fixture: { n: { apply: 0.99, parent: 0.15 } } }).action, "block");
  });
  it("weak intent reviews and never blocks", () => {
    const p = { id: "n", key: "x", record: { parents: ["r"] }, read: {} };
    assert.equal(gateDecide(p, { fixture: { n: { apply: 0.07, parent: 0.9 } } }).action, "review");
  });
  it("a FUNCTION fixture is accepted (the shape liveGate uses)", () => {
    const p = { id: "n", key: "x", record: { parents: ["r"] }, read: {} };
    assert.equal(gateDecide(p, { fixture: () => ({ apply: 0.93, parent: 0.96 }) }).action, "act");
    // and a keyed fixture for the SAME proposal still wins when the key matches
    assert.equal(gateDecide(p, { fixture: { n: { apply: 0.93, parent: 0.96 } } }).action, "act");
    // a keyed fixture MISSING the key must fail closed, not guess
    assert.equal(gateDecide(p, { fixture: { other: { apply: 0.99, parent: 0.99 } } }).action, "block");
  });
  it("confident on both acts", () => {
    const p = { id: "n", key: "x", record: { parents: ["r"] }, read: {} };
    assert.equal(gateDecide(p, { fixture: { n: { apply: 0.93, parent: 0.96 } } }).action, "act");
  });
  it("core check needs no gate and no token — proven by removing the token", () => {
    const saved = process.env.TYPESAFE_AI_TOKEN;
    delete process.env.TYPESAFE_AI_TOKEN;
    try {
      const { ledger, records } = workedExample();
      assert.doesNotThrow(() => check(ledger, records));
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_AI_TOKEN = saved;
    }
  });

  // ── the check ───────────────────────────────────────────────────────────
  const ex = workedExample();
  const res = check(ex.ledger, ex.records);
  const codes = (r) => r.findings.map((f) => `${f.code}:${f.record_id ?? f.key ?? ""}`);

  it("the worked example finds exactly the seeded problems (above info)", () => {
    assert.deepEqual(codes(res).filter((c) => !c.startsWith("UNACCOUNTED_RECORDS")).sort(), [
      "AUTHORISED_BUT_LOST:nudge-0009",
      "AUTHORISED_NEVER_LANDED:nudge-0011",
      "DECLARED_OVERRIDE:override-0008",
      "DECLARED_OVERRIDE:override-0010",
      "OUTCOME_CLAIM_FALSE:nudge-0009",
      "SILENT_LANDING:override-0007",
    ].sort());
  });
  it("the check names its own blind spot: unaccounted non-winners", () => {
    // A record that landed and was LATER displaced is not a winner now, so
    // Q1 cannot see it. The check must say so rather than let the gap hide.
    const f = res.findings.find((x) => x.code === "UNACCOUNTED_RECORDS");
    assert.ok(f, "the blind spot must be reported");
    assert.equal(f.severity, "info");
    assert.deepEqual(f.records, ["task-0001", "task-0002", "task-0004", "witness-0003"]);
    // and it must not be counted as a problem: exit status ignores info
    assert.equal(res.counts.critical + res.counts.major, 4);
  });
  it("Q1 catches the silent override", () => {
    const f = res.findings.find((x) => x.code === "SILENT_LANDING");
    assert.ok(f, "the case the ledger exists for");
    assert.equal(f.record_id, "override-0007");
    assert.equal(f.severity, "critical");
    assert.deepEqual(res.unauthorised, ["override-0007"]);
  });
  it("Q2 catches the authorisation that never took effect", () => {
    assert.ok(res.findings.some((x) => x.code === "AUTHORISED_NEVER_LANDED" && x.record_id === "nudge-0011"));
    assert.ok(res.findings.some((x) => x.code === "AUTHORISED_BUT_LOST" && x.record_id === "nudge-0009"));
  });
  it("a blocked nudge that never lands produces NO finding", () => {
    assert.ok(!res.findings.some((x) => (x.record_id ?? "") === "nudge-0005"), "silence is the correct outcome here");
  });
  it("an approved review that lands produces NO finding", () => {
    assert.ok(!res.findings.some((x) => (x.record_id ?? "") === "nudge-0006"));
  });
  it("the ledger's false claim is caught against the fold", () => {
    assert.ok(res.findings.some((x) => x.code === "OUTCOME_CLAIM_FALSE" && x.record_id === "nudge-0009"));
  });
  it("calibration counts the gate's yield and its leaks", () => {
    assert.equal(res.calibration.authorised, 3, "nudge-0006, nudge-0009, nudge-0011");
    assert.equal(res.calibration.authorisedLanded, 1, "only nudge-0006 took effect");
    assert.equal(res.calibration.authorisedLost, 1);
    assert.equal(res.calibration.authorisedNeverWritten, 1);
    assert.equal(res.calibration.refused, 1);
    assert.equal(res.calibration.refusedLeaked, 0, "the gate held");
  });
  it("a tampered ledger is reported as broken before anything is inferred", () => {
    const tampered = ex.ledger.map((e, i) => (i === 1 ? { ...e, action: "act" } : e));
    const r2 = check(tampered, ex.records);
    assert.ok(!r2.chain.ok);
    assert.ok(r2.findings.some((f) => f.code === "HASH_MISMATCH"));
  });
  it("an EMPTY ledger flags EVERY winner as a silent landing", () => {
    // The check needs no intent to find intent that was never declared.
    const r3 = check([], ex.records);
    const winners = [...new Set(Object.values(r3.folded.setters))].length;
    const silent = r3.findings.filter((f) => f.code === "SILENT_LANDING");
    assert.equal(silent.length, winners, "every setter is unauthorised when the ledger says nothing");
    assert.equal(silent.every((f) => f.severity === "critical"), true);
    assert.deepEqual(r3.unauthorised.sort(), ["nudge-0006", "override-0007", "override-0008", "override-0010"]);
  });
  it("--deep detects a setter that is decided by id order alone", () => {
    const recs = [
      { id: "a", kind: "task", parents: [], effects: { x: "from-a" }, reason: null },
      { id: "b", kind: "task", parents: [], effects: { x: "from-b" }, reason: null },
    ];
    const d = check([], recs, { deep: true });
    assert.ok(d.findings.some((f) => f.code === "ORDER_SENSITIVE"), "a coin-flip winner is not a fact");
  });
  it("--deep reports nothing when the outcome is robust", () => {
    const d = check(ex.ledger, ex.records, { deep: true });
    assert.equal(d.findings.filter((f) => f.code === "ORDER_SENSITIVE").length, 0);
  });

  return t;
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — REPORT RENDERING + CLI
// ═══════════════════════════════════════════════════════════════════════════

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", yellow: "\x1b[33m", blue: "\x1b[34m", green: "\x1b[32m", grey: "\x1b[90m",
};
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (col, s) => (useColour ? `${col}${s}${C.reset}` : s);
const SEV_COLOUR = { critical: C.red, major: C.yellow, warn: C.blue, info: C.grey };
const SEV_MARK = { critical: "CRITICAL", major: "MAJOR  ", warn: "WARN   ", info: "INFO   " };

const rule = (n = 78) => paint(C.grey, "─".repeat(n));
const head = (s) => `\n${paint(C.bold, s)}\n${rule()}`;

export function renderLedger(ledger) {
  const lines = [];
  lines.push(paint(C.bold, "  seq  kind       subject                    gate            conf"));
  for (const e of ledger) {
    const subject =
      e.kind === "override" ? e.record.id
      : e.nudge_id;
    const gate =
      e.kind === "decision" ? e.action.toUpperCase()
      : e.kind === "approval" ? `by ${e.by}`
      : e.kind === "observed" ? `landed=${e.landed}`
      : e.kind === "intent" ? (e.read?.misparented ? "MISPARENTED" : "—")
      : "—";
    const conf =
      e.kind === "decision"
        ? `apply=${e.confidence.apply?.toFixed(2) ?? "—"} parent=${e.confidence.parent?.toFixed(2) ?? "—"}`
        : e.kind === "intent" ? `key=${e.key}`
        : "";
    const mark = e.kind === "intent" && e.read?.misparented ? paint(C.red, " !") : "  ";
    lines.push(
      `  ${String(e.seq).padStart(4)}  ${e.kind.padEnd(10)}  ${String(subject).padEnd(25)}${mark}${gate.padEnd(15)}  ${paint(C.grey, conf)}`,
    );
  }
  return lines.join("\n");
}

export function renderResult(res, opts = {}) {
  const out = [];
  const cal = res.calibration;

  out.push(head("GATE CALIBRATION"));
  out.push(`  authorised by the gate        ${cal.authorised}`);
  out.push(`    ...and it took effect       ${cal.authorisedLanded}   (${cal.authorityYield})`);
  out.push(`    ...but lost the fold        ${cal.authorisedLost}`);
  out.push(`    ...and was never written    ${cal.authorisedNeverWritten}`);
  out.push(`  blocked or held by the gate   ${cal.refused + cal.held}`);
  out.push(`    ...and landed anyway        ${cal.refusedLeaked + cal.heldLeaked}`);
  out.push(`  never asked by the gate       ${cal.neverAsked}`);
  out.push(`    ...and landed anyway        ${cal.neverAskedLanded}`);
  out.push(`  hand-authored, declared       ${cal.declaredOverrides}`);
  out.push(`\n  ${paint(C.bold, "verdict:")} ${cal.verdict}`);

  out.push(head(`FINDINGS  (${res.findings.length})`));
  if (res.findings.length === 0) {
    out.push(`  ${paint(C.green, "nothing. every landing was authorised, every authorisation took effect.")}`);
  }
  for (const f of res.findings) {
    const col = SEV_COLOUR[f.severity] ?? "";
    out.push("");
    out.push(`  ${paint(col, SEV_MARK[f.severity])}  ${paint(C.bold, f.title)}   ${paint(C.grey, `[${f.question ?? "—"}]`)}`);
    out.push(`            ${f.detail}`);
    if (f.effect) out.push(`            ${paint(C.grey, "→ " + f.effect)}`);
  }

  out.push(head("SETTERS  (derived by the fold — the referee, not the ledger)"));
  const st = res.folded.setters;
  const keys = Object.keys(st).sort(cmpCodePoint);
  if (!keys.length) out.push("  (none)");
  for (const k of keys) out.push(`  ${k.padEnd(24)} = ${String(res.folded.state[k]).padEnd(18)} set by ${st[k]}`);
  if (res.folded.conflicts.length) {
    out.push("");
    out.push("  conflicts:");
    for (const c of res.folded.conflicts) {
      out.push(`    ${c.key}: ${c.winner} beat ${c.losers.join(", ")}`);
    }
  }

  out.push("");
  out.push(
    `  ${res.counts.critical} critical  ${res.counts.major} major  ${res.counts.warn} warn  ${res.counts.info} info` +
      `   ${paint(C.grey, `ledger ${res.chain.length} entries, chain ${res.chain.ok ? "verified" : "BROKEN"}`)}`,
  );
  out.push(`  ${res.ok ? paint(C.green, "ok") : paint(C.red, "FAILED")} — exit ${res.ok ? 0 : 1}`);
  out.push("");
  return out.join("\n");
}

// ---- filesystem helpers ---------------------------------------------------

function readFileSafe(path) {
  return fs.readFileSync(path, "utf8");
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) out.flags[a.slice(2)] = argv[++i];
      else out.flags[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

const USAGE = `
gitpp-intent-ledger ${VERSION} — an append-only intent ledger for git.pp nudges

USAGE
  node intent-ledger.mjs <command> [options]

COMMANDS
  example                 run the worked example end to end and print the report
  selftest                run every assertion
  check                   reconcile a ledger against a record set
  fold                    just fold a record set (the §5.2/§5.6 referee)
  ledger                  print a ledger file as a table

OPTIONS
  --ledger <path>         JSONL ledger file
  --records <path>        JSON array of git.pp records
  --out <dir>             (example) write ledger.jsonl + records.json here
  --deep                  (check) also probe whether each outcome survives a
                          reversed fold tie-break order
  --json                  machine-readable output
  --no-colour             plain text

EXIT CODES
  0  no critical and no major findings
  1  findings — something landed without authority, or authority without effect

The core check makes NO network call and does NOT read TYPESAFE_AI_TOKEN.
`;

function cmdExample(args) {
  const { records, ledger, log } = workedExample();
  if (args.flags.out) {
    const dir = args.flags.out;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/ledger.jsonl`, serialise(ledger));
    fs.writeFileSync(`${dir}/records.json`, JSON.stringify(records, null, 2) + "\n");
    process.stderr.write(`wrote ${dir}/ledger.jsonl and ${dir}/records.json\n`);
  }
  if (args.flags.json) {
    process.stdout.write(JSON.stringify({ records, ledger }, null, 2) + "\n");
    return 0;
  }
  console.log(head("THE WORKED EXAMPLE — five nudges, one ledger"));
  for (const l of log) console.log("  " + l);
  console.log(head("THE LEDGER  (append-only, hash-chained)"));
  console.log(renderLedger(ledger));
  console.log(head("THE RECORD SET  (what the substrate actually holds)"));
  for (const r of records) {
    console.log(`  ${String(r.id).padEnd(14)} ${String(r.kind).padEnd(9)} parents=[${r.parents.join(", ")}]  ${canon(r.effects)}`);
  }
  console.log(head("THE CHECK"));
  console.log(head("  Q1 — did any nudge land that the gate did not authorise?"));
  const res = check(ledger, records, { deep: args.flags.deep === true || args.flags.deep === "true" });
  const q1 = res.findings.filter((f) => f.question === "Q1");
  console.log(q1.length ? q1.map((f) => `       YES → ${f.code} ${f.record_id}`).join("\n") : "       no");
  console.log(head("  Q2 — did any gate authorise a nudge that did not land?"));
  const q2 = res.findings.filter((f) => f.question === "Q2");
  console.log(q2.length ? q2.map((f) => `       YES → ${f.code} ${f.record_id}`).join("\n") : "       no");
  console.log("");
  console.log(renderResult(res));
  console.log(head("WHY override-0007 MATTERS"));
  console.log(wrap(NARRATIVE["override-0007"], 74).map((l) => "  " + l).join("\n"));
  console.log("");
  console.log(wrap(NARRATIVE["nudge-0009"], 74).map((l) => "  " + l).join("\n"));
  return res.ok ? 0 : 1;
}

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

function cmdCheck(args) {
  if (!args.flags.ledger || !args.flags.records) {
    console.error("check needs --ledger <path> and --records <path>");
    return 2;
  }
  const led = loadLedger(args.flags.ledger);
  let records;
  try {
    records = JSON.parse(readFileSafe(args.flags.records));
  } catch (e) {
    console.error(`cannot read records: ${e.message}`);
    return 2;
  }
  const res = check(led.entries, records, {
    deep: args.flags.deep === true || args.flags.deep === "true",
    unparseable: led.unparseable,
  });
  if (args.flags.json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
  else console.log(renderResult(res));
  return res.ok ? 0 : 1;
}

function cmdFold(args) {
  if (!args.flags.records) {
    console.error("fold needs --records <path>");
    return 2;
  }
  console.log(JSON.stringify(derive(JSON.parse(readFileSafe(args.flags.records))), null, 2));
  return 0;
}

function cmdLedger(args) {
  if (!args.flags.ledger) {
    console.error("ledger needs --ledger <path>");
    return 2;
  }
  const led = loadLedger(args.flags.ledger);
  console.log(renderLedger(led.entries));
  const v = verifyChain(led.entries);
  console.log(`\n  chain: ${v.ok ? "verified" : "BROKEN"}  (${v.length} entries, head ${String(v.head).slice(0, 16)}…)`);
  if (!v.ok) for (const f of v.findings) console.log(`    ${paint(C.red, f.code)} at ${f.where}: ${f.detail}`);
  return v.ok ? 0 : 1;
}

function cmdSelftest() {
  const results = selftest();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    if (r.ok) console.log(`  ${paint(C.green, "PASS")}  ${r.name}`);
    else console.log(`  ${paint(C.red, "FAIL")}  ${r.name}\n        ${r.why}`);
  }
  console.log(`\n  ${results.length - failed.length}/${results.length} passed`);
  return failed.length ? 1 : 0;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0] ?? "example";
  switch (cmd) {
    case "example": return cmdExample(args);
    case "selftest": return cmdSelftest();
    case "check": return cmdCheck(args);
    case "fold": return cmdFold(args);
    case "ledger": return cmdLedger(args);
    case "-h":
    case "--help":
    case "help": console.log(USAGE); return 0;
    default: console.error(`unknown command "${cmd}"\n${USAGE}`); return 2;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) process.exit(main());
