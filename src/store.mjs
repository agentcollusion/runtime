import { DatabaseSync } from 'node:sqlite';
import {
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  createPublicKey,
} from 'node:crypto';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { writePrivateJson } from './security.mjs';
import { canonical, digest, fingerprint, signedEnvelope } from './evidence.mjs';
import {
  requireCondition as must,
  identifier,
  text,
  timestamp,
  permissions,
} from './errors.mjs';

const terminal = (state) =>
  ['completed', 'failed', 'cancelled'].includes(state);
const SYSTEM_ACTOR = '@runtime'; // Cannot be registered as an agent ID.
const secret = () => randomBytes(32).toString('base64url');
const allows = (scope, operation, resource) =>
  scope.some((p) => p.operation === operation && p.resource === resource);
const limitedJson = (value, max, label) => {
  must(
    Buffer.byteLength(canonical(value)) <= max,
    413,
    'VALUE_TOO_LARGE',
    `${label} exceeds ${max} bytes.`,
  );
  return value;
};

export class RuntimeStore {
  constructor(directory, { now = () => Date.now() } = {}) {
    this.now = now;
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    // A dedicated OS-backed SQLite lock prevents two hosts from racing checks
    // outside their state transactions. The OS releases it after a crash.
    this.lock = new DatabaseSync(path.join(this.directory, 'host-lock.sqlite'));
    try {
      this.lock.exec(
        'PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS lock (id INTEGER); BEGIN EXCLUSIVE;',
      );
    } catch (error) {
      this.lock.close();
      throw new Error(
        'This runtime directory is already in use by another host.',
        { cause: error },
      );
    }
    try {
      const identityPath = path.join(this.directory, 'owner.json');
      try {
        this.identity = JSON.parse(readFileSync(identityPath, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        must(
          !existsSync(path.join(this.directory, 'runtime.sqlite')),
          500,
          'IDENTITY_MISSING',
          'owner.json is missing from an existing runtime. Restore the matching backup; a new identity will not be generated.',
        );
        const keys = generateKeyPairSync('ed25519');
        const identity = {
          runtimeId: randomUUID(),
          token: secret(),
          privateKey: keys.privateKey
            .export({ type: 'pkcs8', format: 'pem' })
            .toString(),
          publicKey: keys.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        };
        writePrivateJson(identityPath, identity);
        this.identity = identity;
      }
      this.db = new DatabaseSync(path.join(this.directory, 'runtime.sqlite'));
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, body TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS grants (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, idem TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(sender, idem));
      CREATE TABLE IF NOT EXISTS artifacts (task_id TEXT NOT NULL, generation INTEGER NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(task_id, generation, id));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY, body TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_recipient ON tasks(recipient);
      CREATE INDEX IF NOT EXISTS tasks_sender ON tasks(sender);`);
      this.db
        .exec(`CREATE INDEX IF NOT EXISTS tasks_state ON tasks(json_extract(body, '$.state'));
        CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(json_extract(body, '$.parentTaskId'));`);
      const existing = this.db
        .prepare('SELECT value FROM meta WHERE id = ?')
        .get('identity');
      const identityDigest = digest({
        runtimeId: this.identity.runtimeId,
        tokenHash: digest(this.identity.token),
        publicKey: this.identity.publicKey,
      });
      if (existing)
        must(
          existing.value === identityDigest,
          500,
          'IDENTITY_MISMATCH',
          'Runtime identity does not match the database. Restore the matching owner.json.',
        );
      else
        this.db
          .prepare('INSERT INTO meta (id, value) VALUES (?, ?)')
          .run('identity', identityDigest);
      this.keyFingerprint = fingerprint(this.identity.publicKey);
      must(
        fingerprint(
          createPublicKey(this.identity.privateKey)
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        ) === this.keyFingerprint,
        500,
        'IDENTITY_MISMATCH',
        'The signing private key does not match the runtime public key.',
      );
      // Refuse to extend a damaged history. Authentication of historical heads requires a pinned export.
      let previousHash = '0'.repeat(64),
        sequence = 0;
      for (const row of this.db
        .prepare('SELECT * FROM events ORDER BY sequence')
        .iterate()) {
        const event = JSON.parse(row.body);
        must(
          event.sequence === ++sequence &&
            event.runtimeId === this.identity.runtimeId &&
            event.previousHash === previousHash &&
            digest(event) === row.hash,
          500,
          'AUDIT_CORRUPT',
          'Audit history is damaged; restore a verified backup before starting.',
        );
        previousHash = row.hash;
      }
    } catch (error) {
      this.db?.close();
      this.lock.close();
      throw error;
    }
  }

  close() {
    this.db.close();
    this.lock.close();
  }
  iso() {
    return new Date(this.now()).toISOString();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  read(table, id) {
    const row = this.db
      .prepare(`SELECT body FROM ${table} WHERE id = ?`)
      .get(id);
    return row ? JSON.parse(row.body) : null;
  }
  update(table, object) {
    this.db
      .prepare(`UPDATE ${table} SET body = ? WHERE id = ?`)
      .run(canonical(object), object.id);
  }
  all(table) {
    return this.db
      .prepare(`SELECT body FROM ${table}`)
      .all()
      .map((row) => JSON.parse(row.body));
  }
  event(actor, type, taskId, detail = {}) {
    const head = this.db
      .prepare(
        'SELECT sequence, hash FROM events ORDER BY sequence DESC LIMIT 1',
      )
      .get();
    const record = {
      sequence: (head?.sequence || 0) + 1,
      previousHash: head?.hash || '0'.repeat(64),
      runtimeId: this.identity.runtimeId,
      at: this.iso(),
      actor,
      type,
      taskId,
      detail,
    };
    const hash = digest(record);
    const body = canonical(record);
    const priorBytes = Number(
      this.db.prepare('SELECT value FROM meta WHERE id = ?').get('audit_bytes')
        ?.value || 0,
    );
    const nextBytes = priorBytes + Buffer.byteLength(body);
    must(
      nextBytes <= 32 * 1024 * 1024 && record.sequence <= 50000,
      507,
      'AUDIT_CAPACITY',
      'Audit storage is full. Export and retain this runtime before starting a new one.',
    );
    this.db
      .prepare('INSERT INTO events (sequence, body, hash) VALUES (?, ?, ?)')
      .run(record.sequence, body, hash);
    this.db
      .prepare(
        'INSERT INTO meta (id, value) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
      )
      .run('audit_bytes', String(nextBytes));
    return { ...record, hash };
  }
  head() {
    const row = this.db
      .prepare(
        'SELECT sequence, hash FROM events ORDER BY sequence DESC LIMIT 1',
      )
      .get();
    return row
      ? { sequence: row.sequence, hash: row.hash }
      : { sequence: 0, hash: '0'.repeat(64) };
  }
  denial(actor, code) {
    this.transaction(() =>
      this.event(actor, 'operation.denied', null, { code }),
    );
  }
  authenticate(token) {
    must(
      typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token),
      401,
      'UNAUTHENTICATED',
      'A valid bearer credential is required.',
    );
    const hash = digest(token);
    if (hash === digest(this.identity.token)) return 'owner';
    const row = this.db
      .prepare('SELECT body FROM agents WHERE token_hash = ?')
      .get(hash);
    const agent = row && JSON.parse(row.body);
    must(
      agent && !agent.revokedAt,
      401,
      'UNAUTHENTICATED',
      'Credential is invalid or revoked.',
    );
    return agent.id;
  }
  owner(actor) {
    must(
      actor === 'owner',
      403,
      'OWNER_REQUIRED',
      'This operation requires the runtime owner.',
    );
  }
  agent(id) {
    const value = this.read('agents', identifier(id, 'agent ID'));
    must(
      value && !value.revokedAt,
      404,
      'AGENT_NOT_FOUND',
      'Agent is unavailable.',
    );
    return value;
  }
  createAgent(actor, input) {
    this.owner(actor);
    const id = identifier(input.id, 'agent ID');
    must(
      id !== 'owner' && !this.read('agents', id),
      409,
      'AGENT_EXISTS',
      'Agent ID is reserved or already registered.',
    );
    must(
      this.all('agents').length < 1000,
      409,
      'CAPACITY',
      'The runtime supports at most 1000 agent identities.',
    );
    const value = {
      id,
      name: text(input.name || id, 'name'),
      createdAt: this.iso(),
      revokedAt: null,
    };
    const token = secret();
    return this.transaction(() => {
      this.db
        .prepare('INSERT INTO agents (id, body, token_hash) VALUES (?, ?, ?)')
        .run(id, canonical(value), digest(token));
      this.event(actor, 'agent.created', null, { agentId: id });
      return { ...value, token };
    });
  }
  revokeAgent(actor, id) {
    this.owner(actor);
    const value = this.agent(id);
    return this.transaction(() => {
      value.revokedAt = this.iso();
      this.update('agents', value);
      this.event(actor, 'agent.revoked', null, { agentId: id });
      return value;
    });
  }
  activeGrant(id, subject, depth = 0) {
    must(depth < 16, 403, 'GRANT_DEPTH', 'Grant ancestry exceeds the limit.');
    const grant = this.read('grants', identifier(id, 'grant ID'));
    must(
      grant && grant.to === subject,
      403,
      'GRANT_DENIED',
      'Grant is unavailable for this agent.',
    );
    must(
      !grant.revokedAt && Date.parse(grant.expiresAt) > this.now(),
      403,
      'GRANT_INACTIVE',
      'Grant is expired or revoked.',
    );
    this.agent(grant.to);
    if (grant.taskId) {
      const task = this.taskAuthority(grant.taskId);
      must(
        task &&
          !terminal(task.state) &&
          Date.parse(task.expiresAt) > this.now(),
        403,
        'GRANT_INACTIVE',
        'The task associated with this grant is no longer active.',
      );
    }
    if (grant.parentId) {
      const parent = this.activeGrant(grant.parentId, grant.from, depth + 1);
      if (parent.taskId)
        must(
          this.taskAuthority(parent.taskId)?.generation ===
            grant.parentGeneration,
          403,
          'GRANT_INACTIVE',
          'The parent claim generation changed.',
        );
      must(
        parent.delegable &&
          Date.parse(grant.expiresAt) <= Date.parse(parent.expiresAt) &&
          grant.permissions.every((p) =>
            allows(parent.permissions, p.operation, p.resource),
          ),
        403,
        'GRANT_DENIED',
        'Grant exceeds its ancestor authority.',
      );
    }
    return grant;
  }
  taskAuthority(id) {
    return this.db
      .prepare(
        "SELECT json_extract(body, '$.state') AS state, json_extract(body, '$.expiresAt') AS expiresAt, json_extract(body, '$.generation') AS generation FROM tasks WHERE id = ?",
      )
      .get(id);
  }
  createGrant(actor, input) {
    this.owner(actor);
    this.agent(input.to);
    const scope = permissions(input.permissions);
    const expiresAt = timestamp(input.expiresAt);
    must(
      Date.parse(expiresAt) > this.now() &&
        Date.parse(expiresAt) <= this.now() + 7 * 86400000,
      400,
      'INVALID_EXPIRY',
      'A root grant must expire within seven days.',
    );
    must(
      input.delegable === undefined || typeof input.delegable === 'boolean',
      400,
      'INVALID_INPUT',
      'delegable must be a boolean.',
    );
    const grant = {
      id: randomUUID(),
      from: actor,
      to: input.to,
      permissions: scope,
      expiresAt,
      delegable: input.delegable ?? false,
      parentId: null,
      taskId: null,
      revokedAt: null,
    };
    return this.transaction(() => {
      this.db
        .prepare('INSERT INTO grants (id, body) VALUES (?, ?)')
        .run(grant.id, canonical(grant));
      this.event(actor, 'grant.created', null, { grant });
      return grant;
    });
  }
  revokeGrant(actor, id) {
    const grant = this.read('grants', identifier(id));
    must(
      grant && (actor === 'owner' || actor === grant.from),
      403,
      'GRANT_DENIED',
      'Only the owner or issuing agent can revoke this grant.',
    );
    return this.transaction(() => {
      grant.revokedAt ||= this.iso();
      this.update('grants', grant);
      this.event(actor, 'grant.revoked', grant.taskId, { grantId: id });
      return grant;
    });
  }
  viewTask(task) {
    const { claimHash: _claimHash, ...value } = task;
    return {
      ...value,
      artifacts: this.db
        .prepare(
          'SELECT id, hash FROM artifacts WHERE task_id = ? AND generation = ? ORDER BY id',
        )
        .all(task.id, task.generation)
        .map((row) => ({ id: row.id, sha256: row.hash })),
    };
  }
  task(actor, id) {
    const task = this.read('tasks', identifier(id, 'task ID'));
    must(
      task && (actor === 'owner' || actor === task.from || actor === task.to),
      404,
      'TASK_NOT_FOUND',
      'Task is unavailable.',
    );
    return task;
  }
  readTask(actor, id) {
    const task = this.task(actor, id);
    if (actor !== 'owner' && actor !== task.from)
      this.activeGrant(task.grantId, actor);
    return this.viewTask(task);
  }
  submit(actor, input, idempotencyKey, claimToken) {
    const idem = identifier(idempotencyKey, 'Idempotency-Key');
    identifier(input.to, 'recipient');
    const scope = permissions(input.permissions);
    const expiresAt = timestamp(input.expiresAt);
    must(
      input.to !== actor,
      400,
      'INVALID_INPUT',
      'Submit tasks to another agent.',
    );
    must(
      input.delegable === undefined || typeof input.delegable === 'boolean',
      400,
      'INVALID_INPUT',
      'delegable must be a boolean.',
    );
    const requiredArtifacts = input.requiredArtifacts ?? [];
    must(
      Array.isArray(requiredArtifacts) &&
        requiredArtifacts.length <= 32 &&
        new Set(requiredArtifacts).size === requiredArtifacts.length,
      400,
      'INVALID_INPUT',
      'requiredArtifacts must be up to 32 unique IDs.',
    );
    for (const id of requiredArtifacts)
      must(
        allows(scope, 'artifact.write', identifier(id)),
        400,
        'INVALID_INPUT',
        'Required artifacts need an artifact.write permission.',
      );
    const normalized = {
      to: input.to,
      title: text(input.title, 'title', 240),
      input: limitedJson(input.input ?? null, 65536, 'input'),
      permissions: scope,
      expiresAt,
      requiredArtifacts: [...requiredArtifacts].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
      delegable: input.delegable ?? false,
      authorityId:
        actor === 'owner' ? null : identifier(input.authorityId, 'authorityId'),
    };
    const requestHash = digest(normalized);
    // Return the original task on an exact replay even after its authority expired.
    const existing = this.db
      .prepare(
        'SELECT body, request_hash FROM tasks WHERE sender = ? AND idem = ?',
      )
      .get(actor, idem);
    if (existing) {
      must(
        existing.request_hash === requestHash,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This key was already used for a different request.',
      );
      return { task: this.viewTask(JSON.parse(existing.body)), replayed: true };
    }
    this.agent(input.to);
    must(
      Date.parse(expiresAt) > this.now() &&
        Date.parse(expiresAt) <= this.now() + 7 * 86400000,
      400,
      'INVALID_EXPIRY',
      'Task must expire within seven days.',
    );
    let parent = null,
      parentGeneration = null;
    if (actor !== 'owner') {
      parent = this.activeGrant(normalized.authorityId, actor);
      if (parent.taskId)
        parentGeneration = this.claimed(
          actor,
          parent.taskId,
          claimToken,
        ).generation;
      must(
        parent.delegable &&
          allows(parent.permissions, 'task.submit', input.to) &&
          scope.every((p) =>
            allows(parent.permissions, p.operation, p.resource),
          ) &&
          Date.parse(expiresAt) <= Date.parse(parent.expiresAt),
        403,
        'SCOPE_DENIED',
        'Task delegation exceeds the issuing agent’s grant.',
      );
    }
    must(
      this.db.prepare('SELECT COUNT(*) AS count FROM tasks').get().count <
        10000,
      409,
      'CAPACITY',
      'This beta runtime supports at most 10000 tasks per store.',
    );
    const pending = this.db
      .prepare(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN sender = ? THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN recipient = ? THEN 1 ELSE 0 END) AS received FROM tasks WHERE json_extract(body, '$.state') IN ('queued', 'running')",
      )
      .get(actor, input.to);
    must(
      pending.total < 1000 &&
        (pending.sent || 0) < 100 &&
        (pending.received || 0) < 100,
      409,
      'CAPACITY',
      'The runtime supports at most 1000 unfinished tasks, with 100 per sender/recipient.',
    );
    return this.transaction(() => {
      const taskId = randomUUID(),
        grantId = randomUUID();
      const grant = {
        id: grantId,
        from: actor,
        to: input.to,
        permissions: scope,
        expiresAt,
        delegable: normalized.delegable,
        parentId: parent?.id || null,
        parentGeneration,
        taskId,
        revokedAt: null,
      };
      const task = {
        id: taskId,
        from: actor,
        to: input.to,
        title: normalized.title,
        input: normalized.input,
        grantId,
        parentTaskId: parent?.taskId || null,
        parentGeneration,
        permissions: scope,
        requiredArtifacts: normalized.requiredArtifacts,
        expiresAt,
        createdAt: this.iso(),
        updatedAt: this.iso(),
        state: 'queued',
        attempt: 0,
        generation: 0,
        leaseUntil: null,
        claimHash: null,
        result: null,
      };
      this.db
        .prepare('INSERT INTO grants (id, body) VALUES (?, ?)')
        .run(grantId, canonical(grant));
      this.db
        .prepare(
          'INSERT INTO tasks (id, sender, recipient, idem, request_hash, body) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(taskId, actor, input.to, idem, requestHash, canonical(task));
      // Validate the newly extended ancestry before committing the handoff.
      this.activeGrant(grantId, input.to);
      this.event(actor, 'task.submitted', taskId, {
        to: input.to,
        grant,
        inputSha256: digest(task.input),
        requiredArtifacts: task.requiredArtifacts,
        parentTaskId: task.parentTaskId,
      });
      return { task: this.viewTask(task), replayed: false };
    });
  }
  sweep() {
    return this.transaction(() => {
      const active = this.db
        .prepare(
          "SELECT id, recipient, json_extract(body, '$.grantId') AS grantId, json_extract(body, '$.expiresAt') AS expiresAt, json_extract(body, '$.state') AS state, json_extract(body, '$.attempt') AS attempt, json_extract(body, '$.leaseUntil') AS leaseUntil FROM tasks WHERE json_extract(body, '$.state') IN ('queued', 'running')",
        )
        .all();
      for (const candidate of active) {
        let reason =
          Date.parse(candidate.expiresAt) <= this.now()
            ? 'deadline_expired'
            : null;
        try {
          this.activeGrant(candidate.grantId, candidate.recipient);
        } catch {
          reason ||= 'authority_inactive';
        }
        const exhausted =
          !reason &&
          candidate.state === 'running' &&
          candidate.attempt >= 20 &&
          Date.parse(candidate.leaseUntil) <= this.now();
        if (!reason && !exhausted) continue;
        const task = this.read('tasks', candidate.id);
        reason ||= 'attempts_exhausted';
        task.state = exhausted ? 'failed' : 'cancelled';
        task.result = { reason };
        task.claimHash = null;
        task.leaseUntil = null;
        task.updatedAt = this.iso();
        this.update('tasks', task);
        this.event(
          SYSTEM_ACTOR,
          `task.${task.state}`,
          task.id,
          exhausted
            ? {
                reason,
                resultSha256: digest(task.result),
                artifacts: this.viewTask(task).artifacts,
                generation: task.generation,
              }
            : { reason },
        );
      }
    });
  }
  listTasks(actor, inbox = false) {
    const where = inbox
      ? "recipient = ? AND json_extract(body, '$.state') IN ('queued', 'running')"
      : actor === 'owner'
        ? '1 = 1'
        : '(sender = ? OR recipient = ?)';
    const args = inbox ? [actor] : actor === 'owner' ? [] : [actor, actor];
    const tasks = this.db
      .prepare(
        `SELECT json_remove(body, '$.input', '$.result', '$.claimHash') AS body FROM tasks WHERE ${where} ORDER BY rowid DESC LIMIT 1000`,
      )
      .all(...args)
      .map((row) => {
        const task = JSON.parse(row.body);
        return {
          ...task,
          artifacts: [],
          ...(inbox
            ? {
                claimable:
                  task.state === 'queued' ||
                  (task.state === 'running' &&
                    Date.parse(task.leaseUntil) <= this.now()),
              }
            : {}),
        };
      });
    if (!tasks.length) return tasks;
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const artifacts = this.db
      .prepare(
        `SELECT task_id, generation, id, hash FROM artifacts WHERE task_id IN (${tasks.map(() => '?').join(',')}) ORDER BY id`,
      )
      .all(...tasks.map((task) => task.id));
    for (const artifact of artifacts) {
      const task = byId.get(artifact.task_id);
      if (task.generation === artifact.generation)
        task.artifacts.push({ id: artifact.id, sha256: artifact.hash });
    }
    return tasks;
  }
  claim(actor, id, input) {
    const task = this.task(actor, id);
    must(
      task.to === actor,
      403,
      'RECIPIENT_REQUIRED',
      'Only the recipient can claim this task.',
    );
    this.activeGrant(task.grantId, actor);
    const leaseMs = input.leaseMs ?? 60000;
    must(
      Number.isSafeInteger(leaseMs) && leaseMs >= 1000 && leaseMs <= 300000,
      400,
      'INVALID_INPUT',
      'leaseMs must be 1000–300000.',
    );
    must(
      task.state === 'queued' ||
        (task.state === 'running' && Date.parse(task.leaseUntil) <= this.now()),
      409,
      'TASK_UNAVAILABLE',
      'Task is terminal or already leased.',
    );
    must(
      task.attempt < 20,
      409,
      'ATTEMPTS_EXHAUSTED',
      'This task reached its 20-claim limit. Cancel it and investigate before submitting new work.',
    );
    const claimToken = secret();
    return this.transaction(() => {
      task.state = 'running';
      task.generation++;
      task.attempt++;
      task.claimHash = digest(claimToken);
      task.leaseUntil = new Date(
        Math.min(this.now() + leaseMs, Date.parse(task.expiresAt)),
      ).toISOString();
      task.updatedAt = this.iso();
      this.update('tasks', task);
      this.event(actor, 'task.claimed', id, {
        generation: task.generation,
        leaseUntil: task.leaseUntil,
        attempt: task.attempt,
      });
      return { task: this.viewTask(task), claimToken };
    });
  }
  claimed(actor, id, claimToken) {
    const task = this.task(actor, id);
    must(
      task.to === actor &&
        task.state === 'running' &&
        typeof claimToken === 'string' &&
        digest(claimToken) === task.claimHash &&
        Date.parse(task.leaseUntil) > this.now(),
      409,
      'STALE_CLAIM',
      'A current recipient claim token is required.',
    );
    this.activeGrant(task.grantId, actor);
    return task;
  }
  heartbeat(actor, id, input, claimToken) {
    const task = this.claimed(actor, id, claimToken);
    const leaseMs = input.leaseMs ?? 60000;
    must(
      Number.isSafeInteger(leaseMs) && leaseMs >= 1000 && leaseMs <= 300000,
      400,
      'INVALID_INPUT',
      'leaseMs must be 1000–300000.',
    );
    return this.transaction(() => {
      task.leaseUntil = new Date(
        Math.min(this.now() + leaseMs, Date.parse(task.expiresAt)),
      ).toISOString();
      task.updatedAt = this.iso();
      this.update('tasks', task);
      this.event(actor, 'task.heartbeat', id, {
        generation: task.generation,
        leaseUntil: task.leaseUntil,
      });
      return this.viewTask(task);
    });
  }
  putArtifact(actor, taskId, id, input, claimToken) {
    const task = this.claimed(actor, taskId, claimToken);
    identifier(id, 'artifact ID');
    must(
      allows(task.permissions, 'artifact.write', id),
      403,
      'SCOPE_DENIED',
      'Artifact write is outside the task grant.',
    );
    must(
      Object.hasOwn(input, 'value'),
      400,
      'INVALID_INPUT',
      'Artifact value is required.',
    );
    const value = {
      mediaType: text(input.mediaType || 'application/json', 'mediaType'),
      value: limitedJson(input.value, 262144, 'artifact'),
    };
    const hash = digest(value);
    const existing = this.db
      .prepare(
        'SELECT hash FROM artifacts WHERE task_id = ? AND generation = ? AND id = ?',
      )
      .get(taskId, task.generation, id);
    must(
      !existing || existing.hash === hash,
      409,
      'ARTIFACT_IMMUTABLE',
      'Artifact already exists with different contents.',
    );
    const storedBytes = this.db
      .prepare(
        'SELECT COALESCE(SUM(length(CAST(body AS BLOB))), 0) AS bytes FROM artifacts',
      )
      .get().bytes;
    must(
      existing ||
        storedBytes + Buffer.byteLength(canonical(value)) <= 64 * 1024 * 1024,
      507,
      'ARTIFACT_CAPACITY',
      'Artifact storage reached its 64 MiB limit.',
    );
    if (!existing)
      this.transaction(() => {
        this.db
          .prepare(
            'INSERT INTO artifacts (task_id, generation, id, body, hash) VALUES (?, ?, ?, ?, ?)',
          )
          .run(taskId, task.generation, id, canonical(value), hash);
        this.event(actor, 'artifact.created', taskId, {
          artifactId: id,
          sha256: hash,
          generation: task.generation,
        });
      });
    return { id, sha256: hash };
  }
  getArtifact(actor, taskId, id) {
    const task = this.task(actor, taskId);
    identifier(id, 'artifact ID');
    if (actor !== 'owner' && actor !== task.from) {
      this.activeGrant(task.grantId, actor);
      must(
        allows(task.permissions, 'artifact.read', id),
        403,
        'SCOPE_DENIED',
        'Artifact read is outside the task grant.',
      );
    }
    const row = this.db
      .prepare(
        'SELECT body, hash FROM artifacts WHERE task_id = ? AND generation = ? AND id = ?',
      )
      .get(taskId, task.generation, id);
    must(row, 404, 'ARTIFACT_NOT_FOUND', 'Artifact is unavailable.');
    return { id, ...JSON.parse(row.body), sha256: row.hash };
  }
  finish(actor, id, state, input, claimToken) {
    const task = this.claimed(actor, id, claimToken);
    must(
      Object.hasOwn(input, 'result'),
      400,
      'INVALID_INPUT',
      'result is required.',
    );
    const result = limitedJson(input.result, 65536, 'result');
    must(
      result && typeof result === 'object' && !Array.isArray(result),
      400,
      'INVALID_INPUT',
      'result must be a JSON object.',
    );
    if (state === 'completed') {
      for (const artifactId of task.requiredArtifacts)
        must(
          this.db
            .prepare(
              'SELECT id FROM artifacts WHERE task_id = ? AND generation = ? AND id = ?',
            )
            .get(id, task.generation, artifactId),
          409,
          'ARTIFACTS_MISSING',
          `Required artifact ${artifactId} is missing.`,
        );
      must(
        !this.db
          .prepare(
            "SELECT id FROM tasks WHERE json_extract(body, '$.parentTaskId') = ? AND json_extract(body, '$.parentGeneration') = ? AND json_extract(body, '$.state') IN ('queued', 'running') LIMIT 1",
          )
          .get(id, task.generation),
        409,
        'CHILDREN_PENDING',
        'Finish or cancel child tasks before completing this task.',
      );
    }
    return this.transaction(() => {
      task.state = state;
      task.result = result;
      task.claimHash = null;
      task.leaseUntil = null;
      task.updatedAt = this.iso();
      this.update('tasks', task);
      this.event(actor, `task.${state}`, id, {
        resultSha256: digest(result),
        artifacts: this.viewTask(task).artifacts,
        generation: task.generation,
      });
      return this.viewTask(task);
    });
  }
  cancel(actor, id) {
    const task = this.task(actor, id);
    must(
      actor === 'owner' || actor === task.from,
      403,
      'ISSUER_REQUIRED',
      'Only the owner or issuing agent can cancel a task.',
    );
    must(
      !terminal(task.state),
      409,
      'TASK_TERMINAL',
      'Terminal tasks cannot be rewritten.',
    );
    return this.transaction(() => {
      task.state = 'cancelled';
      task.result = { reason: 'issuer_cancelled' };
      task.claimHash = null;
      task.leaseUntil = null;
      task.updatedAt = this.iso();
      this.update('tasks', task);
      this.event(actor, 'task.cancelled', id, { reason: 'issuer_cancelled' });
      return this.viewTask(task);
    });
  }
  receipt(actor, id) {
    const task = this.task(actor, id);
    must(
      terminal(task.state),
      409,
      'TASK_NOT_TERMINAL',
      'Receipts require a terminal task.',
    );
    const { input, result, ...summary } = this.viewTask(task);
    const row = this.db
      .prepare(
        "SELECT body, hash FROM events WHERE json_extract(body, '$.taskId') = ? AND json_extract(body, '$.type') = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(id, `task.${task.state}`);
    must(
      row,
      500,
      'RECEIPT_UNAVAILABLE',
      'The terminal task event is missing.',
    );
    const taskEvent = { ...JSON.parse(row.body), hash: row.hash };
    return this.sign({
      kind: 'receipt',
      task: {
        ...summary,
        inputSha256: digest(input),
        resultSha256: digest(result),
      },
      taskEvent,
      head: { sequence: taskEvent.sequence, hash: taskEvent.hash },
    });
  }
  audit(actor) {
    this.owner(actor);
    return this.sign({
      kind: 'audit',
      events: this.db
        .prepare('SELECT body, hash FROM events ORDER BY sequence')
        .all()
        .map((row) => ({ ...JSON.parse(row.body), hash: row.hash })),
      head: this.head(),
    });
  }
  sign(payload) {
    return signedEnvelope(
      {
        schemaVersion: 1,
        runtimeId: this.identity.runtimeId,
        exportedAt: this.iso(),
        ...payload,
      },
      this.identity.privateKey,
      this.identity.publicKey,
    );
  }
}
