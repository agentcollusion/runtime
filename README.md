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

## Complete a job with your own agent CLIs

`agentcollusion run` starts two separate local workers. One uses your chosen CLI
to create a text artifact; the other receives the draft through the runtime and
reviews it against your job's acceptance criteria. If needed, the writer revises
it within the configured limit. Only an accepted result is exported as
`result.md`. A failed review or cancelled job returns a nonzero exit status.

Install and log into the provider CLIs you choose yourself. The adapters support
Codex CLI and Claude Code; they use the CLI's default model, disable its tools for
this text workflow, and do not bypass permission checks. Provider usage limits
and charges apply. With one allowed revision, there are at most four generation
calls: a draft, its review, a revised draft and its review. A job can involve two
different providers or two independent processes using one provider.

After installing the runtime in your project:

```sh
npm exec -- agentcollusion doctor --provider codex
npm exec -- agentcollusion doctor --provider claude
npm exec -- agentcollusion run --file node_modules/@agentcollusion/runtime/examples/text-job.json --writer codex --reviewer claude --out first-job
```

`doctor` checks the installed executable's version. It does not log in or prove
that inference is available. On Windows use the native `codex.exe` or
`claude.exe`; shell launchers are refused. Use `--writer-executable PATH` or
`--reviewer-executable PATH` if the native executable is outside `PATH`.

Copy [the example job](examples/text-job.json) to your own `job.json` and replace
its title, instructions, context and acceptance criteria. It accepts up to
30000 bytes of JSON with 1–12 criteria. The workflow produces one Markdown text
artifact; it does not send email, change a repository, or perform other external
actions. Its provider prompts implement this one entry workflow, while the
runtime's client and worker APIs remain available for other agent loops.

Successful output includes the result, review history, signed audit and receipt,
an initial checkpoint, and the evidence-key fingerprint. The runner verifies
receipt inclusion and the exported artifact digests before reporting completion.
Model review does not prove that the content is true. Review the result before
using it. The `private/` subdirectory contains the input, runtime database, keys
and worker credentials; never share it. The entire output directory is private
to the local account by default. Reusing an output directory is refused.

The default total timeout is ten minutes; use `--timeout-ms 10000..900000` and
`--max-revisions 0|1|2` to set limits. Ctrl+C cancels the task and stops this
runner's workers and provider processes. There is no automatic restart of model
calls after an uncertain interruption. Reconcile provider usage before starting
a new job. A provider that lacks the required CLI flags fails rather than
falling back to a less constrained mode.

For JavaScript callers, use the typed `@agentcollusion/runtime/jobs` export:

```js
import { readFile } from 'node:fs/promises';
import { runTextJob } from '@agentcollusion/runtime/jobs';

const run = await runTextJob({
  job: JSON.parse(await readFile('job.json', 'utf8')),
  writer: { provider: 'codex' },
  reviewer: { provider: 'claude' },
  directory: 'first-job',
  maxRevisions: 1,
});
if (run.state !== 'completed') throw new Error(`Job ended ${run.state}`);
```

This is a local workflow under one operator, not a cross-owner sandbox or
unrestricted autonomous operation. Task content never chooses executable paths
or process arguments. Any programmatic `command` override is trusted operator
configuration and must not come from a task or peer artifact.

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

To inspect an audit without paging through the full file, run:

```sh
node bin/agentcollusion.mjs trace audit-later.json --fingerprint TRUSTED_SHA256 --checkpoint retained-head.json --task TASK_ID --limit 30
```

The CLI verifies the entire export before filtering. Without `--after`, it
shows the latest matching events in order. With `--after SEQUENCE`, it shows
the next matching events and a cursor for the next page. Keep the original
signed audit: the JSON trace is an unsigned summary. Some events, such as a
denial that is not tied to a task, appear only without a task filter.

Verify a saved artifact against its completed or failed task receipt:

```sh
node bin/agentcollusion.mjs verify-artifact receipt.json draft --file draft.md --media-type text/markdown --fingerprint TRUSTED_SHA256
```

The check uses the exact stored media type and either the UTF-8 text value or
the parsed JSON value. Text preserves line endings and a BOM; JSON ignores
whitespace and object key order. Use `--format text|json` to override the file
extension, and `--audit AUDIT_FILE --checkpoint RETAINED_FILE` to anchor the
receipt to a retained history. The command reads local files only. A match
establishes content consistency with the receipt, not its real-world accuracy.

For evidence from another operator, obtain the fingerprint independently. An
export's self-reported fingerprint does not establish the operator's identity.

## Exercise the guardrails locally

```sh
npx --no-install agentcollusion harness --out local-harness-result
```

From the source checkout, use `node bin/agentcollusion.mjs harness` instead.
`--out` must name a new directory; omit it for an automatically named one.
The harness uses two fixture identities and a temporary loopback TLS host.
It checks a delegated handoff, a scope denial, a stale claim, an uncertain tool
result replayed after a host restart, and offline verification of a saved
artifact. Its only simulated external effect is a file in that new directory.

