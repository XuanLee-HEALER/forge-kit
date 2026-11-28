import { object, string, turnId, type RolloutRecord } from "./rollout-record";
import { sumUsage, tokenFields, type TokenField, type Usage } from "./usage";

export { tokenFields } from "./usage";
export type RolloutUsage = Usage;
export type RolloutIncrement = {
  session_id: string;
  role: string;
  model: string | null;
  ts: string | null;
  from_ts?: string;
  usage: RolloutUsage;
};

function emptyUsage(): RolloutUsage {
  return { ...Object.fromEntries(tokenFields.map(key => [key, null])), cache_hit_rate: null } as RolloutUsage;
}

function rederive(usage: RolloutUsage): RolloutUsage {
  const total = usage.total_tokens;
  if (total !== null && usage.input_tokens === null && usage.output_tokens !== null && total >= usage.output_tokens)
    usage.input_tokens = total - usage.output_tokens;
  if (total !== null && usage.output_tokens === null && usage.input_tokens !== null && total >= usage.input_tokens)
    usage.output_tokens = total - usage.input_tokens;
  const { input_tokens: input, cached_input_tokens: cached, output_tokens: output } = usage;
  usage.uncached_input_tokens = input !== null && cached !== null ? input - cached : null;
  if (usage.total_tokens === null && input !== null && output !== null && Number.isSafeInteger(input + output))
    usage.total_tokens = input + output;
  usage.cache_hit_rate = input && cached !== null ? cached / input : null;
  return usage;
}

type Note = (message: string) => void;

function checkedUsage(raw: unknown, note: Note): RolloutUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const source = object(raw);
  if (!tokenFields.some(key => Object.hasOwn(source, key))) return null;
  const usage = emptyUsage();
  for (const key of tokenFields) {
    if (key === "uncached_input_tokens") continue;
    const value = source[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
    else if (value !== undefined && value !== null) note("Invalid token counter");
  }
  if (!consistent(rederive(usage))) {
    note("Inconsistent token counters");
    return null;
  }
  return usage;
}

function consistent(u: RolloutUsage) {
  const { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write,
    output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total } = u;
  return (input === null || cached === null || cached <= input) &&
    (input === null || write === null || write <= input) &&
    (output === null || reasoning === null || reasoning <= output) &&
    (total === null || (input === null || input <= total) && (output === null || output <= total)) &&
    (input === null || output === null || total === null || total === input + output);
}

const ioFields = ["input_tokens", "output_tokens"] as const;
const coreFields = [...ioFields, "total_tokens"] as const;
const detailFields = ["cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"] as const;

function comparable(a: RolloutUsage | null, b: RolloutUsage | null) {
  return a !== null && b !== null &&
    coreFields.every(key => a[key] !== null && a[key] === b[key]) &&
    sharedCountersAgree(a, b);
}

function sharedCountersAgree(a: RolloutUsage, b: RolloutUsage) {
  return tokenFields.every(key => a[key] === null || b[key] === null || a[key] === b[key]);
}

function withMissing(primary: RolloutUsage, other: RolloutUsage | null) {
  if (!other) return primary;
  const joined = emptyUsage();
  for (const key of tokenFields) joined[key] = primary[key] ?? other[key];
  return consistent(rederive(joined)) ? joined : primary;
}

function difference(current: RolloutUsage, previous: RolloutUsage): RolloutUsage | null {
  const diff = emptyUsage();
  for (const key of tokenFields) {
    if (key === "uncached_input_tokens") continue;
    // A zero parent counter proves that its previously omitted subset was zero.
    const zeroInput = (key === "cached_input_tokens" || key === "cache_write_input_tokens") && previous.input_tokens === 0;
    const zeroOutput = key === "reasoning_output_tokens" && previous.output_tokens === 0;
    const start = previous[key] ?? (zeroInput || zeroOutput ? 0 : null), end = current[key];
    if (start === null || end === null) continue;
    if (end < start) return null;
    diff[key] = end - start;
  }
  return consistent(rederive(diff)) ? diff : null;
}

type Sample = {
  native: boolean;
  id: string | null;
  total: RolloutUsage | null;
  last: RolloutUsage | null;
  model: string | null;
  ts: string | null;
  turn: string | null;
  turnStart: string | undefined;
  modelEpoch: number;
  fresh: boolean;
};

