import { useSyncExternalStore } from "react";
import {
	DEFAULT_PERFORMANCE_PREFERENCES,
	normalizePerformancePreferences,
	type PerformanceBudget,
	type PerformancePreferences,
	resolvePerformanceBudget,
	type SystemHardwareProfile,
} from "../shared/performanceProfile";

let preferences: PerformancePreferences = { ...DEFAULT_PERFORMANCE_PREFERENCES };
let hardware: SystemHardwareProfile | null = null;
let currentBudget: PerformanceBudget = resolvePerformanceBudget(preferences, hardware);
let hasLoaded = false;
let loadPromise: Promise<PerformanceBudget> | null = null;
let unsubscribeIpc: (() => void) | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
	for (const listener of listeners) {
		listener();
	}
}

function recomputeBudget() {
	currentBudget = resolvePerformanceBudget(preferences, hardware);
	notifyListeners();
	return currentBudget;
}

function ensureIpcSubscription() {
	if (unsubscribeIpc || typeof window === "undefined") return;
	const subscribe = window.electronAPI?.onPerformancePreferencesChanged;
	if (typeof subscribe !== "function") return;
	unsubscribeIpc = subscribe((nextPrefs) => {
		preferences = normalizePerformancePreferences(nextPrefs);
		recomputeBudget();
	});
}

export function getPerformanceBudgetSnapshot(): PerformanceBudget {
	return currentBudget;
}

export function subscribePerformanceBudget(listener: () => void): () => void {
	listeners.add(listener);
	ensureIpcSubscription();
	return () => {
		listeners.delete(listener);
	};
}

export function usePerformanceBudget(): PerformanceBudget {
	return useSyncExternalStore(
		subscribePerformanceBudget,
		getPerformanceBudgetSnapshot,
		getPerformanceBudgetSnapshot,
	);
}

export async function ensurePerformanceProfileLoaded(options?: {
	force?: boolean;
}): Promise<PerformanceBudget> {
	if (typeof window === "undefined" || !window.electronAPI) {
		hasLoaded = true;
		return currentBudget;
	}
	ensureIpcSubscription();
	if (hasLoaded && !options?.force) {
		return currentBudget;
	}
	if (loadPromise && !options?.force) {
		return loadPromise;
	}

	loadPromise = (async () => {
		try {
			const [profileResult, prefsResult] = await Promise.all([
				typeof window.electronAPI.getSystemHardwareProfile === "function"
					? window.electronAPI.getSystemHardwareProfile().catch(() => null)
					: Promise.resolve(null),
				typeof window.electronAPI.getPerformancePreferences === "function"
					? window.electronAPI.getPerformancePreferences().catch(() => null)
					: Promise.resolve(null),
			]);
			if (profileResult?.success && profileResult.profile) {
				hardware = profileResult.profile;
			}
			if (prefsResult?.success) {
				preferences = normalizePerformancePreferences(prefsResult);
			}
			hasLoaded = true;
			return recomputeBudget();
		} finally {
			loadPromise = null;
		}
	})();

	return loadPromise;
}

export async function updatePerformancePreferences(
	patch: Partial<PerformancePreferences>,
): Promise<{ success: boolean; budget: PerformanceBudget; error?: string }> {
	const previousPreferences = preferences;
	const optimistic = normalizePerformancePreferences({ ...preferences, ...patch });
	preferences = optimistic;
	recomputeBudget();

	if (
		typeof window === "undefined" ||
		typeof window.electronAPI?.setPerformancePreferences !== "function"
	) {
		return { success: true, budget: currentBudget };
	}

	try {
		const result = await window.electronAPI.setPerformancePreferences(patch);
		if (!result.success) {
			preferences = previousPreferences;
			recomputeBudget();
			return {
				success: false,
				budget: currentBudget,
				error: result.error || "Failed to save performance preferences",
			};
		}
		preferences = normalizePerformancePreferences(result);
		recomputeBudget();
		return { success: true, budget: currentBudget };
	} catch (error) {
		preferences = previousPreferences;
		recomputeBudget();
		return {
			success: false,
			budget: currentBudget,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function resetPerformanceProfileStoreForTest() {
	if (unsubscribeIpc) {
		unsubscribeIpc();
		unsubscribeIpc = null;
	}
	preferences = { ...DEFAULT_PERFORMANCE_PREFERENCES };
	hardware = null;
	currentBudget = resolvePerformanceBudget(preferences, hardware);
	hasLoaded = false;
	loadPromise = null;
	listeners.clear();
}
