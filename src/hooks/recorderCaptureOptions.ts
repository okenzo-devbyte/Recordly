import { type PerformanceBudget, resolvePerformanceBudget } from "@/shared/performanceProfile";

export const TARGET_FRAME_RATE = 60;
export const TARGET_WIDTH = 3840;
export const TARGET_HEIGHT = 2160;
export const FOUR_K_PIXELS = TARGET_WIDTH * TARGET_HEIGHT;
export const QHD_WIDTH = 2560;
export const QHD_HEIGHT = 1440;
export const QHD_PIXELS = QHD_WIDTH * QHD_HEIGHT;
export const BITRATE_4K = 45_000_000;
export const BITRATE_QHD = 28_000_000;
export const BITRATE_BASE = 18_000_000;
export const HIGH_FRAME_RATE_THRESHOLD = 60;
export const HIGH_FRAME_RATE_BOOST = 1.7;
export const DEFAULT_WIDTH = 1920;
export const DEFAULT_HEIGHT = 1080;
export const CODEC_ALIGNMENT = 2;
export const RECORDER_TIMESLICE_MS = 1000;
export const BITS_PER_MEGABIT = 1_000_000;
export const MIN_FRAME_RATE = 30;
export const CHROME_MEDIA_SOURCE = "desktop";
export const RECORDING_FILE_PREFIX = "recording-";
export const AUDIO_BITRATE_VOICE = 128_000;
export const AUDIO_BITRATE_SYSTEM = 192_000;
export const MIC_GAIN_BOOST = 1.4;
type BrowserCaptureCursorMode = "always" | "never";
export type BrowserCaptureCursorPolicy = {
	streamCursor: BrowserCaptureCursorMode;
	hideOsCursorBeforeRecording: boolean;
	hideEditorOverlayCursorByDefault: boolean;
};

export function getCaptureBudget(budget?: PerformanceBudget) {
	const resolved = budget ?? resolvePerformanceBudget();
	return {
		maxWidth: resolved.recording.maxWidth,
		maxHeight: resolved.recording.maxHeight,
		fps: resolved.recording.fps,
		minFrameRate: Math.min(MIN_FRAME_RATE, resolved.recording.fps),
		bitrateMultiplier: resolved.recording.bitrateMultiplier,
		minTargetBitrateBps: resolved.recording.minTargetBitrateBps,
		maxTargetBitrateBps: resolved.recording.maxTargetBitrateBps,
		timesliceMs: resolved.recording.timesliceMs,
	};
}

export function resolveBrowserCaptureCursorPolicy({
	nativeWindowsCaptureStartFailed = false,
}: {
	nativeWindowsCaptureStartFailed?: boolean;
} = {}): BrowserCaptureCursorPolicy {
	if (nativeWindowsCaptureStartFailed) {
		// If WGC already failed, avoid the telemetry overlay path that can lag on
		// constrained Windows systems; keep the browser-captured cursor instead.
		return {
			streamCursor: "always",
			hideOsCursorBeforeRecording: false,
			hideEditorOverlayCursorByDefault: true,
		};
	}

	return {
		streamCursor: "never",
		hideOsCursorBeforeRecording: true,
		hideEditorOverlayCursorByDefault: true,
	};
}

export function shouldUseNativeWindowsCaptureForSource(
	source: Pick<ProcessedDesktopSource, "id"> | null | undefined,
): boolean {
	return source?.id?.startsWith("screen:") === true || source?.id?.startsWith("window:") === true;
}

export function createBrowserRecordingOptions({
	audioBitsPerSecond,
	mimeType,
	videoBitsPerSecond,
}: {
	audioBitsPerSecond?: number;
	mimeType?: string;
	videoBitsPerSecond: number;
}): MediaRecorderOptions {
	const options: MediaRecorderOptions = {
		videoBitsPerSecond,
		bitsPerSecond: videoBitsPerSecond + (audioBitsPerSecond ?? 0),
	};

	if (audioBitsPerSecond !== undefined) {
		options.audioBitsPerSecond = audioBitsPerSecond;
	}

	if (mimeType) {
		options.mimeType = mimeType;
	}

	return options;
}
export const computeBitrate = (width: number, height: number, budget?: PerformanceBudget) => {
	const pixels = width * height;
	const captureBudget = getCaptureBudget(budget);
	const rawBitrate =
		pixels >= FOUR_K_PIXELS ? BITRATE_4K : pixels >= QHD_PIXELS ? BITRATE_QHD : BITRATE_BASE;
	const scaled = Math.round(rawBitrate * captureBudget.bitrateMultiplier);
	return Math.min(
		captureBudget.maxTargetBitrateBps,
		Math.max(captureBudget.minTargetBitrateBps, scaled),
	);
};