function mirrors(a: Sample, b: Sample) {
  if (a.native === b.native || (a.id && b.id && a.id !== b.id)) return false;
  if (comparable(a.total, b.total) && (!a.last || !b.last || comparable(a.last, b.last))) return true;
  const left = a.last, right = b.last;
  if (!left || !right || !sharedCountersAgree(left, right) ||
      (!comparable(left, right) && !coreFields.some(key => (left[key] ?? 0) > 0 && left[key] === right[key]))) return false;
  if (!a.total && !b.total) return a.turn === b.turn;
  if (Boolean(a.total) === Boolean(b.total) || (a.turn && b.turn && a.turn !== b.turn)) return false;
  // Adjacent exporters can report the same request at different times.
  return Boolean(a.turn && a.turn === b.turn) || (a.ts !== null && a.ts === b.ts);
}

function mergeSample(target: Sample, source: Sample) {
  const preferred = source.native && !target.native ? source : target;
  const alternate = preferred === target ? source : target;
  const total = preferred.total ? withMissing(preferred.total, alternate.total) : alternate.total;
  const last = preferred.last ? withMissing(preferred.last, alternate.last) : alternate.last;
  const model = preferred.model ?? (preferred.turn === alternate.turn ? alternate.model : null);
  Object.assign(target, { ...preferred, id: preferred.id ?? alternate.id, total, last, model });
}

function positiveUsage(usage: RolloutUsage) {
  return tokenFields.some(field => (usage[field] ?? 0) > 0);
}

function reconcileSpan(
  budget: RolloutUsage, requests: RolloutIncrement[], span: RolloutIncrement, note: Note,
): RolloutIncrement[] {
  if (!requests.length) return [{ ...span, usage: budget }];
  const assigned = requests.map(request => ({ ...request, usage: { ...request.usage } }));
  const fieldSum = (key: TokenField) => assigned.reduce((sum, entry) => sum + (entry.usage[key] ?? 0), 0);
  if (coreFields.some(key => budget[key] !== null && fieldSum(key) > budget[key]!)) {
    note("Cumulative usage conflicts with request records");
    return [{ ...span, model: null, usage: budget }];
  }
  const missing = (key: TokenField) => assigned.filter(entry => entry.usage[key] === null);
  const fill = (request: RolloutIncrement, key: TokenField, value: number) => {
    const usage = rederive({ ...request.usage, [key]: value });
    if (consistent(usage)) request.usage = usage;
  };
  for (const key of coreFields) {
    if (budget[key] !== null && fieldSum(key) === budget[key])
      for (const request of missing(key)) fill(request, key, 0);
  }
  const covered = ioFields.every(key =>
    budget[key] !== null && missing(key).length === 0 && fieldSum(key) === budget[key]);
  for (const key of detailFields) {
    const limit = budget[key];
    if (limit === null) continue;
    if (fieldSum(key) > limit) {
      note("Cumulative usage conflicts with request token components");
      for (const request of assigned) request.usage[key] = null;
      continue;
    }
    const remaining = limit - fieldSum(key);
    const absent = missing(key);
    if (remaining === 0) {
      for (const request of absent) fill(request, key, 0);
    } else if (covered && absent.length === 1) {
      fill(absent[0], key, remaining);
    }
  }
  for (const request of assigned) rederive(request.usage);
  const remaining = emptyUsage();
  for (const key of tokenFields) {
    const total = budget[key];
    if (total !== null && total > fieldSum(key)) remaining[key] = total - fieldSum(key);
  }
  if (positiveUsage(remaining)) {
    note("Cumulative usage includes unallocated token components");
    assigned.push({ ...span, model: null, usage: remaining });
  }
  return assigned;
}

