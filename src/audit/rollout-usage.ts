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
  if (!consistent(usage)) {
    note("Inconsistent token counters");
    return null;
  }
  return rederive(usage);
}

function consistent(u: RolloutUsage) {
  const { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write,
    output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total } = u;
  return (input === null || cached === null || cached <= input) &&
    (input === null || write === null || write <= input) &&
    (output === null || reasoning === null || reasoning <= output) &&
    (input === null || output === null || total === null || total === input + output);
}

function comparable(a: RolloutUsage | null, b: RolloutUsage | null) {
  return a !== null && b !== null &&
    ["input_tokens", "output_tokens", "total_tokens"].every(key =>
      a[key as TokenField] !== null && a[key as TokenField] === b[key as TokenField]) &&
    sharedCountersAgree(a, b);
}

function sharedCountersAgree(a: RolloutUsage, b: RolloutUsage) {
  return tokenFields.every(key => a[key] === null || b[key] === null || a[key] === b[key]);
}

function withMissing(primary: RolloutUsage, other: RolloutUsage | null) {
  if (!other) return primary;
  const joined = emptyUsage();
  for (const key of tokenFields) joined[key] = primary[key] ?? other[key];
  return consistent(joined) ? rederive(joined) : primary;
}

function difference(current: RolloutUsage, previous: RolloutUsage): RolloutUsage | null {
  const diff = emptyUsage();
  for (const key of tokenFields) {
    if (key === "uncached_input_tokens") continue;
    const start = previous[key], end = current[key];
    if (start === null || end === null) continue;
    if (end < start) return null;
    diff[key] = end - start;
  }
  return consistent(diff) ? rederive(diff) : null;
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
  if (!comparable(a.last, b.last)) return false;
  if (!a.total && !b.total) return a.turn === b.turn;
  // A compatibility record may omit the cumulative snapshot. Within the same
  // known instant, pair it with the native request unless the turns disagree.
  return Boolean(a.total) !== Boolean(b.total) && a.ts !== null && a.ts === b.ts &&
    (!a.turn || !b.turn || a.turn === b.turn);
}

function mergeSample(target: Sample, source: Sample) {
  const preferred = source.native && !target.native ? source : target;
  const alternate = preferred === target ? source : target;
  const total = preferred.total ? withMissing(preferred.total, alternate.total) : alternate.total;
  const last = preferred.last ? withMissing(preferred.last, alternate.last) : alternate.last;
  const model = preferred.model ?? (preferred.turn === alternate.turn ? alternate.model : null);
  Object.assign(target, { ...preferred, id: preferred.id ?? alternate.id, total, last, model });
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
  let baseline: Sample | undefined;
  let pending: RolloutIncrement[] = [];
  for (const sample of samples) {
    let usage = sample.last;
    let from = sample.turnStart;
    let model = sample.model;
    if (sample.total) {
      if (baseline?.total) {
        const diff = difference(sample.total, baseline.total);
        if (!diff) {
          if (sample.last && comparable(sample.total, sample.last)) usage = withMissing(sample.total, sample.last);
          else note("Cumulative token counter reset without recoverable baseline");
        } else if (pending.length) {
          const covered = sumUsage(pending.map(item => item.usage));
          const remaining = difference(diff, covered);
          if (!remaining) {
            // The native span supersedes contradictory last-only records.
            increments.splice(increments.length - pending.length);
            usage = diff;
            model = null;
            from = baseline.ts ?? undefined;
            note("Cumulative usage conflicts with last-only records");
          } else if (comparable(diff, covered)) {
            usage = null;
          } else if (comparable(remaining, sample.last)) {
            usage = withMissing(remaining, sample.last);
          } else {
            usage = remaining;
            model = null;
            from = baseline.ts ?? undefined;
            note("Cumulative usage overlaps last-only records");
          }
        } else {
          const sameRequest = comparable(diff, sample.last);
          usage = sameRequest ? withMissing(diff, sample.last) : diff;
          const changed = !comparable(sample.total, baseline.total);
          if (changed && sample.last && !sameRequest) note("Cumulative and last token counters disagree");
          from = baseline.ts ?? undefined;
          if (sameRequest && sample.turnStart && (!from || sample.turnStart > from)) from = sample.turnStart;
          if (changed && !sameRequest && (sample.model !== baseline.model || sample.modelEpoch !== baseline.modelEpoch)) {
            model = null;
            note("Usage spans models without request breakdown");
          }
        }
      } else {
        const covered = sumUsage(pending.map(item => item.usage));
        if (pending.length && comparable(sample.total, covered)) usage = null;
        else if (!pending.length && sample.fresh && (!sample.last || comparable(sample.total, sample.last)))
          usage = withMissing(sample.total, sample.last);
        else if (!pending.length || !sample.last ||
            !comparable(sample.total, sumUsage([covered, sample.last]))) {
          // Without a baseline, the last batch could mirror an already counted record.
          if (pending.length) usage = null;
          note("Missing cumulative token baseline");
        }
      }
      baseline = sample;
      pending = [];
    }
    if (usage && tokenFields.some(key => usage[key] !== null)) {
      if (!model && tokenFields.some(key => (usage[key] ?? 0) > 0)) note("Actual model is missing for usage");
      const increment = { session_id, role, model, ts: sample.ts, ...(from ? { from_ts: from } : {}), usage };
      increments.push(increment);
      if (!sample.total) pending.push(increment);
    }
  }
  if (!increments.length) note("Token usage is missing");
  return { increments, usage: sumUsage(increments.map(increment => increment.usage)),
    model: [...models], effort: [...efforts] };
}
