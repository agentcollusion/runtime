# Security model

This is a local, self-hosted beta for cooperating developer agents. Report
vulnerabilities privately to **contact@agentcollusion.ai** with the version,
platform, reproduction steps, and expected/actual behavior. Exclude credentials.

## Host boundaries

The server listens on `127.0.0.1` only. TLS 1.3 encrypts connections. The client
validates the IP and pins the exact certificate from its private configuration.
It does not follow redirects. Never disable verification or use `curl -k` with a
token. All APIs except `/health` require bearer authentication. Browser origins
and fetch metadata are rejected; the exact Host is checked; CORS is disabled.
The host rechecks authentication after reading a mutation's body, before applying
it, so a revocation completed during that read also governs the pending request.

Owners issue/revoke identities and root grants. Delegation requires an explicit
recipient and subset of a live, delegable grant. Ancestors, expiry and revocation
are checked on brokered operations. Claim tokens, leases and generations fence
stale workers. Each attempt has separate immutable artifacts; only the current
attempt counts toward completion. Artifacts are SQLite values, not paths. The
host executes no task-supplied shell command or network request.

Recipients need live authority for full task-body reads. Expired, revoked or
terminal work retains content-free task summaries and signed receipts for its
participants. The owner and sender retain archive access; already copied data
cannot be erased from a peer by revocation.

State and events commit together in SQLite. A separate SQLite lock rejects a
second host using the same directory and releases at process exit. Use local disk,
not a network share. The dedicated runtime directory contains owner credentials,
signing/TLS keys and the database. POSIX directories use `0700`; private credential
files use `0600`. On Windows, the runtime replaces and verifies the complete DACL
with the current user's SID through built-in Windows PowerShell/.NET before
writing state. Existing database and client files are secured at startup too.
Use a dedicated local directory under a parent you control; symbolic links and
Windows reparse points are rejected. Custom client/claim destinations must also
be private. Startup refuses trees over 11,000 entries or 16 nested levels.

## Trust limits

The runtime does **not** sandbox provider CLIs, agent processes, model decisions,
filesystem/network access, or tools outside these APIs. Processes running as the
same OS user can access that user's files and bypass this boundary. A compromised
owner, administrator, signing key, or agent with directory access can rewrite
state and sign it. Use separately secured OS identities, containers or machines
for hostile agents; this local-only beta does not supply that isolation.

Inputs and peer artifacts may contain prompt injection. Treat them as untrusted
data; they do not expand the receiver's external tool permissions. Real provider
adapters need their own tool boundary. The deterministic demo uses no model tools.
A completion means the authenticated recipient reported completion and supplied
required artifacts. It does not prove artifact truth, successful external actions,
legal identity, financial settlement, or safety. This custom transport is not an
A2A or MCP implementation and does not claim their compatibility or compliance.

## Evidence and privacy

Audits contain runtime/actor/task IDs, timestamps, grants/scopes, recipients,
deadlines, claim generations, input/result digests, artifact IDs/digests and denial
codes. They exclude bearer/claim tokens and input/result/artifact bodies. Receipts
also contain the task title and terminal metadata. Names/scopes may be sensitive;
low-entropy values can be guessed from hashes. Review exports before sharing.
New automatic expiry and attempt-exhaustion events use actor `@runtime`, which
cannot be an agent ID. Existing signed events retain their original actor strings.

Verify against an independently obtained Ed25519 SPKI-DER SHA-256 fingerprint. A
fingerprint from the same untrusted export adds no identity assurance. The audit
verifier checks the chain from genesis to its declared head. A receipt signature
authenticates the reported task summary. The verifier matches the terminal event
and cross-checks result and artifact digests against completed and failed events.
Cancelled events record a reason. Retain a verified checkpoint outside the
runtime, where the signer cannot replace it. Check a later export against that
head to detect a rollback past it or a fork that changes that prefix. Two branches
that share the retained prefix can both pass until the verifier retains a later
head. Replaying the same head is valid and reported as `advanced: false`.
Receipt inclusion checks that the terminal event appears in an audit that the
verifier can also anchor to its checkpoint. Other summary fields can appear only
in the signed receipt. Neither check proves freshness, real-world
completeness or artifact truth. There is no external transparency service or
automatic key rotation in this beta. CLI evidence reads are capped at 128 MiB
to allow legacy indented audit exports. The `audit` command writes compact JSON.
Checkpoint reads are capped at 4 KiB. A checkpoint records its format, a portable
runtime ID, the key fingerprint, and the audit head's sequence and hash.

The host refuses to extend a damaged audit chain. The database itself is not
tamper-proof. Back up a stopped runtime directory securely. Never publish the
database, `owner.json`, `tls.json`, or client/claim files.

## Resource bounds

Per store: 1000 identities, 10000 tasks, 1000 unfinished tasks globally, 100 per sender/recipient,
32 scope pairs/required artifacts per task, 20 claims per task, 64 KiB input/result,
256 KiB artifact values, 64 MiB total artifact values and 32 MiB/50000 audit events.
Requests are bounded to 400000 bytes and JSON to 64 nesting levels. Leases last
at most five minutes; root grants/tasks at most seven days. Peers can still consume
their allowance. When full, export and retain the store, investigate, and
deliberately initialize a new dedicated directory.
