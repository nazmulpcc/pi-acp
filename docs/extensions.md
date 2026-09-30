# Pi extensions, commands, and tools

Pi loads extensions, skills, and prompt templates through its normal configuration
and trust rules. The adapter advertises Pi's actual command catalog and forwards
invocations unchanged; Pi performs template and skill expansion. Commands can
complete without a model run, or ask questions before prompt acceptance.

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
