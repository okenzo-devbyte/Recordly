import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { SourceAudioTrackSettings } from "@/components/video-editor/audio/audioTypes";
import { resolveSourceTrackRoutingPolicy } from "@/lib/exporter/sourceTrackRoutingPolicy";
import type { PlaybackClockStore } from "../state/playbackClockStore";
import type { AudioRegion, ClipRegion } from "../types";
import { findClipAtTimelineTime } from "../types";
import { isClipMutedById } from "./clipAudio";
import { useAudioPreviewSync } from "./useAudioPreviewSync";
import { useClipAudioSettingsController } from "./useClipAudioSettingsController";
import { useSourceAudioFallback } from "./useSourceAudioFallback";

function extractLocalPathFromMediaServerUrl(input: string | null | undefined): string | null {
	if (!input) return null;
	try {
		const url = new URL(input);
		const isLocalMediaServer =
			(url.protocol === "http:" || url.protocol === "https:") &&
			(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
			url.pathname === "/video";
		if (!isLocalMediaServer) return null;
		return url.searchParams.get("path");
	} catch {
		return null;
	}
}

interface UseVideoEditorAudioParams {
	currentSourcePath: string | null;
	selectedClipId: string | null;
	clipRegions: ClipRegion[];
	audioRegions: AudioRegion[];
	sourceAudioTrackSettingsByClip: Record<string, SourceAudioTrackSettings>;
	setSourceAudioTrackSettingsByClip: React.Dispatch<
		React.SetStateAction<Record<string, SourceAudioTrackSettings>>
	>;
	defaultSourceAudioTrackSettings: SourceAudioTrackSettings;
	setDefaultSourceAudioTrackSettings: React.Dispatch<
		React.SetStateAction<SourceAudioTrackSettings>
	>;
	playbackClock?: PlaybackClockStore;
	currentTime?: number;
	timelineTime?: number;
	duration: number;
	isPlaying: boolean;
	previewVolume: number;
	sourceAudioFallbackRefreshKey?: number;
	summarizeErrorMessage: (message: string) => string;
	onSourceFallbackLoadError: (error: unknown) => void;
}

export function useVideoEditorAudio({
	currentSourcePath,
	selectedClipId,
	clipRegions,
	audioRegions,
	sourceAudioTrackSettingsByClip,
	setSourceAudioTrackSettingsByClip,
	defaultSourceAudioTrackSettings,
	setDefaultSourceAudioTrackSettings,
	playbackClock,
	currentTime = 0,
	timelineTime = 0,
	duration,
	isPlaying,
	previewVolume,
	sourceAudioFallbackRefreshKey = 0,
	summarizeErrorMessage,
	onSourceFallbackLoadError,
}: UseVideoEditorAudioParams) {
	const fallbackLookupSourcePath = useMemo(
		() => extractLocalPathFromMediaServerUrl(currentSourcePath) ?? currentSourcePath,
		[currentSourcePath],
	);

	const { sourceAudioFallbackPaths, sourceAudioFallbackStartDelayMsByPath } =
		useSourceAudioFallback({
			currentSourcePath: fallbackLookupSourcePath,
			refreshKey: sourceAudioFallbackRefreshKey,
			summarizeErrorMessage,
		});

	const sourceTrackRoutingPolicy = useMemo(
		() => resolveSourceTrackRoutingPolicy(currentSourcePath, sourceAudioFallbackPaths),
		[currentSourcePath, sourceAudioFallbackPaths],
	);
	const previewSourceAudioFallbackPaths = sourceTrackRoutingPolicy.playbackPaths;
	const shouldMutePreviewVideo = sourceTrackRoutingPolicy.muteEmbeddedPreview;

	const [clockActiveClipId, setClockActiveClipId] = useState<string | null>(
		() =>
			findClipAtTimelineTime(
				(playbackClock ? playbackClock.getTimelineTime() : timelineTime) * 1000,
				clipRegions,
			)?.id ?? null,
	);
	useEffect(() => {
		const computeClipId = () =>
			findClipAtTimelineTime(
				(playbackClock ? playbackClock.getTimelineTime() : timelineTime) * 1000,
				clipRegions,
			)?.id ?? null;
		setClockActiveClipId((previous) => {
			const next = computeClipId();
			return previous === next ? previous : next;
		});
		if (!playbackClock) return;
		return playbackClock.subscribe(() => {
			const next = computeClipId();
			setClockActiveClipId((previous) => (previous === next ? previous : next));
		});
	}, [clipRegions, playbackClock, timelineTime]);

	const activeClipIdAtCurrentTime = useMemo(
		() =>
			playbackClock
				? clockActiveClipId
				: (findClipAtTimelineTime(timelineTime * 1000, clipRegions)?.id ?? null),
		[clipRegions, clockActiveClipId, playbackClock, timelineTime],
	);
	const isCurrentClipMuted = useMemo(
		() =>
			activeClipIdAtCurrentTime === null ||
			isClipMutedById(activeClipIdAtCurrentTime, clipRegions),
		[activeClipIdAtCurrentTime, clipRegions],
	);
	const activeClipPlaybackRate = useMemo(() => {
		if (!activeClipIdAtCurrentTime) return 1;
		return clipRegions.find((clip) => clip.id === activeClipIdAtCurrentTime)?.speed ?? 1;
	}, [activeClipIdAtCurrentTime, clipRegions]);

	const getSourcePlaybackRate = useCallback(
		(timelineSeconds: number) =>
			findClipAtTimelineTime(timelineSeconds * 1000, clipRegions)?.speed ?? 1,
		[clipRegions],
	);
	const getIsTimelineTimeMuted = useCallback(
		(timelineSeconds: number) => {
			const clip = findClipAtTimelineTime(timelineSeconds * 1000, clipRegions);
			return !clip || isClipMutedById(clip.id, clipRegions);
		},
		[clipRegions],
	);

	const {
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	} = useClipAudioSettingsController({
		selectedClipId,
		activeClipId: activeClipIdAtCurrentTime,
		sourceAudioTrackSettingsByClip,
		setSourceAudioTrackSettingsByClip,
		defaultSourceAudioTrackSettings,
		setDefaultSourceAudioTrackSettings,
	});

	const { playSourceAudioPreview } = useAudioPreviewSync({
		audioRegions,
		previewVolume,
		isPlaying,
		playbackClock,
		currentTime,
		timelineTime,
		duration,
		sourcePlaybackRate: playbackClock
			? activeClipPlaybackRate
			: (findClipAtTimelineTime(timelineTime * 1000, clipRegions)?.speed ?? 1),
		getSourcePlaybackRate: playbackClock ? getSourcePlaybackRate : undefined,
		getIsTimelineTimeMuted: playbackClock ? getIsTimelineTimeMuted : undefined,
		previewSourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		sourceAudioResourceVersion: sourceAudioFallbackRefreshKey,
		isCurrentClipMuted,
		getSourceTrackPreviewGain,
		onSourceFallbackLoadError,
	});

	return {
		sourceAudioFallbackPaths,
		sourceAudioFallbackStartDelayMsByPath,
		previewSourceAudioFallbackPaths,
		shouldMutePreviewVideo,
		activeClipIdAtCurrentTime,
		isCurrentClipMuted,
		sourceAudioTrackMeta,
		activeSourceAudioTrackSettings,
		selectedClipSourceAudioTrackSettings,
		playSourceAudioPreview,
		getSourceAudioTrackSettingsForClip,
		onSourceAudioTracksMetaChange,
		onSelectedClipSourceAudioTrackVolumeChange,
		onSelectedClipSourceAudioTrackNormalizeChange,
		embeddedSourcePreviewGain,
		getSourceTrackPreviewGain,
	};
}
