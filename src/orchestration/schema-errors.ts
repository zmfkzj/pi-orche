import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/**
 * Validation errors of `value` against `schema` as `path: message` lines, for messages shown to a model.
 *
 * The package imports the host-provided `typebox` 1.x, whose `Value.Errors` returns an array of AJV-style errors with
 * `instancePath` (and no `First()`). TypeBox 0.34 (`@sinclair/typebox`, used before the switch) returned a lazy iterator of errors
 * with `path`. Reading only `error.path` turned every 1.x error into `/` (seen in real worker transcripts: `/: must not have fewer
 * than 1 characters` eight times), and `.First()` would throw. This reads both shapes, keeps the first `limit` distinct lines and
 * never throws.
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
  const record = (error && typeof error === "object" ? error : {}) as { path?: unknown; instancePath?: unknown; message?: unknown; params?: unknown; keyword?: unknown; schemaPath?: unknown };
  const path = typeof record.path === "string" && record.path ? record.path : typeof record.instancePath === "string" && record.instancePath ? record.instancePath : "/";
  // TypeBox 1.x reports a property rejected by `additionalProperties: false` as `schema is false` at the property's path; say what it means.
  const extra = record.keyword === "boolean" && typeof record.schemaPath === "string" && record.schemaPath.endsWith("/additionalProperties");
  const message = extra ? "Unexpected property" : typeof record.message === "string" ? record.message : "invalid value";
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
