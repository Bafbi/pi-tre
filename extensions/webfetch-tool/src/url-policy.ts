import { lookup } from "node:dns/promises";
import net from "node:net";

export function normalizeUrl(input: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new Error(`Invalid URL: ${input}`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Unsupported protocol '${parsed.protocol}'. Only http/https are allowed.`);
	}

	if (parsed.username || parsed.password) {
		throw new Error("Credentials in URL are not allowed.");
	}

	return parsed;
}

function isPrivateIPv4(address: string): boolean {
	const parts = address.split(".").map((value) => Number.parseInt(value, 10));
	if (parts.length !== 4 || parts.some((value) => Number.isNaN(value) || value < 0 || value > 255)) {
		return false;
	}

	const [a, b] = parts;
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 0) return true;
	if (a === 169 && b === 254) return true;
	if (a === 192 && b === 168) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	return false;
}

function isPrivateIPv6(address: string): boolean {
	const normalized = address.toLowerCase();
	if (normalized === "::1") return true;
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
	if (
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	) {
		return true;
	}
	if (normalized.startsWith("::ffff:")) {
		const mapped = normalized.slice("::ffff:".length);
		if (net.isIPv4(mapped)) return isPrivateIPv4(mapped);
	}
	return false;
}

function isPrivateAddress(address: string): boolean {
	const ipVersion = net.isIP(address);
	if (ipVersion === 4) return isPrivateIPv4(address);
	if (ipVersion === 6) return isPrivateIPv6(address);
	return false;
}

export async function enforceUrlPolicy(url: URL, allowPrivateHosts: boolean): Promise<void> {
	const hostname = url.hostname.toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error("Blocked URL: localhost is not allowed.");
	}

	if (allowPrivateHosts) return;

	if (isPrivateAddress(hostname)) {
		throw new Error(`Blocked URL: private IP host '${hostname}' is not allowed.`);
	}

	try {
		const addresses = await lookup(hostname, { all: true, verbatim: true });
		for (const entry of addresses) {
			if (isPrivateAddress(entry.address)) {
				throw new Error(`Blocked URL: '${hostname}' resolves to private address '${entry.address}'.`);
			}
		}
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Blocked URL:")) {
			throw error;
		}
	}
}
