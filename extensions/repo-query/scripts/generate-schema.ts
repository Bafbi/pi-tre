import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RepoQueryConfigSchema } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const schema = {
	$schema: "https://json-schema.org/draft/2020-12/schema#",
	...RepoQueryConfigSchema,
};

const outPath = join(__dirname, "..", "repo-query.schema.json");
writeFileSync(outPath, `${JSON.stringify(schema, null, "\t")}\n`, "utf-8");
console.log(`Wrote schema to ${outPath}`);
