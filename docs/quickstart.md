# Quickstart and clients

Install Pi and configure credentials directly in Pi. The adapter inherits
Pi's configuration and process environment. It does not provide a login form.

For the unpublished development version, build the repository with `npm ci
--ignore-scripts` and `npm run build`. Give your ACP client a command and argument
array:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-acp/dist/cli.js"],
  "env": {}
}
```

This describes the launch contract; the enclosing settings structure depends on
your client. A client must support ACP v1 over stdio. Forms require its
`clientCapabilities.elicitation.form` capability; without it, Pi questions are
cancelled with a diagnostic. Optional newer methods are separately advertised.

For example, clients using Zed's `agent_servers` configuration can wrap the
command in a custom server definition. Check your installed client's settings
reference; no editor-specific metadata is required for normal output or tools.

To select a Pi executable outside PATH:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-acp/dist/cli.js", "--pi", "/absolute/path/to/pi"],
  "env": {}
}
```

Keep stdout connected to the client: it is reserved for ACP records. Adapter
diagnostics go to stderr. `--help` and `--version` print informational output and
exit instead of opening a protocol connection.
