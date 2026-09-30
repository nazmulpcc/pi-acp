# Sessions and history

`session/new` creates a Pi session in the requested absolute working directory.
Each active ACP session owns a separate Pi process. Up to 16 sessions can run
concurrently; each supports one prompt at a time. Another prompt in the same
session is rejected as busy. Steering and implicit queues are not supported.

`session/list` discovers bounded, validated Pi session headers without starting a
model or Pi process. Filter by `cwd` to discover a project's custom storage.
Unfiltered listing covers default storage, configured global storage, and custom
locations previously opened through the adapter. A project's arbitrary custom
directory is not discoverable globally until its workspace is supplied.

Lists return at most 100 sessions per page. Pass `nextCursor` unchanged to fetch
the next page with the same workspace filter. Cursors expire after 60 seconds.
Discovery exceeding 10,000 candidates or five seconds fails explicitly; it does
not return a deceptively complete list.

`session/load` restores the original Pi session and working directory and replays
the original active-branch transcript. Compaction and context edits affect Pi's
model context; they do not erase original displayed messages. Other branches are
not mixed into the transcript. History includes reasoning, tool arguments,
bounded results, and failed tools. Historical dialogs never execute or reopen.

`session/resume` restores the same session without replaying messages, for clients
that already retain the transcript. `session/close` releases its owned process and
lease without deleting Pi's conversation. Missing, corrupt, unsupported-version,
oversized, or wrong-workspace sessions fail; they are never replaced silently.

Live block IDs remain stable through streaming. A minimal atomic alias file maps
verified persisted entries to live IDs using append order, roles, and tool links,
never text hashes. Entries without a verified alias use stable persisted-entry
IDs. Interrupted runs or unusual extension persistence can lack aliases; this is
reported diagnostically. No duplicate transcript or dialog answer is stored by
the adapter. These files live in `<Pi agent directory>/pi-acp`.

A per-session heartbeat lease excludes simultaneous writers from other copies of
this adapter. Stale leases become recoverable after ten seconds. This lease does
not coordinate with Pi's interactive terminal or arbitrary external writers;
close a session in one application before editing it in another.

Cancellation retires questions, clears queued work, and aborts applicable Pi
operations. A prompt responds `cancelled`. If Pi has not stopped after five
seconds, the adapter escalates owned-child cleanup and marks the session
unavailable. Reopen explicitly to continue. EOF and termination signals also
clean up owned processes. Unrelated Pi processes are never targeted.
