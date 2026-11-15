import { type RefObject, useCallback } from "react";
import type { PlaybackClockStore } from "../state/playbackClockStore";
import type { TimelineEditorHandle } from "../timeline/TimelineEditor";
import type { VideoPlaybackRef } from "../VideoPlayback";

interface UseEditorPlaybackControlsParams {
	videoPlaybackRef: RefObject<VideoPlaybackRef | null>;
	timelineRef: RefObject<TimelineEditorHandle | null>;
	playSourceAudioPreview: () => void;
	playbackClock?: PlaybackClockStore;
	timelinePlayheadTime?: number;
	timelineDuration: number;
}

export function useEditorPlaybackControls({
	videoPlaybackRef,
	timelineRef,
	playSourceAudioPreview,
	playbackClock,
	timelinePlayheadTime = 0,
	timelineDuration,
}: UseEditorPlaybackControlsParams) {
	const getActivePlayback = useCallback(() => videoPlaybackRef.current, [videoPlaybackRef]);

	const startPlayback = useCallback(() => {
		const playback = getActivePlayback();
		if (!playback?.video) return;

		playSourceAudioPreview();
		playback.play().catch((error) => console.error("Video play failed:", error));
	}, [getActivePlayback, playSourceAudioPreview]);

	const togglePlayPause = useCallback(() => {
		const playback = getActivePlayback();
		const video = playback?.video;
		if (!playback || !video) return;

		if (playback.isPlaying) playback.pause();
		else startPlayback();
	}, [getActivePlayback, startPlayback]);

	const handleSeek = useCallback(
		(time: number, options: { pause?: boolean } = {}) => {
			const playback = getActivePlayback();
			const video = playback?.video;
			if (!video) return;

			if (options.pause) playback.pause();
			playback.seekTimeline(time);
		},
		[getActivePlayback],
	);

	const handleTimelineSeek = useCallback(
		(time: number) => handleSeek(time, { pause: true }),
		[handleSeek],
	);

	const handlePreviewSkipBack = useCallback(() => {
		const playheadTime = playbackClock ? playbackClock.getTimelineTime() : timelinePlayheadTime;
		const currentMs = playheadTime * 1000;
		const keyframes = timelineRef.current?.keyframes ?? [];
		const previous = [...keyframes]
			.reverse()
			.find((keyframe) => keyframe.time < currentMs - 50);
		handleSeek(previous ? previous.time / 1000 : Math.max(0, playheadTime - 5));
	}, [handleSeek, playbackClock, timelinePlayheadTime, timelineRef]);

	const handlePreviewSkipForward = useCallback(() => {
		const playheadTime = playbackClock ? playbackClock.getTimelineTime() : timelinePlayheadTime;
		const currentMs = playheadTime * 1000;
		const keyframes = timelineRef.current?.keyframes ?? [];
		const next = keyframes.find((keyframe) => keyframe.time > currentMs + 50);
		handleSeek(next ? next.time / 1000 : Math.min(timelineDuration, playheadTime + 5));
	}, [handleSeek, playbackClock, timelineDuration, timelinePlayheadTime, timelineRef]);

	return {
		startPlayback,
		togglePlayPause,
		handleSeek,
		handleTimelineSeek,
		handlePreviewSkipBack,
		handlePreviewSkipForward,
	};
}
