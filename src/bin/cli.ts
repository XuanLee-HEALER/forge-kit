import { runForgeCli } from "../cli";
runForgeCli().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
