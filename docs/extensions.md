# Pi extensions, commands, and tools

Pi loads extensions, skills, and prompt templates through its normal configuration
and trust rules. The adapter advertises Pi's actual extension, skill and prompt
command catalog and forwards those invocations unchanged; Pi performs template
and skill expansion. Commands can complete without a model run, or ask questions
before prompt acceptance.

Pi's RPC catalog omits terminal commands such as `/name`. The adapter adds
`/name [name]` explicitly and implements it through Pi's name controls; see
[session names](sessions.md#session-names). If Pi already advertises a command
named `name`, that command keeps its original description and invocation
behavior. Other terminal commands are not implicitly advertised or emulated.

Supported native dialogs map to ACP forms:

| Pi method | Form field |
| --- | --- |
| `select` | String with the original option enum |
| `confirm` | Boolean with the original confirmation message |
| `input` | String; placeholder is retained as a description |
| `editor` | String with the original prefill as its default |

Multiline controls and placeholder styling depend on the client. A select or
confirm dialog is a question, not an inferred security approval. Answers go to the
original Pi dialog ID; answering never cancels and resubmits a prompt.

Malformed, oversized, or unsupported dialogs are cancelled. Timeouts retire
locally because Pi provides no retirement event. `$/cancel_request` requests
cooperative client cancellation; a client may leave an expired form visible.
Late replies are discarded. A connection admits at most 64 unanswered outbound
forms, including retired forms whose clients never respond.

Tools use standard ACP calls, locations, and content. Built-in bash snapshots
replace earlier snapshots. Edit output uses Pi's actual unified patch, rather
than guessed old file contents. Write output includes bounded requested new
content; exact previous file content is unavailable, so no whole-file write diff
is fabricated. The adapter performs no arbitrary file reads for previews.

### Machine-readable file previews

Successful built-in `edit`/`write` results emit `tool_call_update` with their
original `title` (`edit` or `write`), `kind: "edit"`, and a deliberately narrow
`rawOutput` object:

```json
{"path":"/absolute/path/sample.txt","patch":"--- a/sample.txt\n+++ b/sample.txt\n@@ -1 +1 @@\n-before\n+after\n","truncated":false}
```

```json
{"path":"/absolute/path/created.txt","newText":"created\n","truncated":false}
```

`patch` comes only from Pi's result `details.patch`. `newText` comes from the
successful write's requested `content`; it is not a post-write filesystem read.
`oldText` is absent: **unknown old contents must not be interpreted as an empty
file or a creation**. No arbitrary result details are forwarded. Failed writes,
in-progress tools, unknown tools, missing patches, and paths over 4,096 UTF-8
bytes after resolution do not receive these previews.

Each preview is at most 256 KiB including its JSON encoding. A truncated preview
contains an actual UTF-8 prefix and `truncated: true`, with no fabricated suffix.
Treat it as display data, not an executable complete patch. Ordinary ACP text
also provides a readable preview; this text may be shortened further by the
shared notification budget. Live results and historical replay use the same
field contract. Replay keeps at most 16 KiB of ordinary tool logs per result;
an oversized restored turn can also use smaller input/preview displays with
explicit omission metadata. Replay does not inspect today's files.

The **complete tool notification** is at most 512 KiB of UTF-8, including the
JSON-RPC envelope, session ID, arguments, previews, output and trailing LF.
`_meta.inputOmitted` explains omitted arguments; `_meta.outputTruncated: true`
signals output shortened or omitted to fit that shared budget. Status and tool
identity remain intact. Other ACP records have a separate 16 MiB complete
outbound ceiling; clients should accept that transport ceiling, then apply their
own smaller presentation/retention limits. Silently discarding lines over
512 KiB can still lose images, configuration or session-list responses.

Ordinary tool arguments remain exact. Oversized arguments are omitted from the
client projection with an omission marker; output is explicitly truncated at its
bound. Tool identity and failure remain visible. Unknown custom tools receive
generic content without guessed file or permission semantics.

Custom terminal components, widgets, editor-control notifications, and other
fire-and-forget TUI presentation are not recreated as assistant messages or
questions. Extensions that change the Pi session identity are rejected: use the
ACP session methods to select conversations. Extensions that replace already
streamed text with a non-prefix revision cause an explicit error because ACP v1
chunks cannot retract previously emitted content.
