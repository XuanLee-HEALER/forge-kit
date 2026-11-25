import { shipCli } from "../forge-ship";
try {
  const result = shipCli(process.argv.slice(2));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error) }));
  process.exitCode = 1;
}
