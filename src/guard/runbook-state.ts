import { Ledger } from "../ledger/store";
import { type RunbookActions, type RunbookRecord } from "../ledger/types";

export type ApprovedRunbookEntry = { record: RunbookRecord; actions: RunbookActions };

export function loadApprovedRunbooksForSession(
  workbenchRoot: string,
  sessionId?: string | null,
): ApprovedRunbookEntry[] {
  const sid = (sessionId ?? "").trim();
  if (!sid) return [];
  const ledger = new Ledger(workbenchRoot);
  try {
    return ledger.listActiveApprovedRunbooks(sid);
  } catch {
    return [];
  } finally {
    ledger.closeDb();
  }
}
