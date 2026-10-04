/** Composable validation used by surrounding CLI tools, not the ticket contracts. */
export function string({ min = 0, max = Infinity, pattern } = {}) {
  return (value, path) => {
    if (typeof value !== 'string' || value.length < min || value.length > max ||
        (pattern && !pattern.test(value))) return [{ path, code: 'STRING' }];
    return [];
  };
}
export function integer({ min = -Infinity, max = Infinity } = {}) {
  return (value, path) => Number.isSafeInteger(value) && value >= min && value <= max
    ? [] : [{ path, code: 'INTEGER' }];
}
export function enumeration(values) {
  const allowed = new Set(values);
  return (value, path) => allowed.has(value) ? [] : [{ path, code: 'ENUM' }];
}
export function optional(validator) {
  return (value, path) => value === undefined ? [] : validator(value, path);
}
export function array(validator, { min = 0, max = Infinity } = {}) {
  return (value, path) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) {
      return [{ path, code: 'ARRAY' }];
    }
    return value.flatMap((item, index) => validator(item, path + '/' + index));
  };
}
export function object(fields, { strict = true } = {}) {
  return (value, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ path, code: 'OBJECT' }];
    const errors = [];
    for (const [key, validator] of Object.entries(fields)) {
      errors.push(...validator(value[key], path + '/' + key));
    }
    if (strict) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(fields, key)) errors.push({ path: path + '/' + key, code: 'UNKNOWN' });
      }
    }
    return errors;
  };
}
export function union(...validators) {
  return (value, path) => {
    for (const validator of validators) if (!validator(value, path).length) return [];
    return [{ path, code: 'UNION' }];
  };
}
export function validate(value, validator) {
  const errors = validator(value, '');
  return { valid: errors.length === 0, errors };
}
export function assertValid(value, validator) {
  const result = validate(value, validator);
  if (!result.valid) {
    throw Object.assign(new Error('Input validation failed'), { code: 'VALIDATION', errors: result.errors });
  }
  return value;
}
export function literal(expected) {
  return (value, path) => value === expected ? [] : [{ path, code: 'LITERAL' }];
}
