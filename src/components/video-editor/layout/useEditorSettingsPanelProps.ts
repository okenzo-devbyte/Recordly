import {
	type ComponentProps,
	type Dispatch,
	type SetStateAction,
	useCallback,
	useMemo,
} from "react";
import type { AspectRatio } from "@/utils/aspectRatioUtils";
import { useClipAudioReset } from "../audio/useClipAudioReset";
import type { useAutoCaptionController } from "../captions/useAutoCaptionController";
import type { useAnnotationRegionCommands } from "../hooks/useAnnotationRegionCommands";
import type { useAudioRegionCommands } from "../hooks/useAudioRegionCommands";
import type { useCaptionCommands } from "../hooks/useCaptionCommands";
import type { useClipRegionCommands } from "../hooks/useClipRegionCommands";
import type { useZoomRegionCommands } from "../hooks/useZoomRegionCommands";
import { SettingsPanel } from "../SettingsPanel";
import type { PlaybackClockStore } from "../state/playbackClockStore";
import type { useAppearanceState } from "../state/useAppearanceState";
import type { useTimelineState } from "../state/useTimelineState";
import { type EditorEffectSection, mapTimelineTimeToSourceTime } from "../types";

type Input = {
	activeEffectSection: EditorEffectSection;
	appearance: ReturnType<typeof useAppearanceState>;
	timeline: ReturnType<typeof useTimelineState>;
	zoomCommands: ReturnType<typeof useZoomRegionCommands>;
	clipCommands: ReturnType<typeof useClipRegionCommands>;
	audioCommands: ReturnType<typeof useAudioRegionCommands>;
	captionCommands: ReturnType<typeof useCaptionCommands>;
	annotationCommands: ReturnType<typeof useAnnotationRegionCommands>;
	autoCaptionController: ReturnType<typeof useAutoCaptionController>;
	effectiveShowCursor: boolean;
	handleShowCursorChange: (show: boolean) => void;
	playbackClock?: PlaybackClockStore;
	currentTime?: number;
	isPlaying: boolean;
	aspectRatio: AspectRatio;
	setAspectRatio: Dispatch<SetStateAction<AspectRatio>>;
	whisperExecutablePath: string | null;
	whisperModelPath: string | null;
	whisperModelDownloadStatus: "idle" | "downloading" | "downloaded" | "error";
	whisperModelDownloadProgress: number;
	isGeneratingCaptions: boolean;
	sessionNativeCaptureUnavailable: boolean;
	setNativeCaptureUnavailableModalOpen: Dispatch<SetStateAction<boolean>>;
	handleUploadWebcam: () => void;
	handleClearWebcam: () => void;
};

