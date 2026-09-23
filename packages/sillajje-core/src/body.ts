/**
 * The body seam.
 *
 * A commit description is a subject line plus an ordered list of named
 * sections. Each action declares the sections it contributes; the assembler
 * renders them and omits the empty ones. The Commit body is the sections;
 * the description is the subject plus the body.
 */

export interface Section {
	/** Section identity. Rendered as `<label>:` when the body is non-empty. */
	label: string;
	/** The section's text. An empty body omits the section. */
	body: string;
	/**
	 * Render the body on the label line (`<label>: <body>`) instead of the
	 * next line (`<label>:\n<body>`). The metadata and loop sections use this.
	 */
	inline?: boolean;
}

/**
 * Assemble a commit description: the subject, a blank line, then every
 * non-empty section in order, separated by blank lines.
 */
export function assembleDescription(
	subject: string,
	sections: Section[],
): string {
	const parts: string[] = [subject, ""];

	for (const section of sections) {
		if (section.body.length === 0) continue;
		if (section.inline) {
			parts.push(`${section.label}: ${section.body}`, "");
		} else {
			parts.push(`${section.label}:`, section.body, "");
		}
	}

	// Drop the trailing blank line from the last section.
	while (parts.length > 0 && parts[parts.length - 1] === "") {
		parts.pop();
	}

	return parts.join("\n");
}
