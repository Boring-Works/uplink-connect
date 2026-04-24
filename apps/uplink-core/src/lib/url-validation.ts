/**
 * Validates that a source URL is safe to fetch — blocks private IPs,
 * localhost, metadata services, and non-HTTP(S) protocols to prevent SSRF.
 */
export function isAllowedSourceUrl(url: string): boolean {
	try {
		const parsed = new URL(url);

		// Only allow http: and https:
		if (!["http:", "https:"].includes(parsed.protocol)) {
			return false;
		}

		const hostname = parsed.hostname.toLowerCase();

		// Block localhost variants
		if (hostname === "localhost" || hostname.endsWith(".local")) {
			return false;
		}

		// Block private IPv4 ranges
		if (/^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)/.test(hostname)) {
			return false;
		}

		// Block AWS/Cloud metadata service
		if (hostname === "169.254.169.254") {
			return false;
		}

		// Block IPv6 loopback and link-local
		if (hostname === "::1" || hostname.startsWith("fe80:")) {
			return false;
		}

		// Block empty hostname
		if (!hostname || hostname.length === 0) {
			return false;
		}

		return true;
	} catch {
		return false;
	}
}
