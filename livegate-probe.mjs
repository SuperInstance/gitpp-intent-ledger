#!/usr/bin/env node
// OPTIONAL. Probes the live TypeSafe/Jev gate so the fixture in the worked
// example can be sanity-checked against a real endpoint.
//
// NOT part of the core check. NOT imported by intent-ledger.mjs. The core check
// never touches the network and never reads TYPESAFE_AI_TOKEN.
//
//   node livegate-probe.mjs
//
// Both outcomes below are CORRECT behaviour, not a bug:
//   ERROR  the transport failed (throw — do not proceed)
//   BLOCK  no usable calibrated numbers came back (fail closed, §5.7)
// api.typesafe.ai is intermittently returning 503 with upstream TLS errors, so
// treat anything this prints as a smoke test, not a measurement.

import { derive, proposeNudge, liveGate } from "./intent-ledger.mjs";

const records = [
  { id: "task-0001", kind: "task", parents: [], effects: { "release.channel": "stable" }, reason: "ship stable" },
  { id: "task-0002", kind: "task", parents: [], effects: { "build.green": true }, reason: "ci green" },
];
const folded = derive(records);

const probes = [
  ["well-founded (staged canary)", proposeNudge(records, folded, "release.channel", "canary", { id: "probe-good", reason: "5% of users, staged" })],
  ["unjustified (promote to prod)", proposeNudge(records, folded, "release.channel", "production", { id: "probe-bad", reason: "no reason given" })],
];

if (!process.env.TYPESAFE_AI_TOKEN) {
  console.error("TYPESAFE_AI_TOKEN is not set — nothing to probe. The core check does not need it.");
  process.exit(2);
}

for (const [label, proposal] of probes) {
  try {
    const d = await liveGate(proposal, { state: folded.state, folded });
    console.log(`${label.padEnd(34)} -> ${d.action.toUpperCase().padEnd(6)} apply=${d.apply} parent=${d.parent}  [${d.source}]`);
  } catch (e) {
    console.log(`${label.padEnd(34)} -> ERROR ${String(e.message).split("\n")[0].slice(0, 90)}`);
  }
}
