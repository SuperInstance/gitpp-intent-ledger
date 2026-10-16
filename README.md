# gitpp-intent-ledger

**An append-only record of what was INTENDED versus what OUTCOME was, over time, per nudge.**

Spec §5.6 made nudging reliably *expressible*. `gitpp-nudge` made it *verifiable* after the fact.
`gitpp-gate` asks whether a nudge should apply at all, before applying it, and fails closed when
the model gives no signal.

**None of them record intention versus outcome across a history.** A nudge can land and still be
wrong. A gate can be miscalibrated. A gate can authorise a nudge against a state that a later
override has already invalidated — the authorisation was real, the world it authorised for is gone.

Nothing in the substrate today compares them. That is this repo's job.

```
Single file. Node 18+. Standard library only. No network. No TYPESAFE_AI_TOKEN.
```

---

## The case this exists to catch

```json
{"id":"override-0007","kind":"override","parents":[],"effects":{"release.channel":"bleeding"},"reason":"yolo"}
```

Someone writes a record by hand. It lands — `override` outranks `task`, so the fold is **correct**
and the system is **wrong**. There is no intent entry. There is no gate decision. There is no trace.

Nothing else in the substrate can see this. The fold is pure and has no idea what anybody meant;
purity is the point. `gitpp-nudge` asks "did this nudge land?" about a nudge it was handed.
`gitpp-gate` asks "should this apply?" about a proposal it was handed.

**A check that starts from the ledger and asks what happened to each entry cannot find this,
because there is no entry.** So this check starts from the **record set** and asks what happened
to each record. Direction is the design.

```
$ node intent-ledger.mjs example

  Q1 — did any nudge land that the gate did not authorise?
       YES → SILENT_LANDING override-0007
       YES → DECLARED_OVERRIDE override-0008
       YES → DECLARED_OVERRIDE override-0010
```

---

## The two questions, and the third

| | |
|---|---|
| **Q1** | did any nudge land that the gate did not authorise? |
| **Q2** | did any gate authorise a nudge that did not land? |
| **Q3** | what did the gate actually get right? |

Q3 is not decoration. A ledger that only reports failures trains its readers to disable it.
The calibration block is what turns *"we found 3 problems"* into *"the gate gave 3 approvals and 2
did not take effect"* — which is the fact that changes a threshold.

Real output from the worked example:

```
GATE CALIBRATION
  authorised by the gate        3
    ...and it took effect       1   (33%)
    ...but lost the fold        1
    ...and was never written    1
  blocked or held by the gate   1
    ...and landed anyway        0
  hand-authored, declared       2

  verdict: the gate gave 3 approvals and 2 did not take effect;
           it is confident about a world that is not there
```

---

## Run it

```bash
node intent-ledger.mjs example                    # the worked example, end to end
node intent-ledger.mjs selftest                   # 43 assertions
node intent-ledger.mjs example --out ./fixture    # write ledger.jsonl + records.json
node intent-ledger.mjs check --ledger ledger.jsonl --records records.json
node intent-ledger.mjs check --ledger ledger.jsonl --records records.json --deep
node intent-ledger.mjs fold --records records.json
node intent-ledger.mjs ledger --ledger ledger.jsonl
```

Exit code `0` when there are no critical and no major findings, `1` otherwise — so the check drops
into CI without a wrapper.

### As a check in CI

```bash
node intent-ledger.mjs check --ledger ledger.jsonl --records records.json --json > findings.json
```

`--json` emits the whole result: findings, calibration, and the folded state.

---

## The worked example

Five nudges, one ledger, one record set.

| | nudge | what happened | verdict |
|---|---|---|---|
| **A** | `nudge-0005` | parented on the **wrong** record; gate says **BLOCK**; never written | gate is load-bearing ✔ |
| **B** | `nudge-0006` | correctly parented; gate says **REVIEW**; captain approves; **lands** | correct ✔ |
| **C** | `override-0007` | hand-authored, **nothing written to the ledger** | **← SILENT_LANDING** 🚨 |
| **C2** | `override-0008` | same act, but **declared** | accounted, still visible ⚠ |
| **D** | `nudge-0009` | gate says **ACT**… then a later override displaces it | **← AUTHORISED_BUT_LOST** 🚨 |
| **E** | `nudge-0011` | gate says **ACT**; never written | **← AUTHORISED_NEVER_LANDED** 🚨 |

**D is the one nobody has built for.** The gate was asked about a world in which `task-0002` still
set `build.green`. `override-0010` changed that *between the decision and the write*. The
authorisation was not wrong — it was about a state that no longer existed. The writer, watching the
write succeed, records `landed: true`. The fold says otherwise. Only a record of both events makes
that visible, and the check reports it twice over: `AUTHORISED_BUT_LOST` and `OUTCOME_CLAIM_FALSE`.

---

## Design

### The ledger is append-only and hash-chained

Every entry commits to its predecessor's hash. Editing entry 4 breaks entry 5 and every entry after
it, and the break is detectable with no server, no signature, and no notary:

```
$ # flip the BLOCK on nudge-0005 to ACT, without re-hashing
$ node intent-ledger.mjs check --ledger tampered.jsonl --records records.json

  CRITICAL  ledger chain broken
            #2: entry claims db9d945bd4c2…, content hashes to 10c6ea1ea3f2…
```

A log file can be rewritten wholesale. A chain cannot, without rewriting the present — and the
present is the part the fold can see.

### Five entry kinds

