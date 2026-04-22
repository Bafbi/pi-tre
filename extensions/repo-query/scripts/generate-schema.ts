import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { RepoQueryConfigSchema } from "../src/config.js";

const schema = {
	$schema: "http://json-schema.org/draft-07/schema#",
	...RepoQueryConfigSchema,
};

const outPath = join(import.meta.dir, "..", "repo-query.schema.json");
writeFileSync(outPath, `${JSON.stringify(schema, null, "\t")}\n`, "utf-8");
console.log(`Wrote schema to ${outPath}`);
