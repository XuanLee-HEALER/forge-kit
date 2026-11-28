export const tokenFields = [
  "input_tokens",
  "cached_input_tokens",
  "uncached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
] as const;

export type TokenField = typeof tokenFields[number];
export type Usage = Record<TokenField, number | null> & { cache_hit_rate: number | null };
export const roles = ["main", "implementer", "reviewer-business", "reviewer-quality", "reviewer-simplify", "reviewer-comments", "analyst", "scanner", "other"] as const;
export type Role = typeof roles[number];
export const stages = ["grill", "impl", "review", "verify", "ship", "unclassified"] as const;
export type Stage = typeof stages[number];

export function sumUsage(items: Usage[], aggregated = false): Usage {
  const usage = Object.fromEntries(tokenFields.map(field => [field, null])) as Usage;
  let cachePairMissing = false;
  for (const item of items) {
    for (const field of tokenFields) {
      if (item[field] !== null) usage[field] = (usage[field] ?? 0) + item[field];
    }
    const input = item.input_tokens;
    const cached = item.cached_input_tokens;
    cachePairMissing ||= (input === null) !== (cached === null) ||
      Boolean(aggregated && input && item.cache_hit_rate === null);
  }
  usage.cache_hit_rate = !cachePairMissing && usage.input_tokens && usage.cached_input_tokens !== null
    ? usage.cached_input_tokens / usage.input_tokens
    : null;
  return usage;
}

export function usageBuckets<Key extends string>(keys: readonly Key[], items: Usage[], keyFor: (index: number) => Key) {
  const groups = new Map<Key, Usage[]>(keys.map(key => [key, []]));
  for (const [index, usage] of items.entries()) groups.get(keyFor(index))!.push(usage);
  return Object.fromEntries([...groups].map(([key, values]) => [key, sumUsage(values)])) as Record<Key, Usage>;
}
