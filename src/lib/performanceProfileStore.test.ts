import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ensurePerformanceProfileLoaded,
	getPerformanceBudgetSnapshot,
	resetPerformanceProfileStoreForTest,
	subscribePerformanceBudget,
	updatePerformancePreferences,
} from "./performanceProfileStore";

describe("performanceProfileStore", () => {
	const originalWindow = globalThis.window;

	beforeEach(() => {
		resetPerformanceProfileStoreForTest();
	});

	afterEach(() => {
		resetPerformanceProfileStoreForTest();
		if (originalWindow === undefined) {
			Reflect.deleteProperty(globalThis, "window");
		} else {
			Object.defineProperty(globalThis, "window", {
				value: originalWindow,
				configurable: true,
				writable: true,
			});
		}
	});

	it("returns balanced default budget safely when window is unavailable", async () => {
		Reflect.deleteProperty(globalThis, "window");
		const budget = await ensurePerformanceProfileLoaded();
		expect(budget.tier).toBe("balanced");
		expect(budget.preview.allowHoverVideoPreview).toBe(true);
		expect(getPerformanceBudgetSnapshot().tier).toBe("balanced");
	});

	it("loads hardware profile and persisted preferences from Electron IPC", async () => {
		let changeListener: ((prefs: unknown) => void) | null = null;
		Object.defineProperty(globalThis, "window", {
			value: {
				electronAPI: {
					getSystemHardwareProfile: vi.fn(async () => ({
						success: true,
						profile: {
							platform: "win32",
							logicalProcessors: 4,
							totalMemoryGb: 8,
							hasHardwareEncoder: true,
							recommendedTier: "low",
						},
					})),
					getPerformancePreferences: vi.fn(async () => ({
						success: true,
						performanceMode: "auto",
						captureMaxResolution: "1080p",
						captureFps: 30,
					})),
					setPerformancePreferences: vi.fn(async (patch) => ({
						success: true,
						performanceMode: patch.performanceMode ?? "auto",
						captureMaxResolution: patch.captureMaxResolution ?? "1080p",
						captureFps: patch.captureFps ?? 30,
					})),
					onPerformancePreferencesChanged: vi.fn((cb) => {
						changeListener = cb;
						return () => {
							changeListener = null;
						};
					}),
				},
			},
			configurable: true,
			writable: true,
		});

		const notifications = vi.fn();
		const unsubscribe = subscribePerformanceBudget(notifications);

		const budget = await ensurePerformanceProfileLoaded();
		expect(budget.tier).toBe("low");
		expect(budget.recording.fps).toBe(30);
		expect(budget.recording.maxWidth).toBe(1920);
		expect(notifications).toHaveBeenCalled();

		const updateResult = await updatePerformancePreferences({ performanceMode: "high" });
		expect(updateResult.success).toBe(true);
		expect(updateResult.budget.tier).toBe("high");

		changeListener?.({
			performanceMode: "balanced",
			captureMaxResolution: "1080p",
			captureFps: 60,
		});
		expect(getPerformanceBudgetSnapshot().tier).toBe("balanced");

		unsubscribe();
	});

	it("rolls back optimistic update if Electron IPC rejects saving", async () => {
		Object.defineProperty(globalThis, "window", {
			value: {
				electronAPI: {
					getSystemHardwareProfile: vi.fn(async () => ({
						success: true,
						profile: {
							platform: "win32",
							logicalProcessors: 4,
							totalMemoryGb: 8,
							hasHardwareEncoder: true,
							recommendedTier: "low",
						},
					})),
					getPerformancePreferences: vi.fn(async () => ({
						success: true,
						performanceMode: "low",
						captureMaxResolution: "1080p",
						captureFps: 30,
					})),
					setPerformancePreferences: vi.fn(async () => ({
						success: false,
						error: "Disk full",
					})),
				},
			},
			configurable: true,
			writable: true,
		});

		await ensurePerformanceProfileLoaded();
		const res = await updatePerformancePreferences({ performanceMode: "high" });
		expect(res.success).toBe(false);
		expect(res.error).toBe("Disk full");
		expect(getPerformanceBudgetSnapshot().tier).toBe("low");
	});
});
