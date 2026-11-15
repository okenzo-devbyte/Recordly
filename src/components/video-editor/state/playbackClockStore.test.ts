import { describe, expect, it, vi } from "vitest";
import { createPlaybackClockStore } from "./playbackClockStore";

describe("createPlaybackClockStore", () => {
	it("initializes and updates timeline/source timestamps without redundant notifications", () => {
		const store = createPlaybackClockStore(0, 0);
		const listener = vi.fn();
		const unsubscribe = store.subscribe(listener);

		const initial = store.getSnapshot();
		expect(initial).toEqual({ timelineTime: 0, sourceTime: 0 });

		store.setTime(0, 0);
		expect(listener).not.toHaveBeenCalled();
		expect(store.getSnapshot()).toBe(initial);

		store.setTime(1.25, 2.5);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(store.getTimelineTime()).toBe(1.25);
		expect(store.getSourceTime()).toBe(2.5);

		store.setTime(1.25, 2.5);
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe();
		store.setTime(3, 4);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it("maps timeline time through clip regions when using setTimelineTime", () => {
		const store = createPlaybackClockStore(0, 0);
		store.setTimelineTime(2, [
			{
				id: "clip-1",
				startMs: 1000,
				endMs: 5000,
				sourceStartMs: 10_000,
				speed: 2,
			},
		]);

		expect(store.getTimelineTime()).toBe(2);
		expect(store.getSourceTime()).toBe(12);
	});
});
