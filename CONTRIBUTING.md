# Contributing

Keep the adapter small, understandable, and independent. Pi owns agent execution;
ACP owns the client protocol. Explain each change and the lifecycle or translation
contract it affects. A public plugin or embedding API requires a separate design.

## Checks

Use Node >=22.19 and install with `npm ci --ignore-scripts`.

```sh
npm run check
npm run test:live
npm run test:package
```

Pure and fake-process tests run without Pi or credentials. Live tests require Pi
0.99.1 on PATH and inject a deterministic provider into an isolated process;
they exercise actual Pi dialogs, tools, errors, cancellation, and persistence.
Package checks install the tarball in a clean project and speak public ACP to its
executable. They verify runtime dependencies, files, executable discovery, and EOF.

`npm run test:model` separately exercises the public CLI with real
`zai/glm-5.3-flash`, including tool operations, input, restart and cancellation.
It reads existing Pi credentials, uses private temporary copies, and incurs
provider usage. It is opt-in and is not part of credential-free CI.

Use sanitized, minimal fixtures with pinned provenance. Never record secrets or
copy a private transcript into tests. Preserve attribution for any copied code or
copyrightable fixture. Keep docs and tests beside the behavior they establish.

## Commits and releases

Make independently passing signed increments; keep messages below 150 characters.
Verify signatures with `git verify-commit HEAD`. Do not commit keys, credentials,
tarballs, build output, or temporary session state.

Before release, all supported OS/Node CI jobs and artifact checks must pass.
Record the tested Pi commit and SDK version. Set public repository/bugs/homepage
metadata only after its owner and URL are confirmed. Review license material,
changelog, supported/unsupported features, and the compatibility matrix. Publish
through a reviewed release with npm provenance when available. Publication and
repository creation require the maintainer's explicit instruction.

## Reporting

Bug reports should provide versions, platform, expected/actual behavior, and a
small reproduction. Capability requests should identify a documented ACP/Pi
contract and the client behavior they enable. Follow [SECURITY.md](SECURITY.md)
for security reports. No automated issue-closing gate is used by this project.
