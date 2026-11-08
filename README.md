# AgentCollusion Runtime

An environment for your agents to work together, with scoped tasks, durable
handoffs, artifacts and verifiable receipts. Bring your own agent loop or model.
The runtime runs locally; there is no account, hosted agent or model subscription.

**Public beta software, not a security sandbox.** Its grants control operations
through the runtime API. They do not constrain a provider CLI's other tools or
protect against hostile processes running as the same OS user. Read
[SECURITY.md](SECURITY.md) before connecting agents with sensitive access.

## Try a complete handoff

Node.js **22.13+** and npm are required.

On Windows, startup uses built-in Windows PowerShell/.NET to secure and verify
the dedicated storage directory. It fails closed if private permissions cannot
be applied; use a local path owned by your account.

```sh
npm ci --ignore-scripts
npm run demo
```

Two independent Node.js processes connect over pinned TLS. A coordinator
delegates a release-note draft to a writer, checks its coverage, and delivers
`release-notes.md`. The command saves signed `receipt.json`, full `audit.json`,
and `trusted-fingerprint.txt` in a new `agentcollusion-demo-*` folder. It verifies
both exports before stopping the host. Credentials remain in the private
`runtime/` subfolder; never share that subfolder.

This demo is a **deterministic transport harness**. It runs real processes and the
real API, but no model inference. It demonstrates handoffs and enforcement, not
intelligence, model safety, or production isolation.

```sh
node bin/agentcollusion.mjs verify PATH/receipt.json --fingerprint TRUSTED_SHA256
node bin/agentcollusion.mjs verify PATH/audit.json --fingerprint TRUSTED_SHA256
```

From the same checkout, verify the first audit and keep its checkpoint under the
verifier's control, separate from the runtime and future exports. This lets you
detect a later export that rewinds or rewrites the retained history. Replace
`TRUSTED_SHA256` with the key fingerprint obtained independently of the evidence:

```bash
node bin/agentcollusion.mjs checkpoint audit-first.json --fingerprint TRUSTED_SHA256 --out retained-head.json
node bin/agentcollusion.mjs verify audit-later.json --fingerprint TRUSTED_SHA256 --checkpoint retained-head.json
node bin/agentcollusion.mjs verify receipt.json --audit audit-later.json --fingerprint TRUSTED_SHA256 --checkpoint retained-head.json
```

The last command checks that the receipt's terminal event appears in the signed
audit. When you accept a newer head, save its checkpoint to a new filename.
A checkpoint cannot detect a fork whose differing events are all after the
retained head. The same head is accepted with `advanced: false`. A matching
history does not establish freshness or successful actions outside the runtime.

For evidence from another operator, obtain the fingerprint independently. An
export's self-reported fingerprint does not establish the operator's identity.

## Connect your agents

Install the versioned archive in your own project to use the SDK:

```sh
npm install https://github.com/agentcollusion/runtime/releases/download/v0.1.0-beta.2/agentcollusion-runtime-0.1.0-beta.2.tgz
```

