import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { AdaptiveGlass } from "../adaptive-glass";
import { useTheme } from "../../theme/theme";

export interface TranslationLanguage {
  code: string;
  label: string;
}

/** Languages currently offered by Apple's system translation experience. */
export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
  { code: "ar", label: "Arabic" },
  { code: "zh-Hans", label: "Chinese, Simplified" },
  { code: "zh-Hant", label: "Chinese, Traditional" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "hi", label: "Hindi" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "ru", label: "Russian" },
  { code: "es", label: "Spanish" },
  { code: "th", label: "Thai" },
  { code: "tr", label: "Turkish" },
  { code: "uk", label: "Ukrainian" },
  { code: "vi", label: "Vietnamese" },
];

type ExpandedSelector = "source" | "target" | null;

export function languageLabel(code: string | null): string {
  if (code === null) return "Auto Detect";
  return (
    TRANSLATION_LANGUAGES.find((language) => language.code === code)?.label ??
    code
  );
}

export function LyricsLanguageSelector({
  sourceLanguage,
  targetLanguage,
  busy,
  error,
  actionLabel,
  onSourceChange,
  onTargetChange,
  onAction,
}: {
  sourceLanguage: string | null;
  targetLanguage: string | null;
  busy: boolean;
  error: string | null;
  actionLabel: string;
  onSourceChange: (language: string | null) => void;
  onTargetChange: (language: string) => void;
  onAction: () => void;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState<ExpandedSelector>(null);
  const sameLanguage =
    sourceLanguage !== null && sourceLanguage === targetLanguage;
  const actionDisabled = busy || targetLanguage === null || sameLanguage;
  const validationMessage = sameLanguage
    ? "Choose different input and output languages."
    : error;

  const toggleExpanded = (selector: Exclude<ExpandedSelector, null>) => {
    void Haptics.selectionAsync();
    setExpanded((current) => (current === selector ? null : selector));
  };

  return (
    <Animated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(120)}
    >
      <AdaptiveGlass style={styles.shell} interactive>
        <View style={styles.content}>
          <SelectorRow
            title="From"
            value={languageLabel(sourceLanguage)}
            expanded={expanded === "source"}
            onPress={() => toggleExpanded("source")}
          />
          {expanded === "source" ? (
            <LanguageOptions
              includeAutoDetect
              selected={sourceLanguage}
              onSelect={(language) => {
                void Haptics.selectionAsync();
                onSourceChange(language);
                setExpanded(null);
              }}
            />
          ) : null}

          <View
            style={[
              styles.separator,
              { backgroundColor: theme.color.separator },
            ]}
          />

          <SelectorRow
            title="To"
            value={
              targetLanguage === null
                ? "Select Language"
                : languageLabel(targetLanguage)
            }
            expanded={expanded === "target"}
            onPress={() => toggleExpanded("target")}
          />
          {expanded === "target" ? (
            <LanguageOptions
              selected={targetLanguage}
              onSelect={(language) => {
                if (language === null) return;
                void Haptics.selectionAsync();
                onTargetChange(language);
                setExpanded(null);
              }}
            />
          ) : null}

          {validationMessage ? (
            <Animated.Text
              entering={FadeIn.duration(140)}
              exiting={FadeOut.duration(100)}
              style={[styles.message, { color: theme.color.fgMuted }]}
            >
              {validationMessage}
            </Animated.Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            accessibilityState={{ busy, disabled: actionDisabled }}
            disabled={actionDisabled}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onAction();
            }}
            style={({ pressed }) => [
              styles.action,
              {
                backgroundColor: theme.color.overlayMuted,
                opacity: actionDisabled ? 0.38 : pressed ? 0.58 : 1,
              },
            ]}
          >
            {busy ? (
              <ActivityIndicator size="small" color={theme.color.fg} />
            ) : (
              <SymbolView
                name="translate"
                size={16}
                weight="semibold"
                tintColor={theme.color.fg}
              />
            )}
            <Text style={[styles.actionLabel, { color: theme.color.fg }]}>
              {busy ? "Translating…" : actionLabel}
            </Text>
          </Pressable>
        </View>
      </AdaptiveGlass>
    </Animated.View>
  );
}

function SelectorRow({
  title,
  value,
  expanded,
  onPress,
}: {
  title: string;
  value: string;
  expanded: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title} language, ${value}`}
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.selectorRow,
        { opacity: pressed ? 0.58 : 1 },
      ]}
    >
      <View style={styles.selectorText}>
        <Text
          style={[
            styles.selectorTitle,
            { color: theme.color.fg, fontWeight: expanded ? "700" : "500" },
          ]}
        >
          {title}
        </Text>
        <Text style={[styles.selectorValue, { color: theme.color.fgMuted }]}>
          {value}
        </Text>
      </View>
      <SymbolView
        name={expanded ? "chevron.down" : "chevron.right"}
        size={17}
        weight="semibold"
        tintColor={theme.color.fg}
      />
    </Pressable>
  );
}

function LanguageOptions({
  includeAutoDetect = false,
  selected,
  onSelect,
}: {
  includeAutoDetect?: boolean;
  selected: string | null;
  onSelect: (language: string | null) => void;
}) {
  const theme = useTheme();
  const options: readonly (
    TranslationLanguage | { code: null; label: string }
  )[] = includeAutoDetect
    ? [{ code: null, label: "Auto Detect" }, ...TRANSLATION_LANGUAGES]
    : TRANSLATION_LANGUAGES;

  return (
    <Animated.View
      entering={FadeIn.duration(140)}
      exiting={FadeOut.duration(100)}
    >
      <View
        style={[
          styles.optionsSeparator,
          { backgroundColor: theme.color.separator },
        ]}
      />
      <ScrollView
        nestedScrollEnabled
        showsVerticalScrollIndicator={false}
        style={styles.options}
      >
        {options.map((language) => {
          const isSelected = language.code === selected;
          return (
            <Pressable
              key={language.code ?? "auto"}
              accessibilityRole="radio"
              accessibilityLabel={language.label}
              accessibilityState={{ selected: isSelected }}
              onPress={() => onSelect(language.code)}
              style={({ pressed }) => [
                styles.option,
                { opacity: pressed ? 0.55 : 1 },
              ]}
            >
              <View style={styles.checkmarkSlot}>
                {isSelected ? (
                  <SymbolView
                    name="checkmark"
                    size={16}
                    weight="semibold"
                    tintColor={theme.color.fg}
                  />
                ) : null}
              </View>
              <Text style={[styles.optionLabel, { color: theme.color.fg }]}>
                {language.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shell: {
    borderRadius: 28,
    overflow: "hidden",
  },
  content: {
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  selectorRow: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  selectorText: {
    flex: 1,
    gap: 2,
  },
  selectorTitle: {
    fontSize: 17,
    lineHeight: 22,
    letterSpacing: -0.2,
  },
  selectorValue: {
    fontSize: 14,
    lineHeight: 19,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
  optionsSeparator: {
    height: StyleSheet.hairlineWidth,
    marginBottom: 6,
  },
  options: {
    maxHeight: 250,
  },
  option: {
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
  },
  checkmarkSlot: {
    width: 30,
    alignItems: "flex-start",
  },
  optionLabel: {
    flex: 1,
    fontSize: 16,
    lineHeight: 22,
  },
  message: {
    fontSize: 12,
    lineHeight: 17,
    paddingTop: 8,
  },
  action: {
    minHeight: 42,
    borderRadius: 21,
    marginTop: 10,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
  },
  actionLabel: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: "600",
  },
});
