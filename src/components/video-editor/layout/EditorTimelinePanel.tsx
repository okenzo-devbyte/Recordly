import { type RefObject, useCallback, useSyncExternalStore } from "react";
import type { useVideoEditorAudio } from "../audio/useVideoEditorAudio";
import { type projectCaptionCues, retimeCaptionFragment } from "../captionTimeline";
import type { useAnnotationRegionCommands } from "../hooks/useAnnotationRegionCommands";
import type { useAudioRegionCommands } from "../hooks/useAudioRegionCommands";
import type { useCaptionCommands } from "../hooks/useCaptionCommands";
import type { useClipRegionCommands } from "../hooks/useClipRegionCommands";
import type { useEditorPlaybackControls } from "../hooks/useEditorPlaybackControls";
import type { useTimelineProjection } from "../hooks/useTimelineProjection";
import type { useZoomRegionCommands } from "../hooks/useZoomRegionCommands";
import type { PlaybackClockStore } from "../state/playbackClockStore";
import type { useTimelineState } from "../state/useTimelineState";
import type { ZoomPresentationOptions } from "../timeline/core/zoomPresentation";
import TimelineEditor, { type TimelineEditorHandle } from "../timeline/TimelineEditor";
import type { VideoPlaybackRef } from "../VideoPlayback";

const noopSubscribe = () => () => undefined;

function resolveSelectedCaptionFragmentId(
	effectiveCaptionRegions: ReturnType<typeof projectCaptionCues>,
	selectedCaptionId: string | null,
	timeSec: number,
): string | null {
	if (!selectedCaptionId) return null;
	const timeMs = timeSec * 1000;
	return (
		effectiveCaptionRegions.find(
			(cue) =>
				cue.sourceCueId === selectedCaptionId &&
				timeMs >= cue.startMs &&
				timeMs < cue.endMs,
		)?.id ??
		effectiveCaptionRegions.find((cue) => cue.sourceCueId === selectedCaptionId)?.id ??
		null
	);
}

type Props = {
	zoomPresentationOptions?: ZoomPresentationOptions;
	panelRef?: RefObject<HTMLDivElement | null>;
	timelineRef: RefObject<TimelineEditorHandle | null>;
	getAnnotationPlacement?: VideoPlaybackRef["getAnnotationPlacement"];
	timeline: ReturnType<typeof useTimelineState>;
	projection: ReturnType<typeof useTimelineProjection>;
	playback: ReturnType<typeof useEditorPlaybackControls>;
	audio: ReturnType<typeof useVideoEditorAudio>;
	zoomCommands: ReturnType<typeof useZoomRegionCommands>;
	clipCommands: ReturnType<typeof useClipRegionCommands>;
	audioCommands: ReturnType<typeof useAudioRegionCommands>;
	captionCommands: ReturnType<typeof useCaptionCommands>;
	annotationCommands: ReturnType<typeof useAnnotationRegionCommands>;
	videoPath: string | null;
	videoSourcePath: string | null;
	cursorTelemetrySourcePath: string | null;
	normalizedCursorTelemetry: ReturnType<typeof useTimelineState>["cursorTelemetry"];
	playbackClock?: PlaybackClockStore;
	currentTime?: number;
	handleSelectAnnotation: (id: string | null) => void;
};

