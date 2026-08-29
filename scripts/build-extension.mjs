import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "dist");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [
    path.join(repositoryRoot, "src", "extension.ts"),
  ],
  outfile: path.join(outputDirectory, "extension.cjs"),
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node24",
  packages: "bundle",
  sourcemap: false,
  legalComments: "eof",
});
