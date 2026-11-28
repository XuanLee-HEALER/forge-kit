export function lifecycleSession(explicit?: string): string | undefined {
  for (const value of [explicit, process.env.CODEX_THREAD_ID, process.env.FORGE_SESSION_ID]) {
    const id = value?.trim();
    if (id && !/[\x00-\x1f\x7f]/.test(id)) return id;
  }
}