| kind | required | means |
|---|---|---|
| `intent` | `nudge_id, key, value, record, read` | someone meant something — **and against what state** |
| `decision` | `nudge_id, action, confidence` | a gate answered, with its numbers |
| `approval` | `nudge_id, by` | a human cleared a review |
| `override` | `record, by` | a human wrote a record by hand **and said so** |
| `observed` | `nudge_id, landed` | a **claim** about the outcome — checked, never trusted |

`intent.read` carries the read half of the read-then-write loop (setter, prior kind, state at read,
whether the nudge was misparented). Without it a stale authorisation is indistinguishable from a
fresh one, and that distinction is the entire point of case D.

### Outcome is derived, never declared

**"Landed" means the fold made this record the setter of at least one key.** §5.2 decides that,
not us. The ledger's own `observed` entries are treated as *claims* and compared; a claim that
disagrees with the fold is itself a finding (`OUTCOME_CLAIM_FALSE`).

This means the check needs no intent to find intent that was never declared. With an **empty**
ledger, every winner is correctly reported as a silent landing — that is an assertion in the
self-test.

### The gate adapter fails closed

`gateDecide` mirrors `gitpp-gate`'s `route()`, reimplemented rather than imported so the file
stands alone:

```
act     every required gate is confident enough
review  close to the threshold, or the gates disagree
block   a gate is confidently NO, or there was no signal at all
```

§5.7's one rule outranks the rest: **absent signal is not consent.** With no fixture for a nudge —
or a *partial* answer — the adapter returns `block`. There is no code path from "we don't know" to
"yes". Two self-tests assert this by deleting `TYPESAFE_AI_TOKEN` from the environment and running
the core check anyway.

### Findings

| code | sev | question |
|---|---|---|
| `SILENT_LANDING` | critical | Q1 |
| `BLOCKED_BUT_LANDED` | critical | Q1 |
| `UNGATED_LANDING` | critical | Q1 |
| `CHAIN_BROKEN` | critical | — |
| `SHADOWED_RECORD` | critical | Q3 |
| `REVIEW_LANDED_UNAPPROVED` | major | Q1 |
| `AUTHORISED_NEVER_LANDED` | major | Q2 |
| `AUTHORISED_BUT_LOST` | major | Q2 |
| `OUTCOME_CLAIM_FALSE` | major | Q3 |
| `DECLARED_OVERRIDE` | warn | Q1 |
| `ORPHANED_NUDGE` | warn | Q3 |
| `ORDER_SENSITIVE` | warn | Q3 |

`DECLARED_OVERRIDE` exists so that declaring is *cheaper than hiding*. A hand-authored record that
says so is listed at `warn`; one that says nothing is `critical`. Same act, different accounting —
and the incentive points the right way.

`--deep` re-folds with the tie-break order reversed and reports any key whose setter changes. If a
key's winner is decided by id order alone, then "it landed" was an artefact of an ordering the spec
calls a tie, and a ledger built on it is a ledger of coin flips.

---

## The fold, and what it costs me

`gitpp-doctor` is the Python reference for `derive()`. **It was not reachable with my token**
(`remote: Repository not found`), so the fold here is reimplemented from the spec text — §5.1 class
precedence, §5.2 streaming per-key resolution with the ancestry tie-break, §5.3 conflicts, §5.4
Kahn ordering, §5.5 orphans and cycles, §5.6 `setters`.

**This fold is not claimed conformant.** It is a reading, and the readings are listed in the source
at the end of Section 1 so they can be argued with:

1. §1.1 says both "defaults to `[]`" and "missing any of the five is malformed". Taken here as:
   defaults govern *absence*, the type rule governs *presence*.
2. §5.3 conflicts are emitted for keys with ≥2 **distinct values**, per that section's wording.
   §5.2's "one entry per key" describes the loser ledger, exposed separately as `.losers`.
3. Cycle-affected = everything Kahn could not emit, i.e. cycle members **and their descendants**.
4. Duplicate ids: last wins, and `.shadowed` names them.

Point it at `gitpp-doctor` and diff the two before trusting it anywhere the two could disagree. The
self-test covers precedence, both ancestry directions, orphan and cycle reporting, and the §5.6
mis-parenting demo — but conformance to the referee's corpus is unverified.

---

## Honest limitations

- **The fold is a spec reading, not the referee.** See above. Everything downstream inherits its
  errors.
- **"Landed" is a present-tense fact.** A record that landed and was later displaced is only
  visible if an `observed` entry was written at the time. The check re-derives the present; it
  cannot reconstruct a past it was not told about. Adding `snap` to `observed` would fix this and
  is the obvious next step.
- **`--deep` is a one-bit probe.** It tests one alternative ordering, not all of them. It is a
  smoke alarm, not a proof.
- **The live gate path is optional and flaky.** See below.

## The optional live path — measured, not claimed

`liveGate()` exists so the fixture can be shown to be a real shape. It is **not** used by the check
and **not** used by the example. Measured against `api.typesafe.ai` during the build:

```
$ node livegate-probe.mjs
well-founded (staged canary)            -> ERROR  Jev 503: upstream connect error … TLS_error
unjustified (promote straight to prod)  -> BLOCK  apply=null parent=null  [typesafe:jev]
```

Both outcomes are correct behaviour: the transport failed (throws) and the second returned no
usable calibrated numbers (**fails closed to `block`**). The endpoint is intermittently returning
`503` with upstream TLS errors, so **do not treat this path as reliable**, and do not read the
second line as a measured judgement — it is the fail-closed branch doing its job. Node's `fetch`
also cannot be told to skip certificate verification, which is why `curl -k` was needed to probe it
at all.

Gate data in the core check is a fixture. Always.

## Licence

MIT.
