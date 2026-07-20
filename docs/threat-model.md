# Threat model — untrusted text (v1)

Scope: player-authored text reaching agent consumers through
kami-lens. Policy: [DESIGN §3.10](../DESIGN.md). This document names
the vectors the policy prices in; it does not claim to neutralize
them. Facts below are measured at the pinned upstream commit
(`UPSTREAM` file) — see the study errata, second pass.

## Attack surface (measured)

- **Names** (kami, account): ≤16 bytes, unique, non-empty — and
  **no charset restriction**: control characters, newlines, and
  zero-width codepoints are all accepted on-chain.
- **Account bio**: ≤140 bytes of free text.
- **Chat**: no on-chain length cap. The web client's 200-char limit
  is send-side input validation; a direct contract caller
  (`ChatSystem.executeTyped`) can emit arbitrarily large messages.
  Received chat is unbounded adversarial input.
- Kamiden payloads otherwise carry no player-authored text (IDs,
  indices, amounts); names in feeds and markets are rendered via
  consumer-side joins against the mirror's `Name` component.

## The named cheap vector: account-name swarm

Account names are free-form at registration — any 16 bytes at the
cost of an account. Kami renames are materially more expensive (Holy
Dust item + presence in room 11). Room-presence and node-occupancy
queries list accounts and kamis by name; N cooperating accounts
parked in one room deliver N ordered 16-byte fragments to any agent
that habitually checks occupancy before acting — fragments that
compose into instructions. On-chain uniqueness does not mitigate:
near-variants (`IGN0RE`, `1GNORE`) are trivially available.

## Delivery paths into an agent context

1. Default outputs containing `authored-id` strings: occupancy,
   presence, party, feeds, markets — names inline, envelope-tagged.
2. Opt-in outputs containing `authored-prose`: bio (explicit flag),
   chat (dedicated query). Never present in default outputs or
   reports.

## Mitigations (policy, gate-checked — not promises)

- Envelope tagging on every response; list generated from
  schema × classification, CI-checked (gate G3.f).
- Fail-safe classification: unlisted string fields are
  `authored-prose` — never volunteered.
- Composition defaults: prose never in default outputs or reports
  (fixture-swept by gate G4.c).
- Name-free mode (`--no-authored` / config): `authored-id` withheld
  with receipt, stable IDs for joins — for consumers that want zero
  attacker-influenced bytes by default.
- Chat: withhold-with-receipt on oversize messages, both-layer
  stream exclusion (topic filter + ingestion drop, gate G4.b),
  config kill-switch.
- No mutation, ever: values are verbatim or absent-with-receipt;
  sanitization is not attempted because no transform makes arbitrary
  text safe for an LLM context, and a "sanitized" string invites
  misplaced trust.

## Residual risk — stated plainly

Tagging does not make injection safe. A consumer that concatenates
authored values into an LLM context has ingested adversarial input
regardless of tags. The envelope enables mechanical quarantine; it
does not perform it. Consumers that feed authored text to a model do
so knowingly; the name-free mode exists for those who won't.
