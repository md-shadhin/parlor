// Small helpers for narrowing `unknown` catch bindings (strict mode).

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function errName(e: unknown): string {
  return e instanceof Error ? e.name : '';
}
