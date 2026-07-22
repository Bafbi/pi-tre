import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { handleCopyLeaf } from "./copy-leaf.js";

export default function (pi: ExtensionAPI) {
	pi.registerShortcut("ctrl+shift+c", {
		description: "Copy editor text or last leaf message to clipboard",
		handler: handleCopyLeaf,
	});
}
