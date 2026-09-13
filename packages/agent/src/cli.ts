/**
 * Run one agent from a ContextBundle JSON file. For local iteration on
 * prompts and tools without the control-plane:
 *
 *   ANTHROPIC_API_KEY=... pnpm --filter @qa-agent/agent run -- --bundle ./bundle.json --out ./result.json
 *
 * Flags: --bundle <file> (required), --out <file> (default stdout),
 *        --headed (show the browser), --video (record a .webm),
 *        --max-steps <n>, --budget <seconds> (override bundle).
 */
import { readFile, writeFile } from "node:fs/promises";
import type { ContextBundle } from "@qa-agent/shared-types";
import { runAgent } from "./index";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const bundlePath = arg("bundle");
  if (!bundlePath) {
    console.error("usage: run --bundle <bundle.json> [--out result.json] [--headed] [--video] [--max-steps n] [--budget seconds]");
    process.exit(2);
  }
  const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as ContextBundle;
  const budget = arg("budget");
  if (budget) bundle.budgetSeconds = Number(budget);
  const maxSteps = arg("max-steps");

  const result = await runAgent(bundle, {
    headless: !process.argv.includes("--headed"),
    recordVideo: process.argv.includes("--video") || undefined,
    maxSteps: maxSteps ? Number(maxSteps) : undefined,
    onStep: (step) => console.error(`  ${step.index}. ${step.description} [${step.outcome}, ${step.durationMs}ms]`),
  });

  console.error(`\n${result.findings.length} finding(s): ${result.findings.map((f) => `[${f.severity}] ${f.title}`).join("; ") || "none"}`);
  if (result.videoPath) console.error(`video: ${result.videoPath}  (open with: open "${result.videoPath}")`);

  const out = arg("out");
  const json = JSON.stringify(result, null, 2);
  if (out) {
    await writeFile(out, json);
    console.error(`wrote ${out}`);
  } else {
    console.log(json);
  }
  process.exit(result.status === "completed" ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
