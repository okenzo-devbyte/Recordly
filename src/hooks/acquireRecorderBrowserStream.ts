import { translate } from "@/i18n/runtime";
import { ensurePerformanceProfileLoaded } from "@/lib/performanceProfileStore";
import { acquireBrowserScreenCapture } from "./browserScreenCapture";
import {
	CHROME_MEDIA_SOURCE,
	getCaptureBudget,
	MIC_GAIN_BOOST,
	resolveBrowserCaptureCursorPolicy,
} from "./recorderCaptureOptions";
import type { RecorderContext } from "./recorderContext";
import { createProcessedMicrophoneConstraints } from "./recordingMicrophoneFallback";

type DesktopCaptureMediaDevices = {
	getUserMedia: (constraints: unknown) => Promise<MediaStream>;
	getDisplayMedia: (constraints: unknown) => Promise<MediaStream>;
};

export async function acquireRecorderBrowserStream(
	context: Pick<
		RecorderContext,
		| "hideEditorOverlayCursorByDefault"
		| "microphoneEnabled"
		| "systemAudioEnabled"
		| "resolveBrowserCaptureSource"
		| "screenStream"
		| "stream"
		| "microphoneStream"
		| "microphoneDeviceId"
		| "browserMicrophoneProfile"
		| "setMicrophoneEnabled"
		| "mixingContext"
	>,
	{
		selectedSource,
		nativeWindowsCaptureStartFailed,
		onPortalCapture,
	}: {
		selectedSource: ProcessedDesktopSource;
		nativeWindowsCaptureStartFailed: boolean;
		onPortalCapture: (usingPortal: boolean) => void;
	},
) {
	const {
		hideEditorOverlayCursorByDefault,
		microphoneEnabled,
		systemAudioEnabled,
		resolveBrowserCaptureSource,
		screenStream,
		stream,
		microphoneStream,
		microphoneDeviceId,
		browserMicrophoneProfile,
		setMicrophoneEnabled,
		mixingContext,
	} = context;

	const budget = await ensurePerformanceProfileLoaded();
	const captureBudget = getCaptureBudget(budget);

	const browserCursorPolicy = resolveBrowserCaptureCursorPolicy({
		nativeWindowsCaptureStartFailed,
	});
	hideEditorOverlayCursorByDefault.current = browserCursorPolicy.hideEditorOverlayCursorByDefault;

	const wantsAudioCapture = microphoneEnabled || systemAudioEnabled;
	const browserCaptureSource = await resolveBrowserCaptureSource(selectedSource);

	if (
		browserCaptureSource?.id?.startsWith("screen:fallback:") ||
		browserCaptureSource?.id?.startsWith("window:fallback:")
	) {
		throw new Error("Selected display is not available for browser capture on this system.");
	}

	if (browserCursorPolicy.hideOsCursorBeforeRecording) {
		try {
			const hideCursorResult = await window.electronAPI.hideOsCursor?.();
			if (hideCursorResult && !hideCursorResult.success) {
				console.warn("Could not hide OS cursor before recording.", hideCursorResult);
			}
		} catch {
			console.warn("Could not hide OS cursor before recording.");
		}
	}

	let videoTrack: MediaStreamTrack | undefined;
	let systemAudioIncluded = false;
	const mediaDevices = navigator.mediaDevices as DesktopCaptureMediaDevices;
	const useLinuxPortal = selectedSource.id === "screen:linux-portal";
	onPortalCapture(useLinuxPortal);
	const browserScreenVideoConstraints = {
		mandatory: {
			chromeMediaSource: CHROME_MEDIA_SOURCE,
			chromeMediaSourceId: browserCaptureSource.id,
			maxWidth: captureBudget.maxWidth,
			maxHeight: captureBudget.maxHeight,
			maxFrameRate: captureBudget.fps,
			minFrameRate: captureBudget.minFrameRate,
			googCaptureCursor: browserCursorPolicy.streamCursor === "always",
		},
		cursor: browserCursorPolicy.streamCursor,
	};

	if (wantsAudioCapture) {
		let screenMediaStream: MediaStream;
		const acquireLinuxPortalStream = (withAudio: boolean) =>
			mediaDevices.getDisplayMedia({
				audio: withAudio,
				video: {
					displaySurface: "monitor",
					width: { ideal: captureBudget.maxWidth, max: captureBudget.maxWidth },
					height: { ideal: captureBudget.maxHeight, max: captureBudget.maxHeight },
					frameRate: { ideal: captureBudget.fps, max: captureBudget.fps },
					cursor: browserCursorPolicy.streamCursor,
				},
				selfBrowserSurface: "exclude",
				surfaceSwitching: "exclude",
			});

		screenMediaStream = await acquireBrowserScreenCapture({
			audio: systemAudioEnabled,
			usePortal: useLinuxPortal,
			request: (audio) =>
				useLinuxPortal
					? acquireLinuxPortalStream(audio)
					: mediaDevices.getUserMedia({
							audio: audio
								? {
										mandatory: {
											chromeMediaSource: CHROME_MEDIA_SOURCE,
											chromeMediaSourceId: browserCaptureSource.id,
										},
									}
								: false,
							video: browserScreenVideoConstraints,
						}),
			onAudioFallback: () => {
				alert(
					translate(
						"notifications.systemAudioUnavailable",
						"System audio is not available for this source. Recording will continue without system audio.",
					),
				);
			},
		});

		screenStream.current = screenMediaStream;
		stream.current = new MediaStream();

		videoTrack = screenMediaStream.getVideoTracks()[0];
		if (!videoTrack) {
			throw new Error("Video track is not available.");
		}

		stream.current.addTrack(videoTrack);

		if (microphoneEnabled) {
			try {
				microphoneStream.current = await navigator.mediaDevices.getUserMedia(
					createProcessedMicrophoneConstraints(
						microphoneDeviceId,
						browserMicrophoneProfile.current,
					),
				);
			} catch (audioError) {
				console.warn("Failed to get microphone access:", audioError);
				alert(
					translate(
						"notifications.microphoneDenied",
						"Microphone permission denied. Recording will continue without microphone audio.",
					),
				);
				setMicrophoneEnabled(false);
			}
		}

		const systemAudioTrack = screenMediaStream.getAudioTracks()[0];
		const micAudioTrack = microphoneStream.current?.getAudioTracks()[0];

		if (systemAudioTrack && micAudioTrack) {
			const context = new AudioContext({ sampleRate: 48000 });
			mixingContext.current = context;
			const systemSource = context.createMediaStreamSource(
				new MediaStream([systemAudioTrack]),
			);
			const micSource = context.createMediaStreamSource(new MediaStream([micAudioTrack]));
			const micGain = context.createGain();
			micGain.gain.value = MIC_GAIN_BOOST;
			const destination = context.createMediaStreamDestination();

			systemSource.connect(destination);
			micSource.connect(micGain).connect(destination);

			const mixedTrack = destination.stream.getAudioTracks()[0];
			if (mixedTrack) {
				stream.current.addTrack(mixedTrack);
				systemAudioIncluded = true;
			}
		} else if (systemAudioTrack) {
			stream.current.addTrack(systemAudioTrack);
			systemAudioIncluded = true;
		} else if (micAudioTrack) {
			stream.current.addTrack(micAudioTrack);
		}
	} else {
		const mediaStream = useLinuxPortal
			? await mediaDevices.getDisplayMedia({
					audio: false,
					video: {
						displaySurface: selectedSource.id?.startsWith("window:")
							? "window"
							: "monitor",
						width: { ideal: captureBudget.maxWidth, max: captureBudget.maxWidth },
						height: { ideal: captureBudget.maxHeight, max: captureBudget.maxHeight },
						frameRate: { ideal: captureBudget.fps, max: captureBudget.fps },
						cursor: browserCursorPolicy.streamCursor,
					},
					selfBrowserSurface: "exclude",
					surfaceSwitching: "exclude",
				})
			: await mediaDevices.getUserMedia({
					audio: false,
					video: browserScreenVideoConstraints,
				});

		stream.current = mediaStream;
		videoTrack = mediaStream.getVideoTracks()[0];
	}

	if (!stream.current || !videoTrack) {
		throw new Error("Media stream is not available.");
	}

	try {
		await videoTrack.applyConstraints({
			frameRate: { ideal: captureBudget.fps, max: captureBudget.fps },
			width: { ideal: captureBudget.maxWidth, max: captureBudget.maxWidth },
			height: { ideal: captureBudget.maxHeight, max: captureBudget.maxHeight },
		} as MediaTrackConstraints);
	} catch (error) {
		console.warn(
			"Unable to lock capture constraints, using best available track settings.",
			error,
		);
	}

	return { videoTrack, systemAudioIncluded };
}
