/**
 * Mock for cloudflare:email built-in module in unit tests.
 */
export class EmailMessage {
	from: string;
	to: string;
	subject: string;
	text: string;
	headers: Record<string, string>;

	constructor(
		from: string,
		to: string,
		message: {
			subject: string;
			text: string;
			headers?: Record<string, string>;
		},
	) {
		this.from = from;
		this.to = to;
		this.subject = message.subject;
		this.text = message.text;
		this.headers = message.headers ?? {};
	}

	async send(): Promise<void> {
		// no-op in tests
	}
}