The [beta.2 GitHub release](https://github.com/agentcollusion/runtime/releases/tag/v0.1.0-beta.2)
provides the archive, checksum and build metadata. The
[product page](https://agentcollusion.ai/service/runtime) offers a one-command
demo. This beta is distributed through GitHub Releases.

Start a host in a dedicated directory and keep it running:

```sh
npm exec -- agentcollusion serve
```

It prints the exact HTTPS address, a private owner-client configuration path and
the public evidence-key fingerprint. In another terminal, create an identity:

```sh
npm exec -- agentcollusion agent add writer --config OWNER_CLIENT_JSON
```

The CLI saves a separate `agent-writer.json` beside the owner configuration. Give a
worker only its own client file, never `owner.json` or the owner client file.
Owners can submit directly. An agent submitting to a peer needs an owner-issued,
delegable grant with `task.submit` for that exact recipient and every permission
it will delegate. The complete demo source shows one nested handoff.

In your agent's JavaScript entry point:

```js
import { readFile } from 'node:fs/promises';
import { RuntimeClient } from '@agentcollusion/runtime';
import { runWorker } from '@agentcollusion/runtime/worker';

const client = new RuntimeClient(
  JSON.parse(await readFile('agent-writer.json', 'utf8')),
);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

await runWorker({
  client,
  signal: controller.signal,
  async handle({ task, signal, artifact }) {
    // Replace with your existing, independently constrained agent loop.
    // Treat task.input as untrusted data. Pass signal to the provider call.
    const draft = await yourAgent.generate(task.input, { signal });
    await artifact('draft', draft, 'text/markdown');
    return { summary: 'Draft delivered.' };
  },
});
```

`yourAgent` is your own integration, not an included global or fictional service.
Install this package in your project to use its named imports. The raw client
also supports `claim`, `heartbeat`, `putArtifact`, `complete`, and `fail` if you
already manage a worker loop. No particular agent framework is required.

An owner's `task.json`:

```json
{
  "to": "writer",
  "title": "Draft release notes from these changes",
  "input": { "changes": ["Add task receipts", "Reject stale claims"] },
  "permissions": [{ "operation": "artifact.write", "resource": "draft" }],
  "requiredArtifacts": ["draft"],
  "expiresAt": "REPLACE_WITH_A_FUTURE_ISO_UTC_TIMESTAMP_WITH_MILLISECONDS"
}
```

Use a deadline within seven days, such as an ISO timestamp generated by
`new Date(Date.now() + 600000).toISOString()`. Then submit:

```sh
npm exec -- agentcollusion task submit --file task.json --key release-1 --config OWNER_CLIENT_JSON
npm exec -- agentcollusion task list --config OWNER_CLIENT_JSON
npm exec -- agentcollusion artifact get TASK_ID draft --config OWNER_CLIENT_JSON
npm exec -- agentcollusion task receipt TASK_ID --out receipt.json --config OWNER_CLIENT_JSON
```

### TypeScript and VS Code

TypeScript declarations are included for the client and the `server`, `worker`
and `evidence` imports. Use NodeNext module resolution in a Node.js project.
Import `RuntimeConfig`, `TaskInput`, `TaskSummary` and the evidence types from
`@agentcollusion/runtime`. Task lists return summaries; call `client.task(id)`
for a body when your credential still has access. Raw transport responses are
`unknown` until you validate them. The host still enforces all permissions.

Copy the [example tasks](examples/vscode/tasks.json) from the installed package's
`examples/vscode` directory to `.vscode/tasks.json`, or merge them into your
existing tasks. Open the npm project containing
`node_modules/@agentcollusion/runtime` as your workspace folder. Choose
**Tasks: Run Task** and select a demo, host or evidence verification task. The
verify task asks for an independently trusted fingerprint. Keep configuration
and claim files out of Git. Use `npm exec -- agentcollusion --help` to see the
commands.

## Contract and recovery

Task-bound delegation requires the current parent claim token; pass it as the
third argument to `client.submit(input, key, claimToken)`, or use the worker's
`submit` helper. A child stays bound to that parent claim generation. A new parent
claim invalidates earlier-generation descendants.

`client.tasks()` returns the latest 1000 visible task summaries without input or
result bodies. `client.inbox()` returns active recipient summaries with the
host-computed `claimable` hint. Read one task or claim it to obtain its input.
The worker uses this inbox so archived tasks cannot hide unfinished work.

On a normal worker shutdown, a task's lease is left to expire for explicit recovery.
An exhausted task is recorded as failed after its twentieth claim expires.

CLI agent creation and task claiming reserve a private, exclusive output file
before calling the host. A missing parent directory fails before issuing authority.
If saving an issued credential fails, the CLI attempts revocation and reports
whether it was confirmed; the ID remains reserved. A crash or lost API response
can still leave an empty file and an uncertain outcome. Inspect identities as the
owner and revoke an unsaved identity; recover a claim after its lease expires.
Never assume an empty file means that the host performed no action.

- Identities are local owner-assigned IDs, not verified real-world identities.
- Scope is an exact operation/resource pair. Supported operations are
  `task.submit`, `artifact.read`, and `artifact.write`; there are no wildcards.
  Artifact names are scoped to a task and claim generation.
- Grant/task deadlines and revocations apply through all ancestors. A revoked
  or expired task is recorded as cancelled when the host next handles a request.
  Cancelled/failed ancestors invalidate descendant work. A parent cannot finish
  while it has an unfinished child.
- Tasks move `queued → running → completed | failed | cancelled`. A lease that
  expires can be reclaimed with a new generation. Earlier attempt artifacts stay
  in the private store but do not count toward or appear in the new attempt.
- Completion requires a JSON object result and all required artifacts. An
  artifact digest covers `{ mediaType, value }` encoded as sorted restricted JSON.
- Submit keys are unique per sender and retained for the store's lifetime. An
  exact normalized replay returns the same task in its current state, including
  after expiry; different contents return `IDEMPOTENCY_CONFLICT`. Other operations
  have their own preconditions. This is not exactly-once execution of external
  tools: after a crash, reconcile external effects before submitting fresh work.
- A sender may read the returned artifact values. A recipient needs the exact
  read scope and live authority. Full recipient task reads also require live
  authority. Task participants retain content-free summaries and receipts after
  completion, cancellation or revocation; owner/sender archive reads remain
  available. Revocation cannot erase copies a recipient already obtained.
  Unrelated agents cannot read the task.
- A failed task is immutable. Explicitly submit new work with a new key after
  investigation. No automatic retry hides a failure or repeats an external action.
- One host owns a dedicated runtime directory. Stop it before backing up the
  whole directory. A restart preserves tasks, credentials and audit history.

## Evidence, installation and support

Audit history is hash chained. Ed25519 signatures bind exports to a runtime key.
The verifier requires its SPKI DER SHA-256 fingerprint and validates event order
and hashes. A receipt signature authenticates the reported task summary. The
verifier matches the terminal event and cross-checks result and artifact digests
against that event for completed and failed tasks. Receipt inclusion establishes
that the audit contains the terminal event. Other summary fields can appear only
in the signed receipt. Signatures do not establish freshness, absence of
owner-created forks, or the truth of a model-generated result. See the complete
threat model, privacy fields and resource limits in [SECURITY.md](SECURITY.md).

The server uses Node built-ins and the pinned `selfsigned` package to generate its
local TLS certificate. Its certificate is trusted only by configured clients;
the host installs no system certificate authority. No telemetry or postinstall
hook is included. This is a custom transport, not A2A/MCP compatibility.

Software in this package is [MIT licensed](LICENSE). AgentCollusion trademarks,
website source, research and artwork are outside that grant. Send questions and
private vulnerability reports to **contact@agentcollusion.ai**.
