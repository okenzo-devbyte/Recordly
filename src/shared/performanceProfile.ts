export type PerformanceMode = "auto" | "low" | "balanced" | "high";
export type ResolvedPerformanceTier = "low" | "balanced" | "high";
export type CaptureMaxResolution = "auto" | "1080p" | "native";
export type CaptureFpsOption = "auto" | 30 | 60;

export interface SystemHardwareProfile {
	platform: string;
	logicalProcessors: number;
	totalMemoryGb: number;
	hasHardwareEncoder: boolean;
	recommendedTier: ResolvedPerformanceTier;
	gpuNames?: string[];
}

export interface PerformancePreferences {
	performanceMode: PerformanceMode;
	captureMaxResolution: CaptureMaxResolution;
	captureFps: CaptureFpsOption;
}

export interface PerformanceBudget {
	preferences: PerformancePreferences;
	hardware: SystemHardwareProfile | null;
	tier: ResolvedPerformanceTier;
	recording: {
		maxWidth: number;
		maxHeight: number;
		fps: 30 | 60;
		bitrateMultiplier: number;
		minTargetBitrateBps: number;
		maxTargetBitrateBps: number;
		webcamWidth: number;
		webcamHeight: number;
		webcamFps: 30 | 60;
		webcamBitrate: number;
		timesliceMs: number;
	};
	preview: {
		maxDpr: number;
		antialias: boolean;
		allowCssDropShadow: boolean;
		allowDomBlur: boolean;
		allowHoverVideoPreview: boolean;
		filmstripMaxFrames: number;
		filmstripIntervalFactor: number;
	};
	export: {
		whisperMaxThreads: number;
		libx264MaxThreads: number;
		preferFastSoftwarePreset: boolean;
		allowLowMemoryProfile: boolean;
	};
}

export const DEFAULT_PERFORMANCE_PREFERENCES: PerformancePreferences = {
	performanceMode: "auto",
	captureMaxResolution: "auto",
	captureFps: "auto",
};

export function normalizePerformanceMode(value: unknown): PerformanceMode {
	if (value === "low" || value === "balanced" || value === "high" || value === "auto") {
		return value;
	}
	return "auto";
}

export function normalizeCaptureMaxResolution(value: unknown): CaptureMaxResolution {
	if (value === "1080p" || value === "native" || value === "auto") {
		return value;
	}
	return "auto";
}

export function normalizeCaptureFps(value: unknown): CaptureFpsOption {
	if (value === 30 || value === 60 || value === "auto") {
		return value;
	}
	return "auto";
}

export function normalizePerformancePreferences(
	input: Partial<PerformancePreferences> | Record<string, unknown> | null | undefined,
): PerformancePreferences {
	const source = (input ?? null) as Record<string, unknown> | null;
	return {
		performanceMode: normalizePerformanceMode(source?.performanceMode),
		captureMaxResolution: normalizeCaptureMaxResolution(source?.captureMaxResolution),
		captureFps: normalizeCaptureFps(source?.captureFps),
	};
}

export function classifyHardwareTier(input: {
	logicalProcessors: number;
	totalMemoryGb: number;
	hasHardwareEncoder: boolean;
}): ResolvedPerformanceTier {
	const { logicalProcessors, totalMemoryGb, hasHardwareEncoder } = input;
	if (
		(totalMemoryGb > 0 && totalMemoryGb <= 8) ||
		(logicalProcessors > 0 && logicalProcessors <= 6) ||
		!hasHardwareEncoder
	) {
		return "low";
	}
	if (totalMemoryGb <= 16 || logicalProcessors <= 8) {
		return "balanced";
	}
	return "high";
}

export function resolvePerformanceTier(
	mode: PerformanceMode,
	hardware: SystemHardwareProfile | null,
): ResolvedPerformanceTier {
	if (mode !== "auto") {
		return mode;
	}
	return hardware?.recommendedTier ?? "balanced";
}

export function computeRecommendedThreadCount(
	logicalProcessors: number | undefined,
	ratio: number,
	reserveCores = 2,
	minimum = 2,
): number {
	const cores =
		typeof logicalProcessors === "number" && Number.isFinite(logicalProcessors) && logicalProcessors > 0
			? Math.round(logicalProcessors)
			: 4;
	const byRatio = Math.floor(cores * ratio);
	const byReserve = cores > reserveCores ? cores - reserveCores : minimum;
	return Math.max(minimum, Math.min(byReserve, Math.max(minimum, byRatio)));
}

