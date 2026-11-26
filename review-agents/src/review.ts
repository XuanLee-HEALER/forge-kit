import { reviewExitCode, standalone } from "./engine";

if (process.argv.includes("--help")) {
  console.log("review-agents --repo <path> --base <commit> --head <commit> [--spec <path>] [--roles business,quality,simplify,comments] [--mode parallel|serial|ordered] [--order <roles>] [--backend auto|codex|api] [--model <id>] [--effort <level>]");
} else {
  try {
    const result = await standalone(process.argv.slice(2));
    console.log(JSON.stringify(result));
    process.exitCode = reviewExitCode(result.status);
  } catch (err) {
    console.error(String(err));
    process.exitCode = 2;
  }
}
