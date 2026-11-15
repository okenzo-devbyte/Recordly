import type { VideoExporterConfig } from "./modernVideoExporterConfig";

import { NativeStaticLayoutBackgroundAssets } from "./nativeStaticLayoutBackground";

/** Owns native IPC sessions, browser H.264 input and readback resources. */
export class ModernNativeResources {
	nativeBackgroundAssets: NativeStaticLayoutBackgroundAssets;
	nativeExportSessionId: string | null = null;
	nativeStaticLayoutSessionId: string | null = null;
	lastNativeExportError: string | null = null;
	nativeStaticLayoutSkipReason: string | null = null;
	nativeStaticLayoutSkipReasons: string[] = [];
	nativeStaticLayoutBackgroundSkipReason: string | null = null;
	nativeH264Encoder: VideoEncoder | null = null;
	nativeInputMode: "rawvideo" | "h264-stream" | null = null;
	forceRawvideoNativeRetry = false;
	nativeOutputChunkCount = 0;
	nativeReadbackCanvas: HTMLCanvasElement | null = null;
	nativeReadbackBufferPool: Uint8Array[] = [];
	nativeEncoderError: Error | null = null;
	constructor(config: VideoExporterConfig) {
		this.nativeBackgroundAssets = new NativeStaticLayoutBackgroundAssets(config);
	}
	acquireReadbackBuffer(byteLength: number): Uint8Array {
		while (this.nativeReadbackBufferPool.length > 0) {
			const candidate = this.nativeReadbackBufferPool.pop()!;
			if (candidate.byteLength === byteLength) {
				return candidate;
			}
		}
		return new Uint8Array(byteLength);
	}
	releaseReadbackBuffer(buffer: Uint8Array): void {
		if (this.nativeInputMode !== "rawvideo") {
			return;
		}
		if (this.nativeReadbackBufferPool.length < 12) {
			this.nativeReadbackBufferPool.push(buffer);
		}
	}
	disposeEncoder(): void {
		this.nativeInputMode = null;
		this.nativeOutputChunkCount = 0;
		this.nativeReadbackCanvas = null;
		this.nativeReadbackBufferPool = [];
		if (!this.nativeH264Encoder) {
			return;
		}

		try {
			this.nativeH264Encoder.ondequeue = null;
			this.nativeH264Encoder.close();
		} catch (error) {
			console.debug("[VideoExporter] Ignoring error closing native H.264 encoder:", error);
		}

		this.nativeH264Encoder = null;
	}
	cancel(): void {
		this.disposeEncoder();

		const nativeExportSessionId = this.nativeExportSessionId;
		this.nativeExportSessionId = null;
		if (nativeExportSessionId && typeof window !== "undefined") {
			void window.electronAPI?.nativeVideoExportCancel?.(nativeExportSessionId);
		}

		const nativeStaticLayoutSessionId = this.nativeStaticLayoutSessionId;
		this.nativeStaticLayoutSessionId = null;
		if (nativeStaticLayoutSessionId && typeof window !== "undefined") {
			void window.electronAPI?.nativeStaticLayoutExportCancel?.(nativeStaticLayoutSessionId);
		}
	}
	cleanup(): void {
		this.disposeEncoder();
		this.lastNativeExportError = null;

		const nativeExportSessionId = this.nativeExportSessionId;
		this.nativeExportSessionId = null;
		if (nativeExportSessionId && typeof window !== "undefined") {
			void window.electronAPI?.nativeVideoExportCancel?.(nativeExportSessionId);
		}
	}
}
