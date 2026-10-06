/**
 * The daily driver's Unity side (E7-PLAN step 6): the export `e2e/dailyDriver.spec.ts` kept (the
 * figure PSD rigged and animated over MCP, a key by hand, Export to Unity) read and posed by
 * BoneBurst's C# reader and runtime, every bone at every frame against v2's engine
 * (`scripts/oracle/csharp.ts`). The asset bake itself needs the Unity Editor and is not run here.
 *
 * Run: npx playwright test e2e/dailyDriver.spec.ts && npx vite-node scripts/daily-driver.ts
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { compareWithCsharp } from "./oracle/csharp";
import { ROOT } from "./oracle/editors";

const OUT = join(ROOT, "node_modules", ".cache", "daily-driver");

function main(): void {
  const files = existsSync(OUT) ? readdirSync(OUT) : [];
  const json = files.find((f) => f.endsWith(".json")), atlas = files.find((f) => /\.atlas(\.txt)?$/.test(f));
  if (!json || !atlas) throw new Error(`No export in ${OUT}: run npx playwright test e2e/dailyDriver.spec.ts first.`);
  const { compared, failed } = compareWithCsharp([{ name: json.replace(/\.json$/, ""), json: join(OUT, json), atlas: join(OUT, atlas) }]);
  if (compared !== 1) throw new Error("The C# runtime did not pose the export: a run that compares nothing is a failure.");
  if (failed) { console.log("The C# runtime poses the export differently."); process.exitCode = 1; }
  else console.log("The C# runtime reads the export and poses it as v2 does.");
}

main();
