# Security

Pi's tools and extensions run with the Pi process's operating-system permissions.
The adapter adds no sandbox, universal approval boundary, or protection against
untrusted prompt content. Project trust is handled by Pi and does not constrain
tool filesystem access.

Provider credentials stay in Pi's existing configuration/environment. The adapter
does not implement authentication forms, rewrite configuration, log raw Pi stderr,
or store question answers. Pi's own session files can contain sensitive prompts,
tool arguments, and output; review them before sharing.

Protocol records, retained state, previews, requests, and history are bounded.
Unsupported capabilities are rejected rather than ignored. Session leases cover
other instances of this adapter; they do not lock out interactive Pi or unrelated
programs editing the same files.

Do not include credentials or raw private transcripts in public reports. Until a
public repository and private reporting channel are established, report issues to
the maintainer through an existing private contact. A published release must name
its actual private reporting channel here.
