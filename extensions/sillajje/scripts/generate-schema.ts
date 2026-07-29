import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SillajjeConfigSchema } from "../src/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const schema = {
	$schema: "https://json-schema.org/draft/2020-12/schema#",
	...SillajjeConfigSchema,
};

const outPath = join(__dirname, "..", "sillajje-config.schema.json");
writeFileSync(outPath, `${JSON.stringify(schema, null, "\t")}\n`, "utf-8");
console.log(`Wrote schema to ${outPath}`);
