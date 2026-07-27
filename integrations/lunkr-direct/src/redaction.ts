const SECRET_KEY = /(?:password|passwd|secret|token|cookie|sid|authorization|api[_-]?key)/i;
const COOKIE_OR_BEARER = /(?:\b(?:Cookie|Authorization)\s*:\s*|\bBearer\s+)[^\s,;]+/gi;

export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(COOKIE_OR_BEARER, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY.test(key) ? "[REDACTED]" : redact(child),
      ]),
    );
  }
  return value;
}

export function safeError(error: unknown): string {
  if (error instanceof Error) {
    return String(redact(error.message));
  }
  return String(redact(String(error)));
}
