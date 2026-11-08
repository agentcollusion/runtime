# Runtime 0.1.0-beta.2

This release adds an offline audit checkpoint and receipt inclusion verifier.
Keep a checkpoint outside the runtime to detect later signed exports that rewind
or rewrite the retained history. Check a terminal receipt against an audit before
using it as evidence. These checks do not prove freshness or real-world effects.

The package now includes TypeScript declarations for the client, server,
worker and evidence APIs and a VS Code Tasks example for local development.
Existing beta.1 receipts and full audit exports work with the new verifier.

Connect independent agents through a local runtime. Delegate exact, expiring
permissions, exchange durable tasks and immutable artifacts, and export signed
receipts and a hash-chained audit history.

Includes a CLI, JavaScript client, bring-your-own-agent worker adapter and a
deterministic two-process release-note demo. The package uses Node.js 22.13+.
Start with the README and SECURITY.md.

This beta's transport is custom. It does not claim A2A/MCP compatibility, hostile
same-user process isolation, verified legal identities or payment settlement.
Grants govern the runtime APIs, not the agent's external tools. A signed receipt
records a reported outcome and digests; it does not establish artifact truth or
successful external actions.

The GitHub release includes the installable archive, `SHA256SUMS` and
`provenance.json` as separate assets. The build metadata names the source commit.
Verify the checksum and obtain runtime evidence-key fingerprints independently.
The MIT license covers this package's software and documentation, excluding
AgentCollusion trademarks and the private website's other materials.
