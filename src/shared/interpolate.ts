// {{variable}} templating. Only plain substitution is supported — there are no
// expressions, so templates can never execute code.

const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export const BUILTIN_VARIABLES = ['date', 'time', 'datetime', 'timestamp', 'runId'] as const;
export type BuiltinVariable = (typeof BUILTIN_VARIABLES)[number];

const pad = (n: number) => String(n).padStart(2, '0');

export function builtinValues(now: Date, runId: string): Record<BuiltinVariable, string> {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return { date, time, datetime: `${date} ${time}`, timestamp: String(now.getTime()), runId };
}

export function referencedVariables(template: string): string[] {
  return [...template.matchAll(TOKEN_RE)].map((m) => m[1]);
}

export class MissingVariableError extends Error {
  constructor(public readonly variable: string) {
    super(`Variable "${variable}" has no value yet`);
  }
}

export function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(TOKEN_RE, (_, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) throw new MissingVariableError(name);
    return values[name];
  });
}
