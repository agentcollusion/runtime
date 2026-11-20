# Runtime 0.1.0-beta.8

Run a real text job using your authenticated Codex and/or Claude CLIs. The new
`agentcollusion run` command connects two separate workers through scoped
runtime tasks, delegates a draft for review, allows a bounded revision, and
exports only an accepted result as `result.md`. Review rejection, provider
failure and cancellation do not report successful delivery.

`agentcollusion doctor` checks native provider executable versions. A typed
`@agentcollusion/runtime/jobs` entry point and `examples/text-job.json` are
included. The provider choice is explicit; default models and existing logins
remain with their CLI. Provider tools are disabled in this text workflow,
there is no permission bypass, and task text travels through stdin only.

The new output contains review history and independently replayable signed
evidence. The runner verifies receipt inclusion and artifact digests before
reporting completion, and stops its own workers and host. Keep `private/` out
of shared material. Model review is not proof of truth; this local workflow
does not isolate different owners or perform arbitrary external actions.

This release also brings the previously local tool, recovery, A2A, trace and
developer-harness changes below into the same distributable package.

Run `agentcollusion harness` or select the guardrail task in VS Code. A local
synthetic fixture exercises a delegated handoff, scope denial, expired claim,
uncertain call replay after restart, and saved artifact verification. The JSON
report links to the signed audit and receipt. No model or external peer runs.

Verify a local artifact against the exact value and media-type digest in a
signed terminal receipt. The CLI and SDK can optionally anchor that receipt in
a signed audit and retained checkpoint. Cancelled receipts do not bind artifact
digests to their terminal event and are rejected by this check.

Inspect a signed audit from the CLI, the `@agentcollusion/runtime/trace` export
or VS Code Tasks. The inspector verifies the full audit before it selects a
task or pages through new events. The derived report is unsigned; keep the
original audit and independently trusted fingerprint for verification.

The opt-in `@agentcollusion/runtime/a2a` export connects a host-registered tool
to an owner-configured A2A 1.0 JSON-RPC `SendMessage` endpoint. Receive an agent
message or the task status and text artifacts in the reply. The adapter is
tested against the official JavaScript SDK 1.3.0. It does not follow redirects,
fetch artifact links, or retry when the remote outcome is uncertain.

Register application tools in a local host and grant an agent permission to call
an exact tool on its current task. An invocation starts with a durable audit
event. Replays return the existing record, including after a worker reclaims
the task. A timeout or interrupted response remains uncertain; the owner can
attach an evidence digest and an observation without dispatching it again.

Try `examples/guarded-tool.mjs` to see a denied request, a successful local
check, a replay that does not run again, and a receipt verified in its audit.
The runtime cannot prove what an external system did. Trusted handler code
remains responsible for validating arguments and constraining its effects.

The offline audit checkpoint and receipt inclusion verifier remain available.
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

This beta's local transport is custom. The optional outbound A2A adapter is
limited to the operation above. There is no MCP support, hostile same-user
process isolation, verified legal identity, or payment settlement.
Grants govern the runtime APIs, not the agent's external tools. A signed receipt
records a reported outcome and digests; it does not establish artifact truth or
successful external actions.

The GitHub release includes the installable archive, `SHA256SUMS` and
`provenance.json` as separate assets. The build metadata names the source commit.
Verify the checksum and obtain runtime evidence-key fingerprints independently.
The MIT license covers this package's software and documentation, excluding
AgentCollusion trademarks and the private website's other materials.
