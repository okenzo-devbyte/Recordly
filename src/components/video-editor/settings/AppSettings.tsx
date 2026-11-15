import { Select as HeroSelect, Label, ListBox } from "@heroui/react";
import { AccountSettings } from "@/components/auth/AccountSettings";
import { ApplicationSettings } from "@/components/auth/ApplicationSettings";
import { RecordingPermissionsSettings } from "@/components/auth/RecordingPermissionsSettings";
import { ChoiceGroup, ChoiceItem } from "@/components/ui/choice-group";
import { LanguageFlag } from "@/components/ui/language-flag";
import { Switch } from "@/components/ui/switch";
import { SettingsRow } from "@/components/video-editor/SettingsRow";
import { SettingsCategory, SettingsSections } from "@/components/video-editor/SettingsSections";
import { useI18n } from "@/contexts/I18nContext";
import type { AppLocale } from "@/i18n/config";
import { SUPPORTED_LOCALES } from "@/i18n/config";
import type {
	CaptureFpsOption,
	CaptureMaxResolution,
	PerformanceMode,
	ResolvedPerformanceTier,
} from "@/shared/performanceProfile";

import { DeveloperMotionSettings, developerMotionSettingsKeys } from "./DeveloperMotionSettings";
import { MotionPresetCards } from "./MotionPresetCards";
import { ShortcutsSettingsSection } from "./ShortcutsSettingsSection";
import { SectionLabel } from "./SettingsSectionLabel";
import type { ResolvedSettingsPanelProps } from "./settingsPanelDefaults";
import { pickSettingsProps } from "./settingsPanelDefaults";
import type { useAppSettings } from "./useAppSettings";
import { useSettingsTranslations } from "./useSettingsTranslations";

const APP_LANGUAGE_LABELS: Record<AppLocale, string> = {
	en: "English",
	es: "Español",
	fr: "Français",
	de: "Deutsch",
	it: "Italiano",
	nl: "Nederlands",
	ko: "한국어",
	ja: "日本語",
	"pt-BR": "Português (Brasil)",
	"zh-CN": "简体中文",
	"zh-TW": "繁體中文",
	th: "ภาษาไทย",
};

export const appSettingsKeys = [
	"accountUser",
	"onShowOnboarding",
	"hideAppearance",
	"advanced",
	"connectZooms",
	"onConnectZoomsChange",
	"autoApplyFreshRecordingAutoZooms",
	"onAutoApplyFreshRecordingAutoZoomsChange",
] as const;
type Props = Pick<ResolvedSettingsPanelProps, (typeof appSettingsKeys)[number]> &
	Pick<ResolvedSettingsPanelProps, (typeof developerMotionSettingsKeys)[number]> & {
		app: ReturnType<typeof useAppSettings>;
	};
