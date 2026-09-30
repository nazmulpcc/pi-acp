# Compatibility and verification

The first release targets **Pi 0.99.1**, **ACP protocol v1**, and **Node >=22.19**.
The adapter pins ACP TypeScript SDK **1.5.1**. Other Pi versions fail explicitly;
expanding support requires source review and passing fixtures and live checks.

[Pi reference source](https://github.com/earendil-works/pi/tree/1b347794e2a630e4359f2584f4eea388145d0ddf).
The existing [svkozak/pi-acp reference](https://github.com/svkozak/pi-acp/tree/b0581c9c1d675e634234674484247008b03d69b4)
is not a runtime dependency.
This implementation does not claim general ACP conformance certification.

## Feature matrix

| Feature | Guarantee | Evidence |
| --- | --- | --- |
| Initialize and capabilities | ACP v1; capabilities reflect supported operations | Independent SDK client and installed CLI |
| New/list/load/resume/close | Original workspace, Pi storage, bounded discovery; load replays and resume does not | Public-client tests; real Pi load and provider restart |
| Prompt lifecycle | Disposition handled explicitly; settle after idle state; flush before result | Fast settlement, handled-command, retry and failure fixtures |
| Concurrent sessions | One owned child per session; reject concurrent prompts in one session | Public-client isolation and cancellation tests |
| Cancellation | Retire dialogs, abort work; close owned child on deadline | Question races, fake processes and real model tool cancellation |
| Text and reasoning | Separate indexed blocks with explicit IDs; reject contradictory finals | Live/replay projector tests and real Pi reasoning |
| Original transcript | Follow active parents; retain pre-compaction and context-edited original messages | Branch, compaction and context-edit fixtures |
| Identity | Verified structural aliases preserve live IDs on reopen; otherwise explicit persisted-ID fallback | Identical-message fixtures and real-model adapter restart |
| Tools | Arguments, status, absolute known-tool locations, replacement output | Fake process and actual Pi read/write/edit/Bash |
| Edits and writes | Bounded rawOutput.path/patch/newText with explicit truncation; unknown old contents remain absent | Live/replay field equivalence, actual Pi patches and file assertions |
| Native dialogs | Negotiated select/confirm/input/editor forms; same original Pi request | Interaction races, actual Pi question tools and real model input |
| Models/thinking | Actual Pi choices exposed through config options | Public-client configuration and real provider selection |
| Commands | Pi extension/skill/prompt catalog; Pi performs expansion | Catalog fixture and actual extension command without a model run |
| Image/context prompts | Bounded inline images and embedded text; links passed as references | Input validation; provider/image use is not yet live verified |
| Ownership and bounds | LF framing, complete tool/wire budgets, pending/write/output limits, leases, startup/EOF cleanup | Escaped-envelope, fragmentation, backpressure, special-file, disconnect and packed CLI tests |

## Unsupported or intentionally limited

ACP-provided MCP servers, additional workspace roots, audio, agent-side generic
authentication, steering, forks/tree navigation, terminal widgets and Pi
`custom()` UI are unsupported. No client filesystem or terminal capability is
advertised. Pi tools use the Pi process's OS permissions; native questions do not
create a sandbox or universal approval boundary.

History loading is bounded and fails before replay on unavailable, malformed or
oversized history. Tool output, argument display, patches and images have explicit
display limits. Images over 512 KiB are represented by an omission notice in the
transcript, while accepted input is still sent to Pi. See [bounds](decisions.md),
[sessions](sessions.md) and [extensions](extensions.md).

## Recorded local verification

On 30 September 2026, macOS checks passed on Node 22.19 and 26 with installed Pi
0.99.1, including clean packed installation. The public CLI
was also exercised against the real **zai/glm-5.3-flash** provider: read, write,
edit, Bash, a native input question, follow-up, adapter restart/load identity and
cancellation of a running tool. These are smoke tests of this provider, not a
promise about every model or provider.

`npm run test:live` uses a deterministic provider extension inside actual Pi.
It needs no provider credentials. `npm run test:model` is a separate opt-in test
that uses existing Pi credentials and incurs zai provider usage. It copies auth
and model configuration privately to temporary storage and removes that storage
after the test. Neither test changes the normal Pi configuration.

The CI workflow defines macOS/Linux/Windows jobs on Node 22.19, 24 and 26.
**Linux and Windows results are pending until this repository has run CI.**
No editor-specific integration or npm publication has been verified yet.

## Release gates

All OS/Node CI jobs must pass before declaring those combinations verified.
Each job typechecks, builds, runs pure/fake tests, exercises installed Pi, installs
the packed artifact into a clean project and runs its actual executable over
stdio. A release also requires reviewed repository metadata, licenses,
changelog, signed increments and maintainer-authorized publication.
