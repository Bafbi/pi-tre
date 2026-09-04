import { describe, expect, it } from "vitest";

import {
	diskMatchesInjected,
	extractInjectedContent,
	type InjectedContent,
} from "../../src/injected";

const SKILL_PATH = "/tmp/skills/my-skill/SKILL.md";

/** Mirrors pi's _expandSkillCommand output format. */
function skillBlock(body: string, location = SKILL_PATH, name = "my-skill") {
	return `<skill name="${name}" location="${location}">\nReferences are relative to /tmp/skills/my-skill.\n\n${body}\n</skill>`;
}

function skillFileContent(
	body: string,
	frontmatter = "---\nname: my-skill\ndescription: y\n---\n",
) {
	return `${frontmatter}${body}\n`;
}

describe("extractInjectedContent", () => {
	it("extracts a skill block from an expanded /skill:name prompt", () => {
		const body = "# My Skill\n\nDo the thing.";
		const prompt = `${skillBlock(body)}\n\nUser: extra args`;

		expect(extractInjectedContent(prompt, [])).toEqual([
			{ kind: "skill", path: SKILL_PATH, content: body },
		]);
	});

	it("extracts multiple skill blocks", () => {
		const prompt = `${skillBlock("one", "/tmp/skills/a/SKILL.md", "a")}\n${skillBlock("two", "/tmp/skills/b/SKILL.md", "b")}`;

		const result = extractInjectedContent(prompt, []);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({
			kind: "skill",
			path: "/tmp/skills/a/SKILL.md",
			content: "one",
		});
		expect(result[1]).toEqual({
			kind: "skill",
			path: "/tmp/skills/b/SKILL.md",
			content: "two",
		});
	});

	it("returns nothing when the prompt has no skill block", () => {
		expect(extractInjectedContent("plain prompt", [])).toEqual([]);
	});

	it("returns nothing for an unterminated skill block", () => {
		const prompt = `<skill name="my-skill" location="${SKILL_PATH}">\nno closing tag`;
		expect(extractInjectedContent(prompt, [])).toEqual([]);
	});

	it("passes context files through as context injections", () => {
		const contextFiles = [
			{ path: "/repo/AGENTS.md", content: "# Agents\n\nrules" },
		];

		expect(extractInjectedContent("prompt", contextFiles)).toEqual([
			{
				kind: "context",
				path: "/repo/AGENTS.md",
				content: "# Agents\n\nrules",
			},
		]);
	});

	it("combines skill blocks and context files", () => {
		const prompt = `${skillBlock("body")}\nmore`;
		const contextFiles = [{ path: "/repo/AGENTS.md", content: "rules" }];

		const result = extractInjectedContent(prompt, contextFiles);
		expect(result).toHaveLength(2);
	});
});

describe("diskMatchesInjected", () => {
	it("matches a skill file whose frontmatter-stripped body equals the injected body", () => {
		const body = "# My Skill\n\nDo the thing.";
		const injection: InjectedContent = {
			kind: "skill",
			path: SKILL_PATH,
			content: body,
		};

		expect(diskMatchesInjected(injection, skillFileContent(body))).toBe(
			true,
		);
	});

	it("does not match a skill file whose body changed", () => {
		const injection: InjectedContent = {
			kind: "skill",
			path: SKILL_PATH,
			content: "old body",
		};

		expect(
			diskMatchesInjected(injection, skillFileContent("new body")),
		).toBe(false);
	});

	it("matches a skill file without frontmatter", () => {
		const body = "plain body";
		const injection: InjectedContent = {
			kind: "skill",
			path: SKILL_PATH,
			content: body,
		};

		expect(diskMatchesInjected(injection, `${body}\n`)).toBe(true);
	});

	it("matches a context file byte for byte", () => {
		const injection: InjectedContent = {
			kind: "context",
			path: "/repo/AGENTS.md",
			content: "# Agents\n\nrules",
		};

		expect(diskMatchesInjected(injection, "# Agents\n\nrules")).toBe(true);
	});

	it("matches a context file that differs only by a byte-order mark", () => {
		const injection: InjectedContent = {
			kind: "context",
			path: "/repo/AGENTS.md",
			content: "# Agents",
		};

		expect(diskMatchesInjected(injection, "\uFEFF# Agents")).toBe(true);
	});

	it("does not match a context file whose content changed since load", () => {
		const injection: InjectedContent = {
			kind: "context",
			path: "/repo/AGENTS.md",
			content: "stale content",
		};

		expect(diskMatchesInjected(injection, "changed content")).toBe(false);
	});
});
