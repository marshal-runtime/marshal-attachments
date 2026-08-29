import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { verifySourceProvenance } from "./provenance.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = await verifySourceProvenance({ repositoryRoot });

if (result.failures.length > 0) {
  console.error(result.failures.join("\n"));
  process.exit(1);
}

for (const item of result.evidence) {
  const source = item.sourceTree ? `, reconstructed-source=${item.sourceTree}` : "";
  console.log(
    `${item.label}: current=${item.currentTree}${source}, `
    + `declared transforms=${item.transformedFiles}`,
  );
}
console.log("Validated reviewed extraction ancestry and canonical implementation provenance.");
