import fs from "node:fs/promises";
import type {
	CaptureFpsOption,
	CaptureMaxResolution,
	PerformanceMode,
} from "../../../src/shared/performanceProfile";

function parseJsonWithByteOrderMark<T = unknown>(content: string): T {
	const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
	return JSON.parse(stripped) as T;
}

export interface RecordingPreferencesPatch {
	microphoneEnabled?: boolean;
	microphoneDeviceId?: string;
	systemAudioEnabled?: boolean;
	webcamEnabled?: boolean;
	webcamDeviceId?: string;
	performanceMode?: PerformanceMode;
	captureMaxResolution?: CaptureMaxResolution;
	captureFps?: CaptureFpsOption;
}

export function createRecordingPreferencesStore(filePath: string) {
	let operationQueue: Promise<void> = Promise.resolve();

	const readFile = async (): Promise<Record<string, unknown>> => {
		try {
			const content = await fs.readFile(filePath, "utf-8");
			const parsed = parseJsonWithByteOrderMark<unknown>(content);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	};

	return {
		async read(): Promise<Record<string, unknown>> {
			await operationQueue;
			return readFile();
		},
		async update(patch: RecordingPreferencesPatch): Promise<void> {
			const operation = operationQueue.then(async () => {
				const existing = await readFile();
				await fs.writeFile(
					filePath,
					JSON.stringify({ ...existing, ...patch }, null, 2),
					"utf-8",
				);
			});
			operationQueue = operation.catch(() => undefined);
			await operation;
		},
	};
}
