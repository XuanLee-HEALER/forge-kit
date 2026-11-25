import { reviewCli } from "../forge-review";
try {
  const report = await reviewCli(process.argv.slice(2));
  console.log(JSON.stringify(report));
  process.exitCode = report.ok ? 0 : 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: String(error) }));
  process.exitCode = 1;
}
