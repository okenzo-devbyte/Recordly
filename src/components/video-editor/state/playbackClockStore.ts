import { type ClipRegion, mapTimelineTimeToSourceTime } from "../types";

export interface PlaybackClockSnapshot {
	readonly timelineTime: number;
	readonly sourceTime: number;
}

export interface PlaybackClockStore {
	getSnapshot: () => PlaybackClockSnapshot;
	getTimelineTime: () => number;
	getSourceTime: () => number;
	setTime: (timelineTime: number, sourceTime?: number) => void;
	setTimelineTime: (timelineTime: number, clipRegions?: ClipRegion[]) => void;
	subscribe: (listener: () => void) => () => void;
}

function normalizeSeconds(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function createPlaybackClockStore(
	initialTimelineTime = 0,
	initialSourceTime = initialTimelineTime,
): PlaybackClockStore {
	let snapshot: PlaybackClockSnapshot = {
		timelineTime: normalizeSeconds(initialTimelineTime, 0),
		sourceTime: normalizeSeconds(initialSourceTime, 0),
	};
	const listeners = new Set<() => void>();

	const notify = () => {
		for (const listener of [...listeners]) {
			listener();
		}
	};

	const setTime = (timelineTime: number, sourceTime?: number) => {
		const nextTimeline = normalizeSeconds(timelineTime, snapshot.timelineTime);
		const nextSource =
			sourceTime === undefined
				? nextTimeline === 0
					? 0
					: snapshot.sourceTime
				: normalizeSeconds(sourceTime, snapshot.sourceTime);
		if (
			Object.is(nextTimeline, snapshot.timelineTime) &&
			Object.is(nextSource, snapshot.sourceTime)
		) {
			return;
		}
		snapshot = { timelineTime: nextTimeline, sourceTime: nextSource };
		notify();
	};

	const setTimelineTime = (timelineTime: number, clipRegions: ClipRegion[] = []) => {
		const nextTimeline = normalizeSeconds(timelineTime, snapshot.timelineTime);
		const nextSource = mapTimelineTimeToSourceTime(nextTimeline * 1000, clipRegions) / 1000;
		setTime(nextTimeline, nextSource);
	};

	return {
		getSnapshot: () => snapshot,
		getTimelineTime: () => snapshot.timelineTime,
		getSourceTime: () => snapshot.sourceTime,
		setTime,
		setTimelineTime,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
