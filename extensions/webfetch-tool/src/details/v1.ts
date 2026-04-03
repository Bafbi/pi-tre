import { z } from "zod";

export const WEBFETCH_DETAILS_VERSION_V1 = 1 as const;

export const webfetchDetailsV1Schema = z
	.object({
		webfetchDetailsVersion: z.literal(WEBFETCH_DETAILS_VERSION_V1),
		url: z.string(),
		statusCode: z.number().int(),
		contentType: z.string(),
		bodyBytes: z.number().int(),
		truncated: z.boolean(),
		redirects: z.array(
			z.object({
				from: z.string(),
				to: z.string(),
				statusCode: z.number().int(),
			}),
		),
		scan: z.object({
			semgrepScore: z.number(),
			fuzzyScore: z.number(),
			contextBoost: z.number(),
			finalScore: z.number(),
			decision: z.enum(["allow", "allow_with_warning", "block"]),
			hits: z.array(
				z.object({
					engine: z.enum(["semgrep", "fuzzy"]),
					ruleId: z.string(),
					weight: z.number(),
					excerpt: z.string(),
					context: z.string(),
					hidden: z.boolean(),
				}),
			),
		}),
		mode: z.enum(["safe_markdown", "raw_markdown", "extract_only"]),
		conversionModelUsed: z.string().optional(),
		conversionPreprocessStrategy: z.string().optional(),
		conversionInputCharsRaw: z.number().int().optional(),
		conversionInputCharsPrepared: z.number().int().optional(),
		usedSubagent: z.boolean(),
		fallbackReason: z.string().optional(),
		markdownTruncated: z.boolean(),
	})
	.strict();

export type WebfetchDetailsV1 = z.infer<typeof webfetchDetailsV1Schema>;

export function validateWebfetchDetailsV1(details: unknown): WebfetchDetailsV1 {
	const validated = webfetchDetailsV1Schema.safeParse(details);
	if (validated.success) return validated.data;
	const issue = validated.error.issues[0];
	const path = issue?.path?.join(".") || "<root>";
	throw new Error(`Invalid webfetch details payload at ${path}: ${issue?.message ?? "validation failed"}`);
}
