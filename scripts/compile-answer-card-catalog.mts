import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { CatalogCompiler } from "../services/knowledge-ops-worker/src/catalog-compiler.ts";

const output = argument("--output");
if (!path.isAbsolute(output) || path.extname(output).toLowerCase() !== ".json") {
  throw new Error("absolute_json_output_required");
}
const professional = required("PROFESSIONAL_KB_ROOT");
const general = required("GENERAL_KB_ROOT");
const catalog = await new CatalogCompiler().compile([
  { domain: "coremail-professional", root: professional },
  { domain: "presales-general", root: general },
]);
const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
await writeFile(output, serialized, { encoding: "utf8", flag: "w" });
process.stdout.write(`${JSON.stringify({
  output,
  cards: catalog.cards.length,
  families: catalog.families.length,
  fileHash: createHash("sha256").update(serialized).digest("hex"),
  domains: catalog.domains,
})}\n`);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_required`);
  return value;
}
function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name.slice(2)}_required`);
  return path.resolve(value);
}
