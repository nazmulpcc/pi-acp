# Pi ACP

An independent [Agent Client Protocol](https://agentclientprotocol.com) adapter
for the [Pi coding agent](https://github.com/earendil-works/pi).

```text
ACP client ↔ airterm-pi-acp ↔ installed Pi in RPC mode
```

Use Pi's models, tools, skills, prompt templates, and supported extension dialogs
from an ACP client. The adapter streams reasoning and messages, reports tools,
supports cancellation, and can list and reopen Pi sessions. It uses Pi's own
storage and provider configuration.

## Get started

Requires Node.js **22.19 or newer** and installed Pi **0.99.1**. Other Pi versions
are rejected until verified. Configure a provider in Pi before starting the adapter.

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.99.1
pi
# Configure your provider in Pi, then exit.
```

The adapter's first release is in development and has not been published. Build
and run it from this repository:

```sh
npm ci --ignore-scripts
npm run check
node dist/cli.js --help
```

Configure your ACP client to launch `node /absolute/path/to/pi-acp/dist/cli.js`.
The working directory comes from each ACP session request.

After publication, the package will be `@airterm/pi-acp` and its executable will
be `airterm-pi-acp`. There is no AirTerm service, browser, account, or runtime
dependency.

## Documentation

Start with the [documentation index](docs/index.md) for client setup,
configuration, sessions, extension compatibility, troubleshooting, and contributor
architecture. See the [compatibility matrix](docs/compatibility.md) for verified
behavior and release gates.

Pi performs tool operations locally with its process permissions. This adapter
does not add sandboxing or universal tool approvals. ACP-provided MCP servers,
additional workspace roots, audio, and custom terminal widgets are unsupported.

## Development

```sh
npm run check
npm run test:live
npm run test:package
```

Normal tests use fake Pi processes and need no credentials. Live tests use the
installed Pi with an isolated deterministic provider extension, real built-in
tools, and temporary storage. They do not use a paid provider or alter your
normal configuration. Read [CONTRIBUTING.md](CONTRIBUTING.md).

For an opt-in test against the real `zai/glm-5.3-flash` provider, configure its
credentials in Pi and run `npm run test:model`. This incurs provider usage.

## License

MIT. Dependency attribution is in [NOTICE](NOTICE).
