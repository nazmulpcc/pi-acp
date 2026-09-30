# Configuration

The executable is the public interface; there is no supported TypeScript
embedding or adapter plugin API in this release.

| CLI option | Behavior |
| --- | --- |
| `--pi <executable>` | Launch installed Pi; default `pi` on PATH |
| `--session-dir <path>` | Override Pi session storage and discovery |
| `--approve` | Explicitly trust project resources for this child |
| `--no-approve` | Explicitly skip trust-gated project resources |
| `--help` / `--version` | Print information and exit |

Paths with `~` are expanded for session storage. Relative session directories
resolve from the adapter launch directory for the CLI override. Pi configuration
`sessionDir` values resolve from the session working directory. A Pi executable
argument is passed as one executable, never interpreted as a command string.

Storage precedence is CLI override, `PI_CODING_AGENT_SESSION_DIR`, project
`.pi/settings.json`, agent-directory `settings.json`, then Pi's default directory.
`PI_CODING_AGENT_DIR` selects Pi's agent directory; the usual default is
`~/.pi/agent`. The adapter does not edit these settings.

Without a trust override, Pi follows its saved trust decisions, user extensions,
and global `defaultProjectTrust`. RPC cannot display Pi's built-in trust prompt;
untrusted project resources can therefore be skipped. Save a decision using Pi's
interactive `/trust`, or supply an intentional process override. Trust is not a
filesystem sandbox. Pi reads project `sessionDir` before its trust decision.

Models and thinking levels appear as ACP configuration selectors using choices
returned by Pi. Changes require an idle session and refresh the choices and
current values. Do not use an adapter form to collect provider credentials.

Resource bounds and deadlines are fixed and listed in [decisions](decisions.md).
No background updates, upstream downloads, telemetry, or automatic version
expansion run during a session.
