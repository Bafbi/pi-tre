import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Node runs this file directly (type stripping), so the extension is `.ts`.
import { WebSearchConfigSchema } from "../src/config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const schema = {
	$schema: "https://json-schema.org/draft/2020-12/schema#",
	...WebSearchConfigSchema,
};

const outPath = join(__dirname, "..", "web-search.schema.json");
writeFileSync(outPath, `${JSON.stringify(schema, null, "\t")}\n`, "utf-8");
console.log(`Wrote schema to ${outPath}`);
