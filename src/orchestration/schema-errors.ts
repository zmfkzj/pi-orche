import type { TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * Validation errors of `value` against `schema` as `path: message` lines, for messages shown to a model.
 *
 * Two TypeBox generations meet here: the package's own `@sinclair/typebox` 0.34 (tests, the SDK used as a library) returns a lazy
 * iterator of errors with `path`, while Pi's runtime aliases `@sinclair/typebox` to `typebox` 1.x, whose `Value.Errors` returns an
 * array of AJV-style errors with `instancePath` (and no `First()`). Reading only `error.path` turned every error into `/` under Pi
 * (seen in real worker transcripts: `/: must not have fewer than 1 characters` eight times), and `.First()` would throw. This reads
 * both shapes, keeps the first `limit` distinct lines and never throws.
 */
export function schemaErrors(schema: TSchema, value: unknown, limit = 8): string[] {
  const lines: string[] = [];
  try {
    const errors = Value.Errors(schema, value) as unknown as Iterable<unknown>;
    for (const error of errors) {
      const line = formatError(error);
      if (!lines.includes(line)) lines.push(line);
      if (lines.length >= limit) break;
    }
  } catch (error) {
    lines.push(`/: ${error instanceof Error ? error.message : String(error)}`);
  }
  return lines;
}

/** One error object of either TypeBox generation as `path: message`. */
export function formatError(error: unknown): string {
  const record = (error && typeof error === "object" ? error : {}) as { path?: unknown; instancePath?: unknown; message?: unknown; params?: unknown };
  const path = typeof record.path === "string" && record.path ? record.path : typeof record.instancePath === "string" && record.instancePath ? record.instancePath : "/";
  const message = typeof record.message === "string" ? record.message : "invalid value";
  // AJV-style required errors name the missing property only in params.
  const params = record.params && typeof record.params === "object" ? record.params as Record<string, unknown> : undefined;
  const missing = Array.isArray(params?.requiredProperties) ? ` (${(params.requiredProperties as unknown[]).join(", ")})`
    : typeof params?.missingProperty === "string" ? ` (${params.missingProperty})` : "";
  return `${path}: ${message}${missing && !message.includes(String(missing.slice(2, -1))) ? missing : ""}`;
}

/** `schemaErrors(...).join("; ")`, or `fallback` when there is none. */
export function formatSchemaErrors(schema: TSchema, value: unknown, limit = 8, fallback = "invalid value"): string {
  const lines = schemaErrors(schema, value, limit);
  return lines.length ? lines.join("; ") : fallback;
}
