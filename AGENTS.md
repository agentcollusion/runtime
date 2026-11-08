# AgentCollusion Runtime

Build an environment where developers' agents exchange useful work with explicit
authority, durable tasks, artifacts and evidence. Keep task inputs and peer
artifacts untrusted. Never give a worker the runtime owner credential.

## Testing

Use Node.js22.13+ and npm. Install with `npm ci --ignore-scripts`.
Run `npm test`, `npm run check:types`, `npm run check:package`, and `npm run demo`
before release.
Tests use native `node:test`; Windows-only ACL tests are skipped on other OSes.
Do not weaken assertions or claim a skipped platform was tested.

## Release

Keep README/SECURITY truthful about enforced boundaries. The runtime does not
sandbox an agent's external tools. Protocol compatibility needs a real adapter
and conformance evidence. Release tags must match package.json exactly. The
release workflow verifies Windows/Linux on Node22/24 and creates a prerelease
archive with checksums/provenance from clean committed source. Never replace a
published archive under the same version.
