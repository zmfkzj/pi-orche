const INTEGER_STRING = /^\s*-?\d+\s*$/;

type Prepare = (args: unknown) => any;

/**
 * A `prepareArguments` hook (pi's agent loop calls it before schema validation) that turns integer-looking strings
 * (`"290"`, `" 12 "`, `"-1"`) of the given top-level keys into numbers. Anything else (`"1,"`, `"ten"`, `1.5`) is left
 * untouched for the normal validation error. Returns the same object when nothing changed, as pi expects.
 * `next` (e.g. the wrapped Pi tool's own hook) runs on the result.
 */
export function coerceIntegerArguments(keys: readonly string[], next?: Prepare): Prepare {
  return (args: unknown) => {
    let out = args;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      let copy: Record<string, unknown> | undefined;
      for (const key of keys) {
        const value = (args as Record<string, unknown>)[key];
        if (typeof value !== "string" || !INTEGER_STRING.test(value)) continue;
        const number = Number(value.trim());
        if (!Number.isSafeInteger(number)) continue;
        copy ??= { ...(args as Record<string, unknown>) };
        copy[key] = number;
      }
      if (copy) out = copy;
    }
    return next ? next(out) : out;
  };
}
