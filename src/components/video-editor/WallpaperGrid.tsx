import { Button, ToggleButton } from "@heroui/react";
import { useEffect, useRef, useState } from "react";
import { DesktopIcon, Plus, VideoCamera, X } from "@/components/ui/icons";
import { useScopedT } from "@/contexts/I18nContext";
import { getRenderableVideoUrl } from "@/lib/assetPath";
import { isVideoWallpaperSource } from "@/lib/wallpapers";
import { WallpaperGlassGrid } from "./WallpaperGlassGrid";

interface WallpaperTile {
	key: string;
	value: string;
	previewUrl: string;
	label: string;
	removable?: boolean;
	disabled?: boolean;
	badge?: string;
}

const MAX_WALLPAPER_POSTER_CACHE = 32;
const WALLPAPER_POSTER_MAX_WIDTH = 160;
const videoWallpaperPosterCache = new Map<string, string>();

function getCachedVideoPoster(src: string): string | null {
	const existing = videoWallpaperPosterCache.get(src);
	if (!existing) return null;
	// Refresh insertion order for simple bounded LRU eviction.
	videoWallpaperPosterCache.delete(src);
	videoWallpaperPosterCache.set(src, existing);
	return existing;
}

function setCachedVideoPoster(src: string, dataUrl: string) {
	if (videoWallpaperPosterCache.has(src)) {
		videoWallpaperPosterCache.delete(src);
	}
	videoWallpaperPosterCache.set(src, dataUrl);
	while (videoWallpaperPosterCache.size > MAX_WALLPAPER_POSTER_CACHE) {
		const oldestKey = videoWallpaperPosterCache.keys().next().value;
		if (oldestKey === undefined) break;
		videoWallpaperPosterCache.delete(oldestKey);
	}
}

function captureVideoPosterFrame(video: HTMLVideoElement, cacheKey: string): string | null {
	if (video.videoWidth <= 0 || video.videoHeight <= 0) return null;
	const width = Math.min(WALLPAPER_POSTER_MAX_WIDTH, video.videoWidth);
	const height = Math.max(1, Math.round((video.videoHeight / video.videoWidth) * width));
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) return null;
	try {
		context.drawImage(video, 0, 0, width, height);
		const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
		if (!dataUrl || dataUrl === "data:,") return null;
		setCachedVideoPoster(cacheKey, dataUrl);
		return dataUrl;
	} catch {
		return null;
	}
}

/** Shared image/video gallery. Removal stays separate from the selection button. */
export function WallpaperGrid({
	items,
	addLabel,
	onAdd,
	onSelect,
	onRemove,
	isSelected,
}: {
	items: WallpaperTile[];
	addLabel: string;
	onAdd: () => void;
	onSelect: (value: string) => void;
	onRemove: (value: string) => void;
	isSelected: (value: string, previewUrl?: string) => boolean;
}) {
	const te = useScopedT("editing");
	return (
		<WallpaperGlassGrid>
			<Button
				variant="secondary"
				isIconOnly
				aria-label={addLabel}
				onPress={onAdd}
				className="wallpaper-upload-tile aspect-[4/3] h-auto w-full min-w-0 overflow-hidden rounded-md p-0 text-muted"
			>
				<Plus className="relative z-10 size-4" />
			</Button>
			{items.map((item) => {
				const selected = !item.disabled && isSelected(item.value, item.previewUrl);
				return (
					<div key={item.key} className="group relative flex min-w-0">
						<ToggleButton
							isSelected={selected}
							isDisabled={item.disabled}
							aria-label={item.label}
							onChange={() => onSelect(item.value)}
							className="wallpaper-tile relative aspect-[4/3] h-auto w-full min-w-0 overflow-hidden rounded-md p-0"
						>
							{isVideoWallpaperSource(item.previewUrl) ? (
								<WallpaperVideoPreview src={item.previewUrl} selected={selected} />
							) : item.previewUrl ? (
								<img
									src={item.previewUrl || undefined}
									alt=""
									loading="lazy"
									decoding="async"
									draggable={false}
									className="absolute inset-0 h-full w-full select-none object-cover"
								/>
							) : item.badge ? (
								<DesktopIcon className="size-4 text-muted" aria-hidden="true" />
							) : null}
						</ToggleButton>
						{item.removable && (
							<Button
								variant="secondary"
								isIconOnly
								aria-label={te("removeGradient", "Remove {{name}}", {
									name: item.label,
								})}
								onPress={() => onRemove(item.value)}
								className="absolute right-0.5 top-0.5 z-10 size-5 min-w-0 rounded-full p-0 bg-overlay text-foreground shadow-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
							>
								<X className="size-3" />
							</Button>
						)}
					</div>
				);
			})}
		</WallpaperGlassGrid>
	);
}

function WallpaperVideoPreview({ src, selected }: { src: string; selected: boolean }) {
	const [hovered, setHovered] = useState(false);
	const [resolvedSrc, setResolvedSrc] = useState(src);
	const [poster, setPoster] = useState<string | null>(() => getCachedVideoPoster(src));
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const active = selected || hovered;

	useEffect(() => {
		setPoster(getCachedVideoPoster(src));
	}, [src]);

	useEffect(() => {
		if (!active) return;
		let cancelled = false;
		setResolvedSrc(src);

		void (async () => {
			try {
				const nextSrc = await getRenderableVideoUrl(src);
				if (!cancelled) {
					setResolvedSrc(nextSrc);
				}
			} catch {
				if (!cancelled) {
					setResolvedSrc(src);
				}
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [active, src]);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		if (hovered) {
			void video.play().catch(() => undefined);
			return;
		}
		video.pause();
		if (video.currentTime !== 0) {
			try {
				video.currentTime = 0;
			} catch {
				// Ignore seek errors before metadata loads.
			}
		}
	}, [hovered, active, resolvedSrc]);

	return (
		<span
			className="absolute inset-0 block"
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			{active ? (
				<video
					ref={videoRef}
					src={resolvedSrc}
					poster={poster ?? undefined}
					muted
					playsInline
					preload="metadata"
					className="absolute inset-0 h-full w-full select-none object-cover"
					draggable={false}
					onLoadedData={(event) => {
						const video = event.currentTarget;
						if (!getCachedVideoPoster(src)) {
							const captured = captureVideoPosterFrame(video, src);
							if (captured) {
								setPoster(captured);
							}
						}
						if (hovered) {
							void video.play().catch(() => undefined);
						}
					}}
				/>
			) : poster ? (
				<img
					src={poster}
					alt=""
					loading="lazy"
					decoding="async"
					draggable={false}
					className="absolute inset-0 h-full w-full select-none object-cover"
				/>
			) : (
				<span className="flex h-full w-full items-center justify-center bg-default/40">
					<VideoCamera className="size-4 text-muted" aria-hidden="true" />
				</span>
			)}
		</span>
	);
}
