type DatabaseError = Error & { code?: string; cause?: unknown };

function errorChain(error: unknown) {
  const values: unknown[] = [];
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1) {
    values.push(current);
    current = typeof current === "object" && current !== null && "cause" in current
      ? (current as { cause?: unknown }).cause
      : null;
  }
  return values;
}

export function isUniqueConstraintError(error: unknown) {
  return errorChain(error).some((value) => {
    const item = value as Partial<DatabaseError>;
    return item?.code === "23505"
      || /(?:SQLITE_CONSTRAINT(?:_UNIQUE)?|UNIQUE constraint failed|duplicate key value violates unique constraint)/i
        .test(String(item?.message ?? ""));
  });
}

export function isCheckConstraintError(error: unknown) {
  return errorChain(error).some((value) => {
    const item = value as Partial<DatabaseError>;
    return item?.code === "23514"
      || /(?:SQLITE_CONSTRAINT(?:_CHECK)?|check constraint)/i.test(String(item?.message ?? ""));
  });
}
