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
| Pending Pi controls | 64 | Reject the new request |
| ACP prompt text | 1 MiB | Reject before sending to Pi |
| Image bytes, total | 8 MiB | Reject before sending to Pi |
| Retained message / turn data | 16 MiB | Fail the turn and stop its child |
| Queued ACP updates | 1 MiB / 1,024 records | Fail and stop affected session |
| Single tool output | 512 KiB | Explicitly truncated standard content |
| File preview | 256 KiB | Omit preview; preserve tool outcome |
| Session file | 64 MiB / 100,000 entries | Explicit load failure |
| History replay | 8 MiB | Explicit load failure before replay |
| Discovery | 10,000 files / 5 seconds | Paginated bounded listing or explicit error |
| Open sessions | 16 | Reject new/load until a session is closed |
| Question answer / prefill | 64 KiB | Cancel invalid interaction |
| Question options | 256 | Cancel unsupported interaction |
| Diagnostic retained bytes | 8 KiB | Drop excess; never forward raw child stderr |

Cancellation always returns ACP `cancelled`; escalation is reflected in session
health and stderr. An escalated child is unavailable until explicit load/resume.
Form elicitation has no general remote dismissal method: retire locally, discard
late replies, and document that a client may still display a stale form.
