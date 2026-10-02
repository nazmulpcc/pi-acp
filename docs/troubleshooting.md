# Troubleshooting

## Pi cannot start

Run `pi --version` to check the executable starts successfully. Confirm that the ACP
client inherits a PATH containing Pi, or supply `--pi`. Node must be >=22.19.0.
`--pi` takes an executable path, not an executable plus embedded arguments.

Configure provider credentials in Pi directly. A provider failure appears as an
ACP error, not a successful end turn. Recoverable retries keep the prompt open.
Raw Pi stderr is drained but never forwarded or retained; reproduce startup
problems in Pi itself using your own environment.

## Missing project commands or extensions

Check Pi's project trust. RPC has no built-in trust prompt. Use interactive Pi to
save a trust decision, then restart the session. `--approve` is an explicit
process-level override. Confirm that Pi's command catalog includes the command.

## Questions are cancelled

The client must advertise form elicitation. Some ACP clients implement core
messaging without forms. The adapter cancels unsupported questions so Pi cannot
remain blocked indefinitely. Invalid options, oversized answers, and expired
dialogs are also cancelled.

## Session already owned, missing, or unavailable

Close the same session in another adapter before reopening. After an abrupt
crash, wait at least ten seconds for the heartbeat lease to become stale. Do not
delete a live lease. Supply the original workspace and storage override; a global
list cannot discover arbitrary project-specific directories it has never seen.

Forced cancellation or protocol failure marks a session unavailable until explicit
load/resume. The adapter preserves Pi's file. It never silently creates a new
conversation in place of a missing one.

## History or output exceeds a bound

Tool output is explicitly truncated. Large display history restores a bounded
newest window with a visible omission notice; Pi still has the complete session
for continuation. A single oversized turn uses a compact display. There is
no hidden partial transcript. See [limits](decisions.md). Unexpected framing,
oversized records, and a stalled ACP output pipe cause process cleanup rather
than unlimited buffering.

When reporting a bug, include adapter/Pi/Node versions, OS, the failing public ACP
method, and a small sanitized reproduction. Never attach credentials, raw session
files, or complete environment dumps without reviewing their contents.
