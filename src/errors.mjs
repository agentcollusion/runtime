export class RuntimeError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function requireCondition(ok, status, code, message) {
  if (!ok) throw new RuntimeError(status, code, message);
}
export function text(value, label, max = 128) {
  requireCondition(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= max &&
      Array.from(value).every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127,
      ),
    400,
    'INVALID_INPUT',
    `${label} must be 1–${max} characters without control characters.`,
  );
  return value;
}
export function identifier(value, label = 'ID') {
  text(value, label);
  requireCondition(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value),
    400,
    'INVALID_INPUT',
    `${label} must use letters, digits and . _ - only.`,
  );
  return value;
}
export function timestamp(value, label = 'expiresAt') {
  requireCondition(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    400,
    'INVALID_INPUT',
    `${label} must be an ISO UTC timestamp with milliseconds.`,
  );
  return value;
}
export function permissions(value) {
  requireCondition(
    Array.isArray(value) && value.length > 0 && value.length <= 32,
    400,
    'INVALID_INPUT',
    'permissions must contain 1–32 operation/resource pairs.',
  );
  const normalized = value.map((p) => {
    requireCondition(
      p &&
        ['task.submit', 'artifact.read', 'artifact.write'].includes(
          p.operation,
        ),
      400,
      'INVALID_INPUT',
      'Unsupported permission operation.',
    );
    return {
      operation: p.operation,
      resource: identifier(p.resource, 'resource'),
    };
  });
  requireCondition(
    new Set(normalized.map((p) => `${p.operation}/${p.resource}`)).size ===
      normalized.length,
    400,
    'INVALID_INPUT',
    'Duplicate permission.',
  );
  return normalized.sort((a, b) => {
    const left = `${a.operation}/${a.resource}`,
      right = `${b.operation}/${b.resource}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
