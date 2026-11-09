import { type Static, Type } from "typebox";

import type { WebSearchDetails } from "./types.js";

/**
 * JSON Schema of the machine-readable tool result.
 *
 * pi hands this shape to codemode scripts instead of the model-facing text, and
 * pi turns a tool without `outputSchema` into a rejected promise for scripts,
 * so every path of `execute` returns one. Keep it in step with
 * `WebSearchStructured`: `buildStructured` is typed by that interface.
 */
export const WebSearchOutputSchema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("ok"),
			Type.Literal("disabled"),
			Type.Literal("unconfigured"),
			Type.Literal("failed"),
		]),
		query: Type.String(),
		/** Console provider id. Always `"opencode"` today. */
		provider: Type.String(),
		endpoint: Type.String(),
		/** USD billed for this call. Zero when nothing was bought. */
		costUsd: Type.Number(),
		error: Type.Union([Type.String(), Type.Null()]),
		results: Type.Array(
			Type.Object(
				{
					url: Type.String(),
					title: Type.Union([Type.String(), Type.Null()]),
					content: Type.Union([Type.String(), Type.Null()]),
					/** Publication time in milliseconds since the Unix epoch. */
					published: Type.Union([Type.Number(), Type.Null()]),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/** The machine-readable result. Derived from the schema so the two cannot drift. */
export type WebSearchStructured = Static<typeof WebSearchOutputSchema>;

/** Map the result details onto the schema. */
export function buildStructured(
	details: WebSearchDetails,
): WebSearchStructured {
	return {
		status: details.status,
		query: details.query,
		provider: details.provider,
		endpoint: details.endpoint,
		costUsd: details.costUsd,
		error: details.error ?? null,
		results: details.results.map((result) => ({
			url: result.url,
			title: result.title ?? null,
			content: result.content ?? null,
			published: result.published ?? null,
		})),
	};
}
