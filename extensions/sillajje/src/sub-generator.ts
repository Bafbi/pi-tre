/**
 * Sub-generator: spawns headless pi to produce subject line and summary.
 *
 * Stub for issue 01 — full implementation in issue 05.
 */

export interface SubGeneratorContext {
	transcript: string;
	diff: string;
	previousDescriptions: string[];
}

export interface SubGeneratorResult {
	subject: string;
	summary: string;
}

export async function generate(
	_ctx: SubGeneratorContext,
): Promise<SubGeneratorResult> {
	return { subject: "chore: agent interaction", summary: "" };
}
