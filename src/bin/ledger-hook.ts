import { runLedgerHookCli } from "../ledger-hook";

runLedgerHookCli().catch(() => process.exit(0));
