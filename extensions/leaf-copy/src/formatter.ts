import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";

export function formatMessage(
	message: UserMessage | AssistantMessage,
): string | null {
	switch (message.role) {
		case "user": {
			const content = message.content;
			if (typeof content === "string") {
				return content || null;
			}
			const parts = content.map((block) => {
				if (block.type === "text") return block.text;
				if (block.type === "image") return "[image]";
				return "";
			});
			const joined = parts.join("\n~~~\n");
			return joined || null;
		}
		case "assistant": {
			const textParts = message.content
				.filter(
					(block): block is { type: "text"; text: string } =>
						block.type === "text",
				)
				.map((block) => block.text);
			if (textParts.length === 0) return null;
			return textParts.join("\n~~~\n");
		}
	}
}
