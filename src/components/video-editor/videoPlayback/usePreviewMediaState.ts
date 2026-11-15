import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { mapTimelineTimeToSourceTime } from "../types";
import { createClipPlayback, findPreviewClipAtTimelineTime } from "./clipPlayback";
import type { PlaybackProps } from "./playbackProps";
import { PreviewVideoSource } from "./previewVideoSource";
import type { createPreviewRenderLoop } from "./previewRenderLoop";
import { usePreviewVideoReady } from "./usePreviewVideoReady";

const noopSubscribe = () => () => undefined;

export function usePreviewMediaState(
	input: Pick<
		PlaybackProps,
		| "videoPath"
		| "timelineTime"
		| "playbackClock"
		| "clipRegions"
		| "onError"
		| "isPlaying"
		| "suspendRendering"
	>,
) {
	const {
		videoPath,
		timelineTime,
		playbackClock,
		clipRegions,
		onError,
		isPlaying,
		suspendRendering,
	} = input;

	const videoRef = useRef<HTMLVideoElement | null>(null);

	const previewVideoSourceRef = useRef(new PreviewVideoSource());
	const previewRenderLoopRef = useRef<ReturnType<typeof createPreviewRenderLoop> | null>(null);

	const attachVideo = useCallback((video: HTMLVideoElement | null) => {
		if (video !== videoRef.current) {
			// Ref detachment precedes passive cleanup. Stop sampling before the source is destroyed.
			previewRenderLoopRef.current?.dispose();
		}
		// VideoSource.destroy() clears the media URL, so only destroy it when
		// React detaches the element, never during a layout effect cleanup.
		previewVideoSourceRef.current.setVideo(video);
		videoRef.current = video;
	}, []);

	const videoReady = usePreviewVideoReady(videoRef, videoPath);

	const initialTimelineTime = playbackClock ? playbackClock.getTimelineTime() : timelineTime;
	const currentTime = mapTimelineTimeToSourceTime(initialTimelineTime * 1000, clipRegions) / 1000;

	const isGap = useSyncExternalStore(
		playbackClock ? playbackClock.subscribe : noopSubscribe,
		() =>
			!findPreviewClipAtTimelineTime(
				(playbackClock ? playbackClock.getTimelineTime() : timelineTime) * 1000,
				clipRegions,
			),
	);

	const clipRegionsRef = useRef(clipRegions);

	const clipPlaybackRef = useRef<ReturnType<typeof createClipPlayback> | null>(null);

	const onPlaybackErrorRef = useRef(onError);

	const timelineTimeRef = useRef(initialTimelineTime);

	useEffect(() => {
		onPlaybackErrorRef.current = onError;
	}, [onError]);

	useEffect(() => {
		if (!playbackClock) {
			timelineTimeRef.current = timelineTime;
		}
	}, [playbackClock, timelineTime]);

	const currentTimeRef = useRef(currentTime * 1000);

	useEffect(() => {
		clipRegionsRef.current = clipRegions;
		clipPlaybackRef.current?.refresh();
	}, [clipRegions]);

	const isPlayingRef = useRef(isPlaying);

	const suspendRenderingRef = useRef(suspendRendering);

	const isSeekingRef = useRef(false);

	const shouldSnapPausedFrameRef = useRef(false);

	const lastBackgroundSyncTimeRef = useRef<number | null>(null);

	const bgVideoRef = useRef<HTMLVideoElement | null>(null);

	const lastRenderedContentTimeRef = useRef<number | null>(null);

	const requestPreviewRender = useCallback(() => {
		previewRenderLoopRef.current?.requestRender();
	}, []);

	/** Requests one exact composition after an output-affecting edit while paused. */
	const requestPausedFrameRefresh = useCallback(() => {
		if (!isPlayingRef.current) {
			shouldSnapPausedFrameRef.current = true;
			requestPreviewRender();
		}
	}, [requestPreviewRender]);
	return {
		videoRef,
		previewVideoSourceRef,
		attachVideo,
		videoReady,
		currentTime,
		isGap,
		clipRegionsRef,
		clipPlaybackRef,
		onPlaybackErrorRef,
		timelineTimeRef,
		currentTimeRef,
		isPlayingRef,
		suspendRenderingRef,
		isSeekingRef,
		shouldSnapPausedFrameRef,
		lastBackgroundSyncTimeRef,
		bgVideoRef,
		lastRenderedContentTimeRef,
		requestPausedFrameRefresh,
		requestPreviewRender,
		previewRenderLoopRef,
	};
}
