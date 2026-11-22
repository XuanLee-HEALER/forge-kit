import { runLedgerCli } from "../ledger";
runLedgerCli().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
