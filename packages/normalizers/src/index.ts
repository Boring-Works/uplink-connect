import { type IngestEnvelope } from "@uplink/contracts";

export type NormalizedEntity = {
	entityId: string;
	sourceId: string;
	sourceType: string;
	externalId?: string;
	contentHash: string;
	observedAt: string;
	canonicalJson: string;
};

export type CodeChunkType =
	| "function"
	| "class"
	| "interface"
	| "type"
	| "import"
	| "export"
	| "comment"
	| "other";

export type CodeChunk = {
	id: string;
	filePath: string;
	lineStart: number;
	lineEnd: number;
	content: string;
	chunkType: CodeChunkType;
};

export interface ChunkOptions {
	maxChunkSize?: number;
	minChunkSize?: number;
}

export function normalizeEnvelope(envelope: IngestEnvelope): NormalizedEntity[] {
	return envelope.records.map((record, index) => {
		const externalId = record.externalId;
		const observedAt = record.observedAt ?? envelope.collectedAt;
		const canonical = toCanonical(record.rawPayload);
		const canonicalJson = JSON.stringify(canonical);

		return {
			entityId: buildEntityId(envelope.sourceId, externalId, record.contentHash, index),
			sourceId: envelope.sourceId,
			sourceType: envelope.sourceType,
			externalId,
			contentHash: record.contentHash,
			observedAt,
			canonicalJson,
		};
	});
}

export function chunkCode(
	content: string,
	filePath: string,
	options: ChunkOptions = {}
): CodeChunk[] {
	const { maxChunkSize = 1000, minChunkSize = 20 } = options;
	const chunks: CodeChunk[] = [];
	const lines = content.split("\n");

	const isTypeScript = filePath.endsWith(".ts") || filePath.endsWith(".tsx");
	const isJavaScript = filePath.endsWith(".js") || filePath.endsWith(".jsx");

	if (!isTypeScript && !isJavaScript) {
		return chunkByLines(content, filePath, lines, maxChunkSize, minChunkSize);
	}

	let currentChunk: string[] = [];
	let currentStart = 0;
	let braceDepth = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		braceDepth += (line.match(/{/g) ?? []).length;
		braceDepth -= (line.match(/}/g) ?? []).length;

		const isBoundary =
			isFunctionStart(trimmed) ||
			isClassStart(trimmed) ||
			isInterfaceStart(trimmed) ||
			isTypeStart(trimmed) ||
			isExportBlock(trimmed);

		if (isBoundary && currentChunk.length > 0) {
			const currentChunkText = currentChunk.join("\n");
			if (currentChunkText.length >= minChunkSize) {
				chunks.push(
					createChunk(filePath, currentChunk, currentStart, detectChunkType(currentChunk))
				);
			}
			currentChunk = [];
			currentStart = i;
		}

		currentChunk.push(line);

		const currentChunkText = currentChunk.join("\n");
		if (currentChunkText.length >= maxChunkSize) {
			chunks.push(createChunk(filePath, currentChunk, currentStart, detectChunkType(currentChunk)));
			currentChunk = [];
			currentStart = i + 1;
		}
	}

	if (currentChunk.length > 0) {
		const text = currentChunk.join("\n");
		if (text.length >= minChunkSize) {
			chunks.push(createChunk(filePath, currentChunk, currentStart, detectChunkType(currentChunk)));
		}
	}

	return chunks;
}

function chunkByLines(
	_content: string,
	filePath: string,
	lines: string[],
	maxChunkSize: number,
	minChunkSize: number
): CodeChunk[] {
	const chunks: CodeChunk[] = [];
	let currentChunk: string[] = [];
	let currentStart = 0;

	for (let i = 0; i < lines.length; i++) {
		currentChunk.push(lines[i]);

		const currentText = currentChunk.join("\n");

		if (currentText.length >= maxChunkSize) {
			if (currentText.length >= minChunkSize) {
				chunks.push(createChunk(filePath, currentChunk, currentStart, "other"));
			}
			currentChunk = [];
			currentStart = i + 1;
		}
	}

	if (currentChunk.length > 0) {
		const text = currentChunk.join("\n");
		if (text.length >= minChunkSize) {
			chunks.push(createChunk(filePath, currentChunk, currentStart, "other"));
		}
	}

	return chunks;
}

function createChunk(
	filePath: string,
	lines: string[],
	startLine: number,
	chunkType: CodeChunkType
): CodeChunk {
	const content = lines.join("\n");
	return {
		id: `${filePath}-${startLine}`,
		filePath,
		lineStart: startLine + 1,
		lineEnd: startLine + lines.length,
		content,
		chunkType,
	};
}

function detectChunkType(lines: string[]): CodeChunkType {
	const firstLine = lines[0]?.trim() ?? "";

	if (isFunctionStart(firstLine)) return "function";
	if (isClassStart(firstLine)) return "class";
	if (isInterfaceStart(firstLine)) return "interface";
	if (isTypeStart(firstLine)) return "type";
	if (isImportBlock(lines)) return "import";
	if (isExportBlock(firstLine)) return "export";
	if (isCommentBlock(lines)) return "comment";

	return "other";
}

function isFunctionStart(line: string): boolean {
	if (/^\s*constructor\s*\(/.test(line)) return false;

	return (
		/^\s*(export\s+)?\s*(async\s+)?function\s+\w+/.test(line) ||
		/^\s*(export\s+)?\s*const\s+\w+\s*=\s*(async\s+)?\(/.test(line) ||
		/^\s*(export\s+)?\s*const\s+\w+\s*=\s+async\s/.test(line) ||
		/^\s*(export\s+)?\s*const\s+\w+\s*=\s*\(/.test(line)
	);
}

function isClassStart(line: string): boolean {
	return /^\s*(export\s+)?\s*class\s+\w+/.test(line);
}

function isInterfaceStart(line: string): boolean {
	return /^\s*(export\s+)?\s*interface\s+\w+/.test(line);
}

function isTypeStart(line: string): boolean {
	return /^\s*(export\s+)?\s*type\s+\w+/.test(line);
}

function isImportBlock(lines: string[]): boolean {
	return lines.every(
		(line) => /^\s*import\s/.test(line) || line.trim() === "" || line.trim().startsWith("//")
	);
}

function isExportBlock(line: string): boolean {
	if (/^\s*export\s*\{/.test(line)) return true;
	if (/^\s*export\s+\*/.test(line)) return true;
	return (
		/^\s*export\s/.test(line) &&
		!line.includes("function") &&
		!line.includes("class") &&
		!line.includes("const") &&
		!line.includes("type") &&
		!line.includes("interface") &&
		!line.includes("default")
	);
}

function isCommentBlock(lines: string[]): boolean {
	return lines.every(
		(line) =>
			/^\s*\/\//.test(line) ||
			/^\s*\/\*/.test(line) ||
			/^\s*\*/.test(line) ||
			/^\s*\*\//.test(line) ||
			line.trim() === ""
	);
}

function toCanonical(payload: unknown): Record<string, unknown> {
	if (!payload || typeof payload !== "object") {
		return { value: payload };
	}

	if (Array.isArray(payload)) {
		return { items: payload };
	}

	return payload as Record<string, unknown>;
}

function buildEntityId(
	sourceId: string,
	externalId: string | undefined,
	contentHash: string,
	index: number,
): string {
	if (externalId) {
		return `${sourceId}:ext:${externalId}`;
	}

	return `${sourceId}:hash:${contentHash}:${index}`;
}
