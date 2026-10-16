import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(root, "../src/runner-cli.ts")],
  outfile: join(root, "../dist/rakazo-lb-browser.cjs"),
  platform: "node",
  format: "cjs",
  target: "node22",
  bundle: true,
  external: ["playwright", "playwright-core"],
});
