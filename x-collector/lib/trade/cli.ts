export interface ParsedArgv {
  positional: string[];
  flags: Record<string, string>;
}

/**
 * Разбирает argv вида `pos --flag value --key=value --bare`.
 * Хвостовые позиционные аргументы (после флагов) тоже сохраняются.
 */
export function parseArgv(argv: string[], opts?: { positionalBeforeFlags?: number }): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  const minPositional = opts?.positionalBeforeFlags ?? 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && positional.length >= minPositional) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        flags[body] = next !== undefined && !next.startsWith("--") ? argv[++i] : "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

export function intFlag(
  flags: Record<string, string>,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  const raw = flags[name];
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  }
  return n;
}

export function enumFlag<T extends string>(
  flags: Record<string, string>,
  name: string,
  def: T,
  allowed: readonly T[],
): T {
  const raw = flags[name];
  if (raw === undefined) return def;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`--${name} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}