export function AppSettings(props: Props) {
	const {
		accountUser,
		onShowOnboarding,
		hideAppearance,
		advanced,
		connectZooms,
		onConnectZoomsChange,
		autoApplyFreshRecordingAutoZooms,
		onAutoApplyFreshRecordingAutoZoomsChange,
	} = props;
	const { tSettings, t } = useSettingsTranslations();
	const {
		experimentalUpdatesEnabled,
		savingExperimentalUpdates,
		updateExperimentalUpdatesPreference,
		performanceBudget,
		savingPerformancePreferences,
		updatePerformancePreferencesState,
		activeMotionPresetId,
		applyMotionPreset,
		themePreference,
		setThemePreference,
	} = props.app;
	const { locale, setLocale } = useI18n();
	const showDevMotionControls = import.meta.env.DEV;
	const { hardware, preferences } = performanceBudget;
	const recommendedTier = hardware?.recommendedTier ?? "balanced";
	const tierLabels: Record<ResolvedPerformanceTier, string> = {
		low: tSettings("performance.tiers.low", "Eco"),
		balanced: tSettings("performance.tiers.balanced", "Balanced"),
		high: tSettings("performance.tiers.high", "High"),
	};
	const modeLabels: Record<PerformanceMode, string> = {
		auto: tSettings("performance.modes.auto", "Auto ({{tier}})", {
			tier: tierLabels[recommendedTier],
		}),
		low: tSettings("performance.modes.low", "Eco (Low-spec)"),
		balanced: tSettings("performance.modes.balanced", "Balanced"),
		high: tSettings("performance.modes.high", "High quality"),
	};
	const hardwareSummary = hardware
		? tSettings(
				"performance.hardwareSummary",
				"{{cores}} cores · {{memory}} GB RAM · {{encoder}}",
				{
					cores: String(hardware.logicalProcessors),
					memory: String(hardware.totalMemoryGb),
					encoder: hardware.hasHardwareEncoder
						? tSettings("performance.hwEncoderReady", "HW encoder ready")
						: tSettings("performance.cpuEncoderOnly", "CPU encoder fallback"),
				},
			)
		: null;
	return (
		<SettingsSections
			categories={
				advanced
					? [
							"general",
							"shortcuts",
							"account",
							"permissions",
							"motion",
							"updates",
							...(showDevMotionControls ? ["developer" as const] : []),
						]
					: ["general", "shortcuts", "account", "permissions", "motion"]
			}
		>
			<SettingsCategory category="account">
				<AccountSettings key={accountUser?.id ?? "signed-out"} user={accountUser} />
			</SettingsCategory>
			<SettingsCategory category={["permissions", "recording"]}>
				<RecordingPermissionsSettings
					onReview={onShowOnboarding ? () => onShowOnboarding() : undefined}
				/>
			</SettingsCategory>
			<SettingsCategory category="general">
				{!hideAppearance && (
					<SettingsRow title={t("editor.theme.appearance", "Appearance")} stacked>
						<ChoiceGroup
							type="single"
							aria-label={t("editor.theme.appearance", "Appearance")}
							value={themePreference}
							onValueChange={(value) => {
								if (value === "light" || value === "dark" || value === "system")
									setThemePreference(value);
							}}
							fullWidth
							size="sm"
						>
							<ChoiceItem value="light" className="flex-1">
								{t("editor.theme.light", "Light")}
							</ChoiceItem>
							<ChoiceItem value="dark" className="flex-1">
								{t("editor.theme.dark", "Dark")}
							</ChoiceItem>
							<ChoiceItem value="system" className="flex-1">
								{t("editor.theme.system", "System")}
							</ChoiceItem>
						</ChoiceGroup>
					</SettingsRow>
				)}

				<HeroSelect
					variant="secondary"
					aria-label={t("common.app.language", "Language")}
					value={locale}
					onChange={(key) => {
						const nextLocale = String(key) as AppLocale;
						if (SUPPORTED_LOCALES.includes(nextLocale)) setLocale(nextLocale);
					}}
					className="settings-language-field settings-group"
				>
					<SettingsRow
						title={t("common.app.language", "Language")}
						description={t(
							"settings.appPreferences.languageDescription",
							"Choose the language used throughout Recordly.",
						)}
					>
						<HeroSelect.Trigger className="settings-language-trigger h-9 w-full text-sm">
							<HeroSelect.Value>
								<span className="flex min-w-0 items-center gap-2">
									<LanguageFlag locale={locale} />
									<span className="truncate">{APP_LANGUAGE_LABELS[locale]}</span>
								</span>
							</HeroSelect.Value>
							<HeroSelect.Indicator />
						</HeroSelect.Trigger>
					</SettingsRow>
					<HeroSelect.Popover className="settings-language-popover max-h-80">
						<ListBox>
							{SUPPORTED_LOCALES.map((candidateLocale) => (
								<ListBox.Item
									key={candidateLocale}
									id={candidateLocale}
									textValue={APP_LANGUAGE_LABELS[candidateLocale]}
								>
									<LanguageFlag locale={candidateLocale} />
									<Label>{APP_LANGUAGE_LABELS[candidateLocale]}</Label>
									<ListBox.ItemIndicator />
								</ListBox.Item>
							))}
						</ListBox>
					</HeroSelect.Popover>
				</HeroSelect>

				<section className="space-y-3" aria-label={tSettings("performance.title", "Performance")}>
					<header className="dashboard-settings-group dashboard-settings-subgroup">
						<h2>{tSettings("performance.title", "Performance")}</h2>
						{hardwareSummary && (
							<p className="text-xs text-muted">
								{hardwareSummary} ·{" "}
								{tSettings("performance.recommendedLabel", "Recommended: {{tier}}", {
									tier: tierLabels[recommendedTier],
								})}
							</p>
						)}
					</header>
					<div className="settings-group space-y-3">
						<HeroSelect
							variant="secondary"
							aria-label={tSettings("performance.mode", "Performance mode")}
							value={preferences.performanceMode}
							isDisabled={savingPerformancePreferences}
							onChange={(key) => {
								const nextMode = String(key) as PerformanceMode;
								if (
									nextMode === "auto" ||
									nextMode === "low" ||
									nextMode === "balanced" ||
									nextMode === "high"
								) {
									void updatePerformancePreferencesState({ performanceMode: nextMode });
								}
							}}
						>
							<SettingsRow
								title={tSettings("performance.mode", "Performance mode")}
								description={tSettings(
									"performance.modeDescription",
									"Adjust capture, preview, and export resource usage automatically or lock a quality preset.",
								)}
							>
								<HeroSelect.Trigger className="h-9 min-w-[168px] text-sm">
									<HeroSelect.Value>
										<span className="truncate">
											{modeLabels[preferences.performanceMode]}
										</span>
									</HeroSelect.Value>
									<HeroSelect.Indicator />
								</HeroSelect.Trigger>
							</SettingsRow>
							<HeroSelect.Popover className="max-h-72">
								<ListBox>
									{(["auto", "low", "balanced", "high"] as const).map((mode) => (
										<ListBox.Item key={mode} id={mode} textValue={modeLabels[mode]}>
											<Label>{modeLabels[mode]}</Label>
											<ListBox.ItemIndicator />
										</ListBox.Item>
									))}
								</ListBox>
							</HeroSelect.Popover>
						</HeroSelect>

						<SettingsRow
							title={tSettings("performance.captureResolution", "Capture resolution")}
							description={tSettings(
								"performance.captureResolutionDescription",
								"Cap screen recording resolution to reduce CPU, memory, and disk usage on lighter PCs.",
							)}
						>
							<ChoiceGroup
								type="single"
								aria-label={tSettings(
									"performance.captureResolution",
									"Capture resolution",
								)}
								value={preferences.captureMaxResolution}
								onValueChange={(value) => {
									if (value === "auto" || value === "1080p" || value === "native") {
										void updatePerformancePreferencesState({
											captureMaxResolution: value as CaptureMaxResolution,
										});
									}
								}}
								size="sm"
							>
								<ChoiceItem value="auto">
									{tSettings("performance.resolutions.auto", "Auto")}
								</ChoiceItem>
								<ChoiceItem value="1080p">
									{tSettings("performance.resolutions.1080p", "1080p")}
								</ChoiceItem>
								<ChoiceItem value="native">
									{tSettings("performance.resolutions.native", "Native")}
								</ChoiceItem>
							</ChoiceGroup>
						</SettingsRow>

						<SettingsRow
							title={tSettings("performance.captureFps", "Capture FPS")}
							description={tSettings(
								"performance.captureFpsDescription",
								"Use 30 FPS for smoother multitasking on 4–8 core machines or 60 FPS for maximum motion clarity.",
							)}
						>
							<ChoiceGroup
								type="single"
								aria-label={tSettings("performance.captureFps", "Capture FPS")}
								value={String(preferences.captureFps)}
								onValueChange={(value) => {
									const nextFps: CaptureFpsOption | null =
										value === "auto"
											? "auto"
											: value === "30"
												? 30
												: value === "60"
													? 60
													: null;
									if (nextFps !== null) {
										void updatePerformancePreferencesState({
											captureFps: nextFps,
										});
									}
								}}
								size="sm"
							>
								<ChoiceItem value="auto">
									{tSettings("performance.fpsOptions.auto", "Auto")}
								</ChoiceItem>
								<ChoiceItem value="30">
									{tSettings("performance.fpsOptions.30", "30 FPS")}
								</ChoiceItem>
								<ChoiceItem value="60">
									{tSettings("performance.fpsOptions.60", "60 FPS")}
								</ChoiceItem>
							</ChoiceGroup>
						</SettingsRow>
					</div>
				</section>

				<ApplicationSettings />
			</SettingsCategory>
			<SettingsCategory category="updates">
				{advanced && (
					<section className="flex flex-col gap-4">
						<SectionLabel>{tSettings("updates.title", "Updates")}</SectionLabel>
						<SettingsRow
							title={tSettings("updates.experimental", "Experimental updates")}
							description={tSettings(
								"updates.experimentalDescription",
								"This is the front line of user testing - highly experimental so expect bugs",
							)}
						>
							<Switch
								checked={experimentalUpdatesEnabled}
								disabled={savingExperimentalUpdates}
								onCheckedChange={(enabled) =>
									void updateExperimentalUpdatesPreference(enabled)
								}
								aria-label={tSettings(
									"updates.experimental",
									"Experimental updates",
								)}
							/>
						</SettingsRow>
					</section>
				)}
			</SettingsCategory>
			<SettingsCategory category="motion">
				<section className="flex flex-col gap-6">
					<div className="settings-group">
						<SettingsRow
							title={tSettings("appPreferences.autoZoom", "Automatically add zooms")}
							description={tSettings(
								"appPreferences.autoZoomDescription",
								"Add zooms on new recordings. Turning this off won't remove existing zooms.",
							)}
						>
							<Switch
								aria-label={tSettings(
									"appPreferences.autoZoom",
									"Automatically add zooms",
								)}
								checked={autoApplyFreshRecordingAutoZooms}
								onCheckedChange={onAutoApplyFreshRecordingAutoZoomsChange}
							/>
						</SettingsRow>
						<SettingsRow
							title={tSettings("effects.connectZooms", "Connect neighboring zooms")}
							description={tSettings(
								"effects.connectZoomsDescription",
								"Smooth consecutive zoom regions into a continuous camera move.",
							)}
						>
							<Switch
								aria-label={tSettings(
									"effects.connectZooms",
									"Connect neighboring zooms",
								)}
								checked={connectZooms}
								onCheckedChange={onConnectZoomsChange}
							/>
						</SettingsRow>
					</div>
				</section>

				<section className="flex flex-col gap-4">
					<p className="text-xs leading-relaxed text-muted">
						{tSettings(
							"appPreferences.motionPresetScope",
							"Applying a preset replaces zoom timing, cursor size, smoothing and click bounce. Preview each movement below.",
						)}
					</p>
					<MotionPresetCards
						title={tSettings("effects.motionPresetsTitle", "Presets")}
						activePresetId={activeMotionPresetId}
						onApply={applyMotionPreset}
						tSettings={tSettings}
					/>
				</section>
			</SettingsCategory>
			<SettingsCategory category="shortcuts">
				<ShortcutsSettingsSection />
			</SettingsCategory>
			<SettingsCategory category="developer">
				<DeveloperMotionSettings
					{...pickSettingsProps(props, developerMotionSettingsKeys)}
				/>
			</SettingsCategory>
		</SettingsSections>
	);
}
