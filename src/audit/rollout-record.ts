export type RolloutObject = Record<string, unknown>;

export function object(value: unknown): RolloutObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RolloutObject : {};
}

export function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function timestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 100_000_000_000 ? value * 1000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export type RolloutRecord = {
  type: string;
  ts: string | null;
  ordinal: number | null;
  payload: RolloutObject;
};

export function turnId(payload: RolloutObject) {
  return string(payload.turn_id) ?? string(object(payload.internal_chat_message_metadata_passthrough).turn_id);
}