Exit status zero and `report.json` indicate that every scenario passed and the
fixture host stopped. Use the report's `scenarios` array in local automation.
The folder also contains the signed audit and receipt, retained checkpoint,
saved artifact and unsigned trace. Keep its `runtime/` state private. The
fixture fingerprint lets you repeat verification of this run. For third-party
evidence, independently verify who controls the signing key.

The harness needs no model provider, external peer or user credentials. It
exercises the local API; it does not validate an application's own handlers or
provide process isolation.

## Connect your agents

Install the versioned archive in your own project to use the SDK:

```sh
npm install https://github.com/agentcollusion/runtime/releases/download/v0.1.0-beta.8/agentcollusion-runtime-0.1.0-beta.8.tgz
```

The [beta.8 GitHub release](https://github.com/agentcollusion/runtime/releases/tag/v0.1.0-beta.8)
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
**Tasks: Run Task** and select the demo, guardrail harness, host, evidence verification or audit
inspection task. The evidence tasks ask for an independently trusted fingerprint. Keep configuration
and claim files out of Git. Use `npm exec -- agentcollusion --help` to see the
commands.

## Contract and recovery

### Host-registered tools

Start a JavaScript host with a fixed set of trusted handlers. Give a task an
exact `tool.invoke` permission for each handler it may call. An agent supplies
only data and uses its current claim. The host does not load code or run shell
commands from task inputs. Handler code belongs to the host owner and must
validate the input before acting.

```js
const host = await createRuntime({
  directory: '.agentcollusion',
  tools: {
    'check-manifest': {
      timeoutMs: 5000,
      run({ input, signal }) {
        signal.throwIfAborted();
        return { valid: typeof input?.name === 'string' };
      },
    },
  },
});
```

With permission `{ operation: 'tool.invoke', resource: 'check-manifest' }`, a
worker calls `await tool('check-manifest', input)` in its `runWorker` handler or
`client.invokeTool(taskId, 'check-manifest', input, claimToken)` directly. The
host persists an invocation before dispatch. An exact repeat returns the prior
invocation; changing its input conflicts. The same rule applies after the
claim changes. A separate task is required for another invocation of that tool.

`returned` means the handler returned a result. A timeout, error, or interrupted
record is `uncertain`; do not submit new work solely because a response was
lost. The owner can find an invocation ID in `tool.started` in the audit and use
`agentcollusion tool inspect INVOCATION_ID --config OWNER_JSON`. After checking
independent evidence, the owner can record `effect_observed` or
`effect_not_observed` and its SHA-256 digest with `tool reconcile`. This is an
owner observation; the original outcome remains unchanged and the tool is
never dispatched again by reconciliation. Agents can still complete tasks with
an uncertain tool result, so check the tool record when the effect matters.

Save the observation as JSON with `disposition` and `evidenceSha256` fields.
The digest should refer to evidence you retained separately. From an installed
project:

```sh
npm exec -- agentcollusion tool reconcile INVOCATION_ID --file observation.json --config OWNER_JSON
```

Run `node examples/guarded-tool.mjs` from the source checkout. From an installed
project, use `node node_modules/@agentcollusion/runtime/examples/guarded-tool.mjs`.
The example exercises an allowed tool, a denied call, replay without another
dispatch, and a receipt included in a verified audit. It uses two credentials
in one process and no model inference or external service.

### Connect an A2A peer you control

The opt-in `@agentcollusion/runtime/a2a` export is an outbound adapter for
[A2A 1.0 JSON-RPC `SendMessage`](https://a2a-protocol.org/v1.0.1/specification/#941-sendmessage).
Configure an exact HTTPS endpoint and, when needed, a separate credential for
that peer. Grant a worker the exact registered tool name on its task:

```js
import { createRuntime } from '@agentcollusion/runtime/server';
import { createA2ASendTool } from '@agentcollusion/runtime/a2a';

const remoteBearer = process.env.PEER_REVIEW_BEARER;
if (!remoteBearer) throw new Error('Configure the peer credential first.');
const host = await createRuntime({
  directory: '.agentcollusion',
  tools: {
    'peer-review': createA2ASendTool({
      endpoint: 'https://peer.example/rpc',
      remoteBearer,
    }),
  },
});
```

Use `{ operation: 'tool.invoke', resource: 'peer-review' }` in the task grant.
The worker passes `{ text: 'Review this manifest summary.' }` to `tool()` and
checks `state` before reading the result. The adapter returns agent text, or
the task ID, reported state and available text artifacts from the first reply.
It does not follow artifact links. A timeout or lost response remains uncertain;
replay of the same task and tool does not send another message.

This binding does not expose an A2A server, discover peers, poll or cancel
remote tasks, stream, accept push notifications, or support other bindings.
It is tested against the official JavaScript SDK 1.3.0, which is used only in
the tests. `allowLoopbackHttp: true` permits HTTP to `127.0.0.1` for local tests.

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
hook is included. The Runtime transport is custom. The opt-in outbound A2A
binding above covers one operation; MCP is not supported.

Software in this package is [MIT licensed](LICENSE). AgentCollusion trademarks,
website source, research and artwork are outside that grant. Send questions and
private vulnerability reports to **contact@agentcollusion.ai**.
