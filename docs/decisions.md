# Initial architecture decisions

The public interface is an ACP v1 stdio executable. Internal interfaces are
documented contributor seams, not a supported embedding or plugin API.
Pi extensions remain the customization mechanism.

- Launch installed Pi 0.99.1; reject unverified versions. Require Node >=22.19.
- Pin ACP SDK 1.5.1. Negotiate form elicitation; unsupported dialogs are cancelled.
- Own a small bounded Pi transport. The official RpcClient does not provide the
  required executable launch, response validation, buffering, or deadline policy.
- One child per active session; one prompt per session. Reject concurrent prompts.
  Allow independent sessions concurrently. Process generations invalidate old work.
- Pi owns conversation persistence. Replay the original active branch, including
  pre-compaction messages. Context edits affect model context, not original history.
- Emit live IDs without changing them midstream. Historical IDs derive from the
  persisted entry and block index. A minimal alias store may retain verified live
  aliases; never retain redundant transcripts or question answers.
- Preserve Pi's existing project trust and provider configuration. Explicit CLI
  trust overrides are optional; never silently pass --approve.
- Support macOS, Linux, and Windows; CI must test process and packaging semantics.
- Release defaults: @airterm/pi-acp 0.1.0, airterm-pi-acp, MIT. Public repository
  URL and publication are separate decisions, not implicit implementation actions.

## Initial bounds

Limits are checked before parsing or constructing previews. Bytes mean UTF-8
bytes. Control responses default to 10 seconds, startup to 30 seconds, prompt
preflight to 30 seconds of noninteractive inactivity, cancellation to 5 seconds,
and each shutdown escalation stage to 1 second. Model runs have no duration cap.

| Resource | Bound | Exhaustion behavior |
| --- | ---: | --- |
| Pi / ACP record | 16 MiB | Protocol failure and owned-process cleanup |
| Pending Pi controls / ACP requests | 64 each | Reject the new request |
| Queued Pi writes | 64 records / 16 MiB | Reject and fail the affected generation |
| ACP prompt text | 1 MiB | Reject before sending to Pi |
| Encoded image bytes, total | 8 MiB | Reject before sending to Pi |
| Retained message / turn data | 16 MiB | Fail the turn and stop its child |
| Queued ACP updates | 1 MiB / 1,024 records | Fail and stop affected session |
| Single tool output | 512 KiB | Explicitly truncated standard content |
| Patch / requested write contents | 256 KiB each | Explicit truncation; preserve tool outcome |
| Displayed image / tool arguments | 512 KiB | Explicit omission; preserve input sent to Pi |
| Session file | 64 MiB / 100,000 entries | Explicit load failure |
| History replay | 8 MiB | Explicit load failure before replay |
| Discovery | 10,000 files / 5 seconds | Paginated bounded listing or explicit error |
| Open sessions | 16 | Reject new/load until a session is closed |
| Question answer / prefill | 64 KiB | Cancel invalid interaction |
| Question options | 256 | Cancel unsupported interaction |
| Unanswered client forms | 64 per connection | Cancel new interaction with bounded diagnostic |
| Adapter diagnostics | 256 characters per message | Never retain or forward raw child stderr |

The update queue is bounded by serialized UTF-8 bytes. Tool text and previews
include JSON escaping in their display budget. Output delivery has a 15-second
stall deadline; a stalled connection closes all owned sessions. Each turn holds
at most 4,096 finalized messages/tools and 16 simultaneous message boundaries.
Per-session writer leases heartbeat every 2 seconds and expire after 10 seconds.
Discovery paginates bounded snapshots, not unbounded filesystem scans.

Cancellation always returns ACP `cancelled`; escalation is reflected in session
health and stderr. An escalated child is unavailable until explicit load/resume.
Form elicitation has no general remote dismissal method: retire locally, discard
late replies, and document that a client may still display a stale form.
