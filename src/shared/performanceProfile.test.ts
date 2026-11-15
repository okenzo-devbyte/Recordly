import { describe, expect, it } from "vitest";
import {
	classifyHardwareTier,
	computeRecommendedThreadCount,
	normalizePerformancePreferences,
	resolvePerformanceBudget,
} from "./performanceProfile";

describe("performanceProfile", () => {
	it("classifies 4-8 core and 4-8 GB RAM systems as low-spec automatically", () => {
		expect(
			classifyHardwareTier({
				logicalProcessors: 8,
				totalMemoryGb: 8,
				hasHardwareEncoder: true,
			}),
		).toBe("low");
		expect(
			classifyHardwareTier({
				logicalProcessors: 4,
				totalMemoryGb: 16,
				hasHardwareEncoder: true,
			}),
		).toBe("low");
		expect(
			classifyHardwareTier({
				logicalProcessors: 12,
				totalMemoryGb: 32,
				hasHardwareEncoder: false,
			}),
		).toBe("low");
	});

	it("classifies mid-tier 8-core 16GB systems with hardware encoding as balanced", () => {
		expect(
			classifyHardwareTier({
				logicalProcessors: 8,
				totalMemoryGb: 16,
				hasHardwareEncoder: true,
			}),
		).toBe("balanced");
	});

	it("classifies workstation specs with hardware encoding as high", () => {
		expect(
			classifyHardwareTier({
				logicalProcessors: 16,
				totalMemoryGb: 32,
				hasHardwareEncoder: true,
			}),
		).toBe("high");
	});

	it("builds safe low-spec recording, preview, and export budgets on auto mode", () => {
		const budget = resolvePerformanceBudget(
			{ performanceMode: "auto", captureMaxResolution: "auto", captureFps: "auto" },
			{
				platform: "win32",
				logicalProcessors: 4,
				totalMemoryGb: 8,
				hasHardwareEncoder: false,
				recommendedTier: "low",
			},
		);
		expect(budget.tier).toBe("low");
		expect(budget.recording.maxWidth).toBe(1920);
		expect(budget.recording.maxHeight).toBe(1080);
		expect(budget.recording.fps).toBe(30);
		expect(budget.recording.maxTargetBitrateBps).toBe(10_000_000);
		expect(budget.recording.webcamFps).toBe(30);
		expect(budget.recording.webcamBitrate).toBe(2_500_000);
		expect(budget.recording.timesliceMs).toBe(1000);
		expect(budget.preview.maxDpr).toBe(1);
		expect(budget.preview.antialias).toBe(false);
		expect(budget.preview.allowCssDropShadow).toBe(false);
		expect(budget.preview.allowDomBlur).toBe(false);
		expect(budget.preview.allowHoverVideoPreview).toBe(false);
		expect(budget.preview.filmstripMaxFrames).toBe(64);
		expect(budget.export.whisperMaxThreads).toBe(2);
		expect(budget.export.libx264MaxThreads).toBe(2);
		expect(budget.export.preferFastSoftwarePreset).toBe(true);
	});

	it("lets users override capture resolution and fps independently of tier", () => {
		const budget = resolvePerformanceBudget(
			{ performanceMode: "low", captureMaxResolution: "native", captureFps: 60 },
			null,
		);
		expect(budget.tier).toBe("low");
		expect(budget.recording.maxWidth).toBe(3840);
		expect(budget.recording.maxHeight).toBe(2160);
		expect(budget.recording.fps).toBe(60);
	});

	it("normalizes corrupted persisted preferences safely", () => {
		expect(
			normalizePerformancePreferences({
				performanceMode: "turbo",
				captureMaxResolution: 42,
				captureFps: 120,
			}),
		).toEqual({
			performanceMode: "auto",
			captureMaxResolution: "auto",
			captureFps: "auto",
		});
	});

	it("computes bounded whisper and encoder thread counts without starving the OS", () => {
		expect(computeRecommendedThreadCount(4, 0.6, 2, 2)).toBe(2);
		expect(computeRecommendedThreadCount(8, 0.6, 2, 2)).toBe(4);
		expect(computeRecommendedThreadCount(16, 0.6, 2, 2)).toBe(9);
	});
});
