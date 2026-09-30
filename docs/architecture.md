# Architecture

The adapter is provider-specific, with a CLI contract and small internal seams.
No Pi runtime dependency is imported into the package. The official ACP SDK owns
ACP v1 decoding, JSON-RPC correlation, and its bounded stdio stream.

```text
ACP service → session registry → session controller → Pi transport → Pi child
                      ↓                  ↓
                  discovery         transcript projector → ordered ACP output
                                         ↓
                                  native interaction bridge
```

## Ownership

- The service negotiates capabilities, reserves session openings, validates
  workspace identity, lists sessions, and routes public requests.
- A session owns exactly one process generation, one prompt, its interaction
  bridge, transcript reconstructor, and ordered output queue.
- Transport owns LF framing, pending controls, backpressure, deadlines, child
  exit, and shutdown. Retired responses cannot become session events.
- Transcript projection owns message/block and tool identity. It performs no
  filesystem, process, timer, or client operations; live and replay share it.
- Storage owns bounded discovery and history reads, per-session leases, and
  atomic identity metadata. Pi owns the conversation itself.
- History projection validates the active branch, groups user turns with cross-turn
  tool links, and selects a newest display window within 8 MiB. Oversized groups
  become compact displays with explicit omission hints; Pi loads the full file.
- Interactions own validation, dialog IDs, timeout retirement, and same-dialog
  replies independently of the output queue and prompt acknowledgement.

## Lifecycle

Install readers before sending a prompt. Enter preflight, account for interactions,
then process the authoritative disposition. `started` keeps the prompt open;
`handled` probes state and completes if no independent work is active. Unexpected
`queued` is rejected. A short acceptance deadline never covers model execution.

`agent_end` can precede retries, compaction, or continuations. Settlement requires
`agent_settled` plus an idle-state check. A fast settled event before acceptance is
retained. Final updates flush before the prompt response. Cancellation dominates
the response reason and has a separate escalation deadline. Closure and failures
invalidate the child generation and release pending work.

Incoming events are ingested synchronously into bounded state. Outbound client
updates are ordered asynchronously; a question or slow prompt never blocks
control-response ingestion. Queue exhaustion and output stalls are explicit
failures. Metadata and configuration are refreshed at startup and settlement.

## Contributor seams

Add tool presentation in the pure projector. Add an upstream RPC version through
validated types, sanitized fixtures, and compatibility tests. Add ACP capabilities
only with negotiated behavior and public-client coverage. Keep transport and
storage injectable for deterministic tests; internal exports carry no semver API
promise. Do not introduce a generic provider harness or a second extension system.

Read [decisions](decisions.md) before changing bounds, history semantics, process
ownership, or supported versions. New externally visible behavior must update its
user guide, compatibility evidence, and changelog in the same increment.