export function useEditorSettingsPanelProps(input: Input): ComponentProps<typeof SettingsPanel> {
	const {
		activeEffectSection,
		appearance,
		timeline,
		zoomCommands,
		clipCommands,
		audioCommands,
		captionCommands,
		annotationCommands,
		autoCaptionController,
		effectiveShowCursor,
		handleShowCursorChange,
		playbackClock,
		currentTime = 0,
		isPlaying,
		aspectRatio,
		setAspectRatio,
		whisperExecutablePath,
		whisperModelPath,
		whisperModelDownloadStatus,
		whisperModelDownloadProgress,
		isGeneratingCaptions,
		sessionNativeCaptureUnavailable,
		setNativeCaptureUnavailableModalOpen,
		handleUploadWebcam,
		handleClearWebcam,
	} = input;
	const selectedZoom = timeline.zoomRegions.find(
		(region) => region.id === timeline.selectedZoomId,
	);
	const selectedClip = timeline.clipRegions.find(
		(region) => region.id === timeline.selectedClipId,
	);
	const selectedAudio = timeline.audioRegions.find(
		(region) => region.id === timeline.selectedAudioId,
	);

	const clipAudioReset = useClipAudioReset(timeline);
	const getCaptionCurrentTimeMs = useCallback(
		() =>
			mapTimelineTimeToSourceTime(
				(playbackClock ? playbackClock.getTimelineTime() : currentTime) * 1000,
				timeline.clipRegions,
			),
		[currentTime, playbackClock, timeline.clipRegions],
	);
	const onZoomDepthChange = useCallback(
		(depth: Parameters<typeof zoomCommands.handleZoomDepthChange>[0]) => {
			if (timeline.selectedZoomId) {
				zoomCommands.handleZoomDepthChange(depth);
			}
		},
		[timeline.selectedZoomId, zoomCommands.handleZoomDepthChange],
	);
	const onZoomModeChange = useCallback(
		(mode: Parameters<typeof zoomCommands.handleZoomModeChange>[0]) => {
			if (timeline.selectedZoomId) {
				zoomCommands.handleZoomModeChange(mode);
			}
		},
		[timeline.selectedZoomId, zoomCommands.handleZoomModeChange],
	);
	const onOpenNativeCaptureUnavailableModal = useCallback(
		() => setNativeCaptureUnavailableModalOpen(true),
		[setNativeCaptureUnavailableModalOpen],
	);

	return useMemo(
		() => ({
			...clipAudioReset,
			panelMode: "editor",
			activeEffectSection,
			selected: appearance.wallpaper,
			onWallpaperChange: appearance.setWallpaper,
			selectedZoomDepth: selectedZoom?.depth ?? null,
			onZoomDepthChange,
			selectedZoomId: timeline.selectedZoomId,
			selectedZoomMode: selectedZoom?.mode ?? (timeline.selectedZoomId ? "auto" : null),
			onZoomModeChange,
			onZoomDelete: zoomCommands.handleZoomDelete,
			selectedClipId: timeline.selectedClipId,
			selectedClipSpeed: selectedClip?.speed ?? (timeline.selectedClipId ? 1 : null),
			selectedClipMuted: selectedClip?.muted ?? (timeline.selectedClipId ? false : null),
			onClipSpeedChange: clipCommands.handleClipSpeedChange,
			onClipMutedChange: clipCommands.handleClipMutedChange,
			onClipDelete: clipCommands.handleClipDelete,
			selectedAudioId: timeline.selectedAudioId,
			selectedAudioVolume: selectedAudio?.volume ?? null,
			selectedAudioNormalize:
				selectedAudio?.normalize ?? (timeline.selectedAudioId ? false : null),
			onAudioVolumeChange: audioCommands.handleAudioVolumeChange,
			onAudioNormalizeChange: audioCommands.handleAudioNormalizeChange,
			onAudioDelete: audioCommands.handleAudioDelete,
			shadowIntensity: appearance.shadowIntensity,
			onShadowChange: appearance.setShadowIntensity,
			backgroundBlur: appearance.backgroundBlur,
			onBackgroundBlurChange: appearance.setBackgroundBlur,
			connectZooms: appearance.connectZooms,
			autoApplyFreshRecordingAutoZooms: appearance.autoApplyFreshRecordingAutoZooms,
			onAutoApplyFreshRecordingAutoZoomsChange: appearance.setAutoApplyFreshRecordingAutoZooms,
			onConnectZoomsChange: appearance.setConnectZooms,
			zoomInDurationMs: appearance.zoomInDurationMs,
			onZoomInDurationMsChange: appearance.setZoomInDurationMs,
			zoomInOverlapMs: appearance.zoomInOverlapMs,
			onZoomInOverlapMsChange: appearance.setZoomInOverlapMs,
			zoomOutDurationMs: appearance.zoomOutDurationMs,
			onZoomOutDurationMsChange: appearance.setZoomOutDurationMs,
			connectedZoomGapMs: appearance.connectedZoomGapMs,
			onConnectedZoomGapMsChange: appearance.setConnectedZoomGapMs,
			connectedZoomDurationMs: appearance.connectedZoomDurationMs,
			onConnectedZoomDurationMsChange: appearance.setConnectedZoomDurationMs,
			zoomInEasing: appearance.zoomInEasing,
			onZoomInEasingChange: appearance.setZoomInEasing,
			zoomOutEasing: appearance.zoomOutEasing,
			onZoomOutEasingChange: appearance.setZoomOutEasing,
			connectedZoomEasing: appearance.connectedZoomEasing,
			onConnectedZoomEasingChange: appearance.setConnectedZoomEasing,
			showCursor: effectiveShowCursor,
			onShowCursorChange: handleShowCursorChange,
			loopCursor: appearance.loopCursor,
			onLoopCursorChange: appearance.setLoopCursor,
			cursorStyle: appearance.cursorStyle,
			onCursorStyleChange: appearance.setCursorStyle,
			cursorSize: appearance.cursorSize,
			onCursorSizeChange: appearance.setCursorSize,
			cursorSmoothing: appearance.cursorSmoothing,
			onCursorSmoothingChange: appearance.setCursorSmoothing,
			cursorSpringStiffnessMultiplier: appearance.cursorSpringStiffnessMultiplier,
			onCursorSpringStiffnessMultiplierChange: appearance.setCursorSpringStiffnessMultiplier,
			cursorSpringDampingMultiplier: appearance.cursorSpringDampingMultiplier,
			onCursorSpringDampingMultiplierChange: appearance.setCursorSpringDampingMultiplier,
			cursorSpringMassMultiplier: appearance.cursorSpringMassMultiplier,
			onCursorSpringMassMultiplierChange: appearance.setCursorSpringMassMultiplier,
			cameraSpringStiffnessMultiplier: appearance.cameraSpringStiffnessMultiplier,
			onCameraSpringStiffnessMultiplierChange: appearance.setCameraSpringStiffnessMultiplier,
			cameraSpringDampingMultiplier: appearance.cameraSpringDampingMultiplier,
			onCameraSpringDampingMultiplierChange: appearance.setCameraSpringDampingMultiplier,
			cameraSpringMassMultiplier: appearance.cameraSpringMassMultiplier,
			onCameraSpringMassMultiplierChange: appearance.setCameraSpringMassMultiplier,
			zoomClassicMode: appearance.zoomClassicMode,
			onZoomClassicModeChange: appearance.setZoomClassicMode,
			cursorClickEffect: appearance.cursorClickEffect,
			cursorClickEffectColor: appearance.cursorClickEffectColor,
			onCursorClickEffectChange: appearance.setCursorClickEffect,
			onCursorClickEffectColorChange: appearance.setCursorClickEffectColor,
			cursorClickEffectScale: appearance.cursorClickEffectScale,
			onCursorClickEffectScaleChange: appearance.setCursorClickEffectScale,
			cursorClickEffectOpacity: appearance.cursorClickEffectOpacity,
			onCursorClickEffectOpacityChange: appearance.setCursorClickEffectOpacity,
			cursorClickEffectDurationMs: appearance.cursorClickEffectDurationMs,
			onCursorClickEffectDurationMsChange: appearance.setCursorClickEffectDurationMs,
			cursorClickBounce: appearance.cursorClickBounce,
			onCursorClickBounceChange: appearance.setCursorClickBounce,
			cursorClickBounceDuration: appearance.cursorClickBounceDuration,
			onCursorClickBounceDurationChange: appearance.setCursorClickBounceDuration,
			cursorSway: appearance.cursorSway,
			onCursorSwayChange: appearance.setCursorSway,
			cursorIdleHide: appearance.cursorIdleHide,
			onCursorIdleHideChange: appearance.setCursorIdleHide,
			borderRadius: appearance.borderRadius,
			onBorderRadiusChange: appearance.setBorderRadius,
			webcam: appearance.webcam,
			webcamPreviewSrc: appearance.webcam.sourcePath ? appearance.resolvedWebcamVideoUrl : null,
			webcamPreviewCurrentTime:
				mapTimelineTimeToSourceTime(currentTime * 1000, timeline.clipRegions) / 1000,
			webcamPreviewPlaying: isPlaying,
			playbackClock,
			clipRegions: timeline.clipRegions,
			onWebcamChange: appearance.setWebcam,
			onUploadWebcam: handleUploadWebcam,
			onClearWebcam: handleClearWebcam,
			padding: appearance.padding,
			onPaddingChange: appearance.setPadding,
			cropRegion: appearance.cropRegion,
			onCropChange: appearance.setCropRegion,
			aspectRatio,
			onAspectRatioChange: setAspectRatio,
			selectedAnnotationId: timeline.selectedAnnotationId,
			annotationRegions: timeline.annotationRegions,
			autoCaptions: timeline.autoCaptions,
			autoCaptionSettings: timeline.autoCaptionSettings,
			whisperExecutablePath,
			whisperModelPath,
			captionModelId: autoCaptionController.captionModelId,
			captionModelLoading: autoCaptionController.captionModelLoading,
			onCaptionModelChange: autoCaptionController.handleCaptionModelChange,
			whisperModelDownloadStatus,
			whisperModelDownloadProgress,
			isGeneratingCaptions,
			onAutoCaptionSettingsChange: timeline.setAutoCaptionSettings,
			onPickWhisperExecutable: autoCaptionController.handlePickWhisperExecutable,
			onPickWhisperModel: autoCaptionController.handlePickWhisperModel,
			onGenerateAutoCaptions: autoCaptionController.handleGenerateAutoCaptions,
			onClearAutoCaptions: captionCommands.handleClearAutoCaptions,
			captionCurrentTimeMs: mapTimelineTimeToSourceTime(currentTime * 1000, timeline.clipRegions),
			getCaptionCurrentTimeMs,
			selectedCaptionId: timeline.selectedCaptionId,
			onBeginCaptionEdit: captionCommands.handleBeginCaptionEdit,
			onCaptionTextEdit: captionCommands.handleCaptionTextEdit,
			onCaptionRetime: captionCommands.handleCaptionRetime,
			onCaptionSplit: captionCommands.handleCaptionSplit,
			onCaptionMerge: captionCommands.handleCaptionMerge,
			onCaptionDelete: captionCommands.handleCaptionDelete,
			onDeleteWhisperSmallModel: autoCaptionController.handleDeleteWhisperSmallModel,
			nativeCaptureUnavailableSession: sessionNativeCaptureUnavailable,
			onOpenNativeCaptureUnavailableModal,
			onAnnotationContentChange: annotationCommands.handleAnnotationContentChange,
			onAnnotationTypeChange: annotationCommands.handleAnnotationTypeChange,
			onAnnotationStyleChange: annotationCommands.handleAnnotationStyleChange,
			onAnnotationFigureDataChange: annotationCommands.handleAnnotationFigureDataChange,
			onAnnotationBlurIntensityChange: annotationCommands.handleAnnotationBlurIntensityChange,
			onAnnotationBlurColorChange: annotationCommands.handleAnnotationBlurColorChange,
			onAnnotationDelete: annotationCommands.handleAnnotationDelete,
		}),
		[
			activeEffectSection,
			annotationCommands,
			appearance,
			aspectRatio,
			audioCommands,
			autoCaptionController,
			captionCommands,
			clipAudioReset,
			clipCommands,
			currentTime,
			effectiveShowCursor,
			getCaptionCurrentTimeMs,
			handleClearWebcam,
			handleShowCursorChange,
			handleUploadWebcam,
			isGeneratingCaptions,
			isPlaying,
			onOpenNativeCaptureUnavailableModal,
			onZoomDepthChange,
			onZoomModeChange,
			playbackClock,
			selectedAudio,
			selectedClip,
			selectedZoom,
			sessionNativeCaptureUnavailable,
			setAspectRatio,
			timeline.annotationRegions,
			timeline.autoCaptionSettings,
			timeline.autoCaptions,
			timeline.clipRegions,
			timeline.selectedAnnotationId,
			timeline.selectedAudioId,
			timeline.selectedCaptionId,
			timeline.selectedClipId,
			timeline.selectedZoomId,
			timeline.setAutoCaptionSettings,
			whisperExecutablePath,
			whisperModelDownloadProgress,
			whisperModelDownloadStatus,
			whisperModelPath,
			zoomCommands.handleZoomDelete,
		],
	);
}
