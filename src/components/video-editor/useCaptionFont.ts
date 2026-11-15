import { useEffect, useState } from "react";
import {
	ensureCaptionFontLoaded,
	ensureCaptionThaiFallbackLoaded,
	getCaptionFontFamily,
	withCaptionThaiFallback,
} from "./captionFonts";
import type { AutoCaptionSettings } from "./types";

export function useCaptionFont(
	settings?: Pick<AutoCaptionSettings, "style" | "fontFamily"> & { language?: string },
	hasThaiText = false,
) {
	const baseFontFamily = getCaptionFontFamily(settings);
	const needsBundledFont = settings?.style === "tiktok";
	const needsThaiFallback = hasThaiText || settings?.language === "th";
	const fontFamily = needsThaiFallback
		? withCaptionThaiFallback(baseFontFamily, "ก")
		: baseFontFamily;
	const [readyFamily, setReadyFamily] = useState<string | null>(null);
	const [thaiReady, setThaiReady] = useState<boolean>(() => !needsThaiFallback);
	useEffect(() => {
		if (!needsBundledFont) return;
		let active = true;
		void ensureCaptionFontLoaded({ style: "tiktok", fontFamily: baseFontFamily })
			.then(() => {
				if (active) setReadyFamily(baseFontFamily);
			})
			.catch((error: unknown) => console.warn("Unable to load bundled caption font", error));
		return () => {
			active = false;
		};
	}, [baseFontFamily, needsBundledFont]);
	useEffect(() => {
		if (!needsThaiFallback) {
			setThaiReady(true);
			return;
		}
		let active = true;
		void ensureCaptionThaiFallbackLoaded()
			.then(() => {
				if (active) setThaiReady(true);
			})
			.catch((error: unknown) => {
				console.warn("Unable to load Noto Sans Thai caption font", error);
				if (active) setThaiReady(true);
			});
		return () => {
			active = false;
		};
	}, [needsThaiFallback]);
	return {
		fontFamily,
		ready: (!needsBundledFont || readyFamily === baseFontFamily) && (!needsThaiFallback || thaiReady),
	};
}
