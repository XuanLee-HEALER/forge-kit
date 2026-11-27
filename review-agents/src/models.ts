export const modelIds = [
  "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6.1-sol",
  "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
] as const;
export const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type Model = { model: typeof modelIds[number]; effort: typeof efforts[number] };

export function modelPair(model: unknown, effort: unknown): Model {
  if (!modelIds.some(id => id === model)) throw Error("Expected --model from " + modelIds.join(", "));
  if (!efforts.some(level => level === effort)) throw Error("Expected --effort from " + efforts.join(", "));
  return { model, effort } as Model;
}