export function resolvePerformanceBudget(
	preferencesInput?: Partial<PerformancePreferences> | null,
	hardware: SystemHardwareProfile | null = null,
): PerformanceBudget {
	const preferences: PerformancePreferences = {
		performanceMode: normalizePerformanceMode(preferencesInput?.performanceMode),
		captureMaxResolution: normalizeCaptureMaxResolution(preferencesInput?.captureMaxResolution),
		captureFps: normalizeCaptureFps(preferencesInput?.captureFps),
	};
	const tier = resolvePerformanceTier(preferences.performanceMode, hardware);
	const cores = hardware?.logicalProcessors ?? (tier === "low" ? 4 : tier === "balanced" ? 8 : 12);

	const defaultResolution = tier === "high" ? "native" : "1080p";
	const effectiveResolution =
		preferences.captureMaxResolution === "auto"
			? defaultResolution
			: preferences.captureMaxResolution;

	const maxWidth = effectiveResolution === "native" ? 3840 : 1920;
	const maxHeight = effectiveResolution === "native" ? 2160 : 1080;

	const defaultFps: 30 | 60 = tier === "low" ? 30 : 60;
	const fps: 30 | 60 = preferences.captureFps === "auto" ? defaultFps : preferences.captureFps;

	if (tier === "low") {
		const is60FpsOverride = fps === 60;
		const isNativeOverride = effectiveResolution === "native";
		return {
			preferences,
			hardware,
			tier,
			recording: {
				maxWidth,
				maxHeight,
				fps,
				bitrateMultiplier: is60FpsOverride ? 0.78 : 0.55,
				minTargetBitrateBps: 5_000_000,
				maxTargetBitrateBps: isNativeOverride
					? is60FpsOverride
						? 24_000_000
						: 16_000_000
					: is60FpsOverride
						? 14_000_000
						: 10_000_000,
				webcamWidth: 854,
				webcamHeight: 480,
				webcamFps: 30,
				webcamBitrate: 2_500_000,
				timesliceMs: 1000,
			},
			preview: {
				maxDpr: 1,
				antialias: false,
				allowCssDropShadow: false,
				allowDomBlur: false,
				allowHoverVideoPreview: false,
				filmstripMaxFrames: 64,
				filmstripIntervalFactor: 2,
			},
			export: {
				whisperMaxThreads: computeRecommendedThreadCount(cores, 0.55, 1, 2),
				libx264MaxThreads: Math.max(2, Math.min(4, cores > 2 ? cores - 2 : 2)),
				preferFastSoftwarePreset: true,
				allowLowMemoryProfile: true,
			},
		};
	}

	if (tier === "balanced") {
		const isNativeOverride = effectiveResolution === "native";
		return {
			preferences,
			hardware,
			tier,
			recording: {
				maxWidth,
				maxHeight,
				fps,
				bitrateMultiplier: fps === 60 ? 0.88 : 0.72,
				minTargetBitrateBps: 8_000_000,
				maxTargetBitrateBps: isNativeOverride
					? fps === 60
						? 32_000_000
						: 22_000_000
					: fps === 60
						? 16_000_000
						: 12_000_000,
				webcamWidth: 1280,
				webcamHeight: 720,
				webcamFps: 30,
				webcamBitrate: 3_500_000,
				timesliceMs: 1000,
			},
			preview: {
				maxDpr: 1.5,
				antialias: true,
				allowCssDropShadow: false,
				allowDomBlur: false,
				allowHoverVideoPreview: true,
				filmstripMaxFrames: 128,
				filmstripIntervalFactor: 1,
			},
			export: {
				whisperMaxThreads: computeRecommendedThreadCount(cores, 0.6, 2, 2),
				libx264MaxThreads: computeRecommendedThreadCount(cores, 0.75, 2, 2),
				preferFastSoftwarePreset: true,
				allowLowMemoryProfile: true,
			},
		};
	}

	return {
		preferences,
		hardware,
		tier: "high",
		recording: {
			maxWidth,
			maxHeight,
			fps,
			bitrateMultiplier: fps === 60 ? 1.7 : 1,
			minTargetBitrateBps: 12_000_000,
			maxTargetBitrateBps: 76_500_000,
			webcamWidth: 1280,
			webcamHeight: 720,
			webcamFps: fps,
			webcamBitrate: fps === 60 ? 6_000_000 : 4_000_000,
			timesliceMs: 1000,
		},
		preview: {
			maxDpr: 3,
			antialias: true,
			allowCssDropShadow: true,
			allowDomBlur: true,
			allowHoverVideoPreview: true,
			filmstripMaxFrames: 256,
			filmstripIntervalFactor: 1,
		},
		export: {
			whisperMaxThreads: computeRecommendedThreadCount(cores, 0.75, 2, 2),
			libx264MaxThreads: computeRecommendedThreadCount(cores, 0.85, 2, 4),
			preferFastSoftwarePreset: false,
			allowLowMemoryProfile: true,
		},
	};
}