export function EditorTimelinePanel(props: Props) {
	const {
		timelineRef,
		timeline,
		projection,
		playback,
		audio,
		zoomCommands,
		clipCommands,
		audioCommands,
		captionCommands,
		annotationCommands,
		videoPath,
		videoSourcePath,
		cursorTelemetrySourcePath,
		normalizedCursorTelemetry,
		playbackClock,
		currentTime = 0,
		handleSelectAnnotation,
	} = props;

	const subscribeSelectedCaption = useCallback(
		(listener: () => void) =>
			timeline.selectedCaptionId && playbackClock
				? playbackClock.subscribe(listener)
				: noopSubscribe(),
		[playbackClock, timeline.selectedCaptionId],
	);
	const selectedCaptionFragmentId = useSyncExternalStore(
		subscribeSelectedCaption,
		() =>
			resolveSelectedCaptionFragmentId(
				projection.effectiveCaptionRegions,
				timeline.selectedCaptionId,
				playbackClock ? playbackClock.getTimelineTime() : currentTime,
			),
		() =>
			resolveSelectedCaptionFragmentId(
				projection.effectiveCaptionRegions,
				timeline.selectedCaptionId,
				currentTime,
			),
	);

	return (
		<div
			ref={props.panelRef}
			tabIndex={-1}
			data-timeline-panel
			className="outline-none flex flex-shrink-0 flex-col bg-transparent px-4 pb-4"
			style={{ height: "calc(22% + 8px)", minHeight: 188, maxHeight: 288 }}
		>
			<TimelineEditor
				zoomPresentationOptions={props.zoomPresentationOptions}
				ref={timelineRef}
				videoDuration={projection.timelineDuration}
				sourceDuration={projection.sourceDuration}
				playbackClock={playbackClock}
				currentTime={currentTime}
				playheadTime={projection.timelinePlayheadTime}
				onSeek={playback.handleTimelineSeek}
				videoPath={videoPath}
				videoSourcePath={videoSourcePath}
				cursorTelemetrySourcePath={cursorTelemetrySourcePath}
				cursorTelemetry={normalizedCursorTelemetry}
				zoomRegions={timeline.zoomRegions}
				onZoomAdded={zoomCommands.handleZoomAdded}
				onZoomSuggested={zoomCommands.handleZoomSuggested}
				onZoomSpanChange={zoomCommands.handleZoomSpanChange}
				onZoomDelete={zoomCommands.handleZoomDelete}
				selectedZoomId={timeline.selectedZoomId}
				onSelectZoom={zoomCommands.handleSelectZoom}
				trimRegions={timeline.trimRegions}
				clipRegions={timeline.clipRegions}
				onClipSplit={clipCommands.handleClipSplit}
				onClipMerge={clipCommands.handleClipMerge}
				canMergeClips={clipCommands.canMergeClips}
				onClipDelete={clipCommands.handleClipDelete}
				onClipSpanChange={clipCommands.handleClipSpanChange}
				selectedClipId={timeline.selectedClipId}
				onSelectClip={clipCommands.handleSelectClip}
				audioRegions={timeline.audioRegions}
				onAudioAdded={audioCommands.handleAudioAdded}
				onAudioSpanChange={audioCommands.handleAudioSpanChange}
				onAudioDelete={audioCommands.handleAudioDelete}
				selectedAudioId={timeline.selectedAudioId}
				onSelectAudio={audioCommands.handleSelectAudio}
				captionRegions={projection.effectiveCaptionRegions}
				onCaptionSpanChange={(id, span) => {
					const fragment = projection.effectiveCaptionRegions.find(
						(cue) => cue.id === id,
					);
					if (!fragment) return;
					captionCommands.handleCaptionRetime(
						fragment.sourceCueId,
						retimeCaptionFragment(fragment, span),
					);
				}}
				selectedCaptionId={selectedCaptionFragmentId}
				onSelectCaption={(id) => {
					const fragment = projection.effectiveCaptionRegions.find(
						(cue) => cue.id === id,
					);
					captionCommands.handleSelectCaption(fragment?.sourceCueId ?? null);
					if (fragment) playback.handleTimelineSeek(fragment.startMs / 1000);
				}}
				onCaptionDelete={(id) => {
					const fragment = projection.effectiveCaptionRegions.find(
						(cue) => cue.id === id,
					);
					if (fragment) captionCommands.handleCaptionDelete(fragment.sourceCueId);
				}}
				onCaptionAdded={captionCommands.handleCaptionAdded}
				captionsEnabled={timeline.autoCaptionSettings.enabled}
				captionQuickAddEnabled={timeline.autoCaptionSettings.timelineQuickAdd}
				annotationRegions={timeline.annotationRegions}
				onAnnotationAdded={(span, trackIndex, type, placement) =>
					annotationCommands.handleAnnotationAdded(
						span,
						trackIndex,
						type,
						placement ?? props.getAnnotationPlacement?.() ?? undefined,
					)
				}
				onAnnotationSpanChange={annotationCommands.handleAnnotationSpanChange}
				onAnnotationDelete={annotationCommands.handleAnnotationDelete}
				selectedAnnotationId={timeline.selectedAnnotationId}
				onSelectAnnotation={(id) => {
					handleSelectAnnotation(id);
					const region = timeline.annotationRegions.find((region) => region.id === id);
					const nowMs =
						(playbackClock ? playbackClock.getTimelineTime() : currentTime) * 1000;
					if (region && (nowMs < region.startMs || nowMs >= region.endMs)) {
						playback.handleTimelineSeek(
							(region.startMs + Math.min(1, (region.endMs - region.startMs) / 2)) /
								1000,
						);
					}
				}}
				showSourceAudioTrack={timeline.clipRegions.some((clip) => clip.showSourceAudio)}
				sourceAudioResourceVersion={timeline.sourceAudioFallbackRefreshKey}
				sourceAudioTrackSettings={audio.activeSourceAudioTrackSettings}
				getSourceAudioTrackSettingsForClip={audio.getSourceAudioTrackSettingsForClip}
				onSourceAudioAvailabilityChange={timeline.setHasClipSourceAudio}
				onSourceAudioTracksMetaChange={audio.onSourceAudioTracksMetaChange}
			/>
		</div>
	);
}
