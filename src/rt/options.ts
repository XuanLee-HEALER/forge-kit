import { RUNTIME_PRIMITIVES, type RuntimePrimitive } from "./config";

const flags = {
  list: [],
  status: ["env", "service"],
  changes: ["repo", "from-sha", "to-ref", "limit", "env", "service"],
  logs: ["env", "service", "from", "to", "minutes", "level", "trace", "grep", "limit"],
  query: ["env", "target", "expr", "param", "limit"],
  metrics: ["env", "service", "metric", "from", "to", "minutes"],
} as const;

export type RuntimeCommand = RuntimePrimitive | "list";

export function isRuntimeCommand(value: string): value is RuntimeCommand {
  return value === "list" || RUNTIME_PRIMITIVES.some(primitive => primitive === value);
}

export class RuntimeParameterError extends Error {}

export interface RuntimeInputs {
  env?: string;
  service?: string;
  target?: string;
  from_unix?: number;
  to_unix?: number;
  from_iso?: string;
  to_iso?: string;
  limit?: number;
  level?: string;
  trace?: string;
  grep?: string;
  metric?: string;
  expr?: string;
  params_json?: string;
}

type Instant = { second: number; fraction: string };
const maxSecond = 8_640_000_000_000;
const isoTime = /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/;

function validInstant({ second, fraction }: Instant): boolean {
  return Number.isSafeInteger(second) && Math.abs(second) <= maxSecond && (second < maxSecond || !fraction);
}

function instant(input: string, option: string): Instant {
  const invalid = () => new RuntimeParameterError(`${option} must be Unix seconds or a valid ISO timestamp with a timezone.`);
  if (input !== input.trim()) throw invalid();
  if (/^-?\d+$/.test(input)) {
    const value = { second: Number(input), fraction: "" };
    if (validInstant(value)) return value;
    throw invalid();
  }

  const parts = isoTime.exec(input);
  if (!parts) throw invalid();
  const [, year, month, day, hour, minute, second = "00", fraction = "", timezone] = parts;
  const [y, m, d, h, min, s] = [year, month, day, hour, minute, second].map(Number);
  if (year === "-000000" || m < 1 || m > 12 || h > 23 || min > 59 || s > 59) throw invalid();
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (d < 1 || d > monthDays[m - 1]) throw invalid();

  let offset = 0;
  if (timezone !== "Z") {
    const hours = Number(timezone.slice(1, 3));
    const minutes = Number(timezone.slice(-2));
    if (hours > 23 || minutes > 59) throw invalid();
    offset = (hours * 60 + minutes) * (timezone.startsWith("-") ? -1 : 1);
  }

  // Shift the calendar date first, so offset conversion at the Date limits still works.
  const utc = new Date(0);
  const dayOffset = Math.floor((h * 60 + min - offset) / 1440);
  const minuteOfDay = h * 60 + min - offset - dayOffset * 1440;
  utc.setUTCFullYear(y, m - 1, d + dayOffset);
  utc.setUTCHours(0, minuteOfDay, s, 0);
  const value = { second: utc.getTime() / 1000, fraction: fraction.replace(/0+$/, "") };
  if (!validInstant(value)) throw invalid();
  return value;
}

function timeWindow(fromArg: string | undefined, toArg: string | undefined, minutesArg: string | undefined, now: number) {
  if (fromArg !== undefined && toArg !== undefined && minutesArg !== undefined)
    throw new RuntimeParameterError("--minutes conflicts with explicit --from and --to.");
  const minutes = minutesArg === undefined ? 15 : positiveInteger(minutesArg, "minutes", 1440);
  const currentSecond = Math.floor(now / 1000);
  const current = { second: currentSecond, fraction: String(now - currentSecond * 1000).padStart(3, "0").replace(/0+$/, "") };
  const from = fromArg === undefined ? undefined : instant(fromArg, "--from");
  const to = toArg === undefined ? undefined : instant(toArg, "--to");
  const end = to ?? (from && minutesArg !== undefined ? { ...from, second: from.second + minutes * 60 } : current);
  const start = from ?? { ...end, second: end.second - minutes * 60 };
  if (!validInstant(start) || !validInstant(end))
    throw new RuntimeParameterError("The calculated time window is outside the supported date range.");
  if (start.second > end.second || start.second === end.second && start.fraction > end.fraction)
    throw new RuntimeParameterError("--from must be earlier than or equal to --to.");
  return {
    from_unix: start.second,
    to_unix: end.second,
    from_iso: new Date(start.second * 1000).toISOString(),
    to_iso: new Date(end.second * 1000).toISOString(),
  };
}

function positiveInteger(raw: string, name: string, max: number): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || raw !== raw.trim() || value < 1 || value > max)
    throw new RuntimeParameterError(`--${name} must be an integer from 1 to ${max}.`);
  return value;
}

export function parseRuntimeOptions(command: RuntimeCommand, args: string[], now: number) {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const params = new Map<string, string>();
  const allowed = new Set<string>(flags[command]);

  for (let index = 0; index < args.length; index++) {
    const flag = /^--([a-z-]+)(?:=([\s\S]*))?$/.exec(args[index]);
    if (!flag || flag[0] !== args[index]) throw new RuntimeParameterError("Unexpected argument. See forge rt --help.");
    const [, name, inline] = flag;
    if (name === "json" || command === "changes" && (name === "live" || name === "with-adapter")) {
      if (inline !== undefined) throw new RuntimeParameterError(`--${name} does not take a value.`);
      switches.add(name);
      continue;
    }
    if (!allowed.has(name)) throw new RuntimeParameterError("Unknown option for this primitive. See forge rt --help.");
    const value = inline ?? args[index + 1];
    if (value === undefined || inline === undefined && value.startsWith("-") &&
        !((name === "from" || name === "to") && /^-\d+$/.test(value)))
      throw new RuntimeParameterError(`--${name} requires a value. Use --${name}=value for values starting with a dash.`);
    if (inline === undefined) index++;
    if (name === "param") {
      const equal = value.indexOf("=");
      if (equal <= 0) throw new RuntimeParameterError("--param requires a nonempty key in k=v form.");
      params.set(value.slice(0, equal), value.slice(equal + 1));
    } else values.set(name, value);
  }

  const env = values.get("env");
  const live = switches.has("live");
  if (live && !env?.trim()) throw new RuntimeParameterError("--live requires --env.");
  const limit = positiveInteger(values.get("limit") ?? "100", "limit", 500);
  const inputs: RuntimeInputs = {
    env, service: values.get("service"), target: values.get("target"),
    ...(command === "logs" || command === "metrics" ?
      timeWindow(values.get("from"), values.get("to"), values.get("minutes"), now) : {}),
    limit: command === "logs" || command === "query" || command === "changes" ? limit : undefined,
    level: values.get("level"), trace: values.get("trace"), grep: values.get("grep"),
    metric: values.get("metric"), expr: values.get("expr"),
    params_json: command === "query" ? JSON.stringify(Object.fromEntries(params)) : undefined,
  };
  return {
    inputs, params, limit, live, withAdapter: switches.has("with-adapter"),
    repo: values.get("repo"), fromSha: values.get("from-sha"), toRef: values.get("to-ref"),
  };
}