export function rolloutUsage(
  records: RolloutRecord[], session_id: string, role: string, note: Note,
) {
  const samples: Sample[] = [];
  const requests = new Map<string, Sample>();
  const contexts = new Map<string, { model: string | null; effort: string | null }>();
  const turnStarts = new Map<string, string>();
  const models = new Set<string>();
  const efforts = new Set<string>();
  let context: { model: string | null; effort: string | null } = { model: null, effort: null };
  let latestTurn: string | null = null;
  let modelEpoch = 0;
  let fresh = false;
  for (const record of records) {
    const { type, payload, ts } = record;
    const kind = string(payload.type);
    const turn = turnId(payload);
    if (type === "session_meta") fresh = true;
    if (type === "rollout_gap") fresh = false;
    if (type === "turn_context" || type === "session_meta" ||
      (type === "event_msg" && kind === "thread_settings_applied")) {
      const settings = type === "event_msg" ? object(payload.thread_settings) : payload;
      const model = string(settings.model) ?? (type === "turn_context" ? null : context.model);
      const effort = string(settings.effort) ?? string(settings.reasoning_effort) ??
        (type === "turn_context" ? null : context.effort);
      if (model !== context.model) modelEpoch++;
      context = { model, effort };
      if (turn) contexts.set(turn, context);
      if (model) models.add(model);
      if (effort) efforts.add(effort);
    }
    if (type === "turn_context" || (type === "event_msg" && ["task_started", "turn_started"].includes(kind ?? ""))) {
      if (turn) {
        latestTurn = turn;
        if (ts && !turnStarts.has(turn)) turnStarts.set(turn, ts);
        if (!contexts.has(turn)) contexts.set(turn, context);
      }
    }
    const native = type === "token_usage_record" || (type === "event_msg" && kind === "token_usage_record");
    if (!native && type !== "token_count" && !(type === "event_msg" && kind === "token_count")) continue;
    if (native && string(payload.thread_id) && payload.thread_id !== session_id) continue;
    const info = object(payload.info);
    const total = checkedUsage(native ? payload.thread_token_usage ?? payload.total_token_usage ?? info.total_token_usage
      : info.total_token_usage ?? payload.total_token_usage, note);
    const last = checkedUsage(native ? payload.usage ?? payload.last_token_usage ?? info.last_token_usage
      : info.last_token_usage ?? payload.last_token_usage, note);
    if (!total && !last) continue;
    const sampleTurn = turn ?? latestTurn;
    const model = string(payload.model) ?? (sampleTurn ? contexts.get(sampleTurn)?.model ?? null : context.model);
    const effort = string(payload.effort);
    if (model) models.add(model);
    if (effort) efforts.add(effort);
    const id = string(payload.response_id) ?? string(payload.request_id) ?? string(payload.event_id) ?? string(payload.id);
    const sample: Sample = {
      native, id, total, last, model, ts, turn: sampleTurn, turnStart: sampleTurn ? turnStarts.get(sampleTurn) : undefined,
      modelEpoch, fresh,
    };
    const previous = samples.at(-1);
    if (id && requests.has(id)) {
      const first = requests.get(id)!;
      if ((first.total && total && !sharedCountersAgree(first.total, total)) ||
        (first.last && last && !sharedCountersAgree(first.last, last))) note("Conflicting duplicate usage record");
      else {
        mergeSample(first, sample);
        if (previous && previous !== first && mirrors(previous, sample)) {
          mergeSample(first, previous);
          samples.pop();
        }
      }
      continue;
    }
    if (previous && mirrors(previous, sample)) {
      mergeSample(previous, sample);
      if (id) requests.set(id, previous);
      continue;
    }
    samples.push(sample);
    if (id) requests.set(id, sample);
  }

  const increments: RolloutIncrement[] = [];
  function append(entries: RolloutIncrement[]) {
    for (const entry of entries) increments.push(entry);
  }
  let baseline: Sample | undefined;
  let pending: RolloutIncrement[] = [];
  for (const sample of samples) {
    const common = { session_id, role, model: sample.model, ts: sample.ts };
    const request = sample.last && { ...common, from_ts: sample.turnStart, usage: sample.last };
    if (!sample.total) {
      if (request) pending.push(request);
      continue;
    }
    const candidates = request ? [...pending, request] : pending;
    if (baseline?.total) {
      const budget = difference(sample.total, baseline.total);
      const sameModel = sample.model === baseline.model && sample.modelEpoch === baseline.modelEpoch;
      if (budget) {
        const from = baseline.ts ?? undefined;
        const span = { ...common, from_ts: from, model: sameModel ? sample.model : null, usage: budget };
        // An unchanged cumulative snapshot can repeat the previous last record.
        if (positiveUsage(budget) || pending.length) {
          if (request && from && (!request.from_ts || request.from_ts < from)) request.from_ts = from;
          append(reconcileSpan(budget, candidates, span, note));
        } else if (!request) {
          increments.push(span);
        }
      } else if (request && comparable(sample.total, request.usage)) {
        append(pending);
        increments.push({ ...request, usage: withMissing(sample.total, request.usage) });
      } else {
        append(candidates);
        note("Cumulative token counter reset without recoverable baseline");
      }
    } else {
      const observed = sumUsage(candidates.map(candidate => candidate.usage));
      const exactlyCovered = coreFields.every(key => sample.total![key] !== null && sample.total![key] === observed[key]);
      if (exactlyCovered || (!candidates.length && sample.fresh)) {
        const span = { ...common, from_ts: sample.turnStart, usage: sample.total };
        append(reconcileSpan(sample.total, candidates, span, note));
      } else {
        // A last record remains usable even if an initial cumulative baseline is missing.
        append(pending.length ? pending : candidates);
        note("Missing cumulative token baseline");
      }
    }
    baseline = sample;
    pending = [];
  }
  append(pending);
  for (const increment of increments)
    if (!increment.model && positiveUsage(increment.usage)) note("Actual model is missing for usage");
  if (!increments.length) note("Token usage is missing");
  return { increments, usage: sumUsage(increments.map(increment => increment.usage)),
    model: [...models], effort: [...efforts] };
}
