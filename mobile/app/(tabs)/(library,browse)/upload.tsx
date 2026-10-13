import { useState } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import * as DocumentPicker from "expo-document-picker";
import * as Haptics from "expo-haptics";
import {
  api,
  defaultUploadScope,
  errorMessage,
  isUploadableFile,
  libraryChanged,
  planUploadBatches,
  pluralize,
  summarizeUploadResults,
  tooLargeUploadResult,
  uploadAddedAny,
  uploadResultStatus,
  uploadScope,
  uploadStatusLabel,
  uploadSummaryLabel,
  useAuth,
  type UploadResult,
  type UploadScope,
} from "@music-library/core";
import { SegmentedControl } from "../../../components/segmented-control";
import { PrimaryButton } from "../../../components/buttons";
import { EmptyState } from "../../../components/empty-state";
import { FormField } from "../../../components/form-field";
import { useBottomDockInset } from "../../../components/dock/dock-context";
import { formatBytes } from "../../../lib/format";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

interface PickedFile {
  uri: string;
  name: string;
  type: string;
  size?: number;
}

/**
 * Mobile upload screen. Pick audio files with the system document picker,
 * pick a scope (admins only; the shared library by default, as on the web),
 * and upload them through the shared API client as RN-style
 * `{ uri, name, type }` multipart parts.
 */
export default function UploadScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { me } = useAuth();
  const dockInset = useBottomDockInset();

  const isAdmin = me?.role === "admin";
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [chosenScope, setScope] = useState<UploadScope>(() => defaultUploadScope(isAdmin));
  const scope = uploadScope(isAdmin, chosenScope);
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pickFiles = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["audio/*"],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      // The picker offers any audio, but the server only imports some
      // formats; leave the rest out here rather than send them to be skipped.
      const picked: PickedFile[] = res.assets
        .filter((a) => isUploadableFile(a.name))
        .map((a) => ({
          uri: a.uri,
          name: a.name,
          type: a.mimeType ?? "audio/mpeg",
          size: a.size,
        }));
      const unsupported = res.assets
        .filter((a) => !isUploadableFile(a.name))
        .map((a) => a.name);
      void Haptics.selectionAsync();
      setFiles((prev) => dedupeByUri([...prev, ...picked]));
      setResults(null);
      setError(unsupported.length ? unsupportedFilesMessage(unsupported) : null);
    } catch {
      setError("Couldn't open the file picker.");
    }
  };

  const clearFiles = () => {
    setFiles([]);
    setResults(null);
    setError(null);
  };

  const onUpload = async () => {
    if (files.length === 0 || uploading) return;
    setUploading(true);
    setError(null);
    // The server refuses a request over its size cap whole, so the files go
    // in as many requests as it takes, one after another. A file too large
    // to go even alone isn't sent, and shows as failed.
    const { batches, tooLarge } = planUploadBatches(files, (file) => file.size);
    const uploaded: UploadResult[] = [];
    let sent = 0;
    let failure: string | null = null;
    for (const batch of batches) {
      try {
        uploaded.push(
          ...(await api.uploadMusic(
            batch.map(({ uri, name, type }) => ({ uri, name, type })),
            scope,
          )),
        );
        sent += batch.length;
      } catch (err) {
        failure = errorMessage(err, "Couldn't reach the server.") || "Upload failed.";
        break;
      }
    }
    setUploading(false);
    if (failure && sent === 0) {
      // Nothing went in: keep the selection to try again.
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(failure);
      return;
    }
    const combined = [...uploaded];
    if (failure) {
      // Files after the failed request were never sent; they fail with its error.
      for (const file of batches.flat().slice(sent)) {
        combined.push({ file: file.name, inserted: false, error: failure });
      }
    }
    combined.push(...tooLarge.map((file) => tooLargeUploadResult(file.name)));
    setResults(combined);
    setError(failure);
    // The root layout's libraryChanged subscriber invalidates the browse
    // lists and user-scoped queries, so emitting is the whole refresh.
    // Duplicates, skips and failures leave the library as it was.
    if (uploadAddedAny(combined)) libraryChanged.emit();
    void Haptics.notificationAsync(
      failure
        ? Haptics.NotificationFeedbackType.Error
        : Haptics.NotificationFeedbackType.Success,
    );
  };

  const confirmAndUpload = () => {
    if (scope === "global") {
      Alert.alert(
        "Upload to global library?",
        "These files will be added to everyone's library.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Upload", onPress: () => void onUpload() },
        ],
      );
    } else {
      void onUpload();
    }
  };

  const summary = results ? summarizeUploadResults(results) : null;

  return (
    <>
      <Stack.Screen options={{ title: "Upload", headerLargeTitle: false }} />
      <FlatList
        data={results ?? files}
        keyExtractor={(_, i) => String(i)}
        renderItem={
          results
            ? ({ item }: ListRenderItemInfo<UploadResult | PickedFile>) => (
                <ResultRow result={item as UploadResult} theme={theme} />
              )
            : ({ item }: ListRenderItemInfo<UploadResult | PickedFile>) => (
                <PickedFileRow file={item as PickedFile} theme={theme} />
              )
        }
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.color.bg }}
        contentContainerStyle={{
          padding: theme.space.lg,
          gap: 6,
          paddingBottom: dockInset + 32,
        }}
        ListHeaderComponent={
          <View style={{ gap: theme.space.lg, marginBottom: theme.space.md }}>
            {isAdmin ? (
              <FormField
                label="Scope"
                hint={
                  scope === "personal"
                    ? "Adds to your personal library only."
                    : "Adds to every user's library."
                }
              >
                <SegmentedControl<UploadScope>
                  options={[
                    { label: "Personal", value: "personal" },
                    { label: "Global", value: "global" },
                  ]}
                  value={scope}
                  onChange={setScope}
                />
              </FormField>
            ) : null}

            <View style={{ flexDirection: "row", gap: theme.space.md }}>
              <Pressable
                onPress={pickFiles}
                disabled={uploading}
                style={({ pressed }) => ({
                  flex: 1,
                  backgroundColor: theme.color.bgElev1,
                  borderRadius: theme.radius.md,
                  paddingVertical: 14,
                  alignItems: "center",
                  opacity: uploading ? 0.5 : pressed ? 0.8 : 1,
                  borderCurve: "continuous",
                })}
                accessibilityRole="button"
                accessibilityLabel="Pick audio files"
              >
                <Text
                  style={{ color: theme.color.fg, fontSize: 15, fontWeight: "500" }}
                >
                  {files.length === 0 ? "Pick files" : "Add more"}
                </Text>
              </Pressable>
              {files.length > 0 && !results ? (
                <Pressable
                  onPress={clearFiles}
                  disabled={uploading}
                  style={({ pressed }) => ({
                    paddingHorizontal: 16,
                    backgroundColor: theme.color.bgElev1,
                    borderRadius: theme.radius.md,
                    justifyContent: "center",
                    opacity: uploading ? 0.5 : pressed ? 0.8 : 1,
                    borderCurve: "continuous",
                  })}
                  accessibilityRole="button"
                  accessibilityLabel="Clear selected files"
                >
                  <Text style={{ color: theme.color.fgMuted, fontSize: 15 }}>
                    Clear
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {files.length > 0 && !results ? (
              <PrimaryButton
                label={`Upload ${pluralize(files.length, "file")}`}
                onPress={confirmAndUpload}
                loading={uploading}
              />
            ) : null}

            {summary ? (
              <View
                style={{
                  backgroundColor: theme.color.bgElev1,
                  borderRadius: theme.radius.md,
                  padding: theme.space.md,
                  gap: 4,
                  borderCurve: "continuous",
                }}
              >
                <Text
                  style={{
                    color: theme.color.fg,
                    fontSize: 15,
                    fontWeight: "600",
                  }}
                >
                  Upload complete
                </Text>
                <Text
                  style={{
                    color: theme.color.fgMuted,
                    fontSize: 13,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {uploadSummaryLabel(summary)}
                </Text>
                <View style={{ flexDirection: "row", gap: 12, marginTop: 8 }}>
                  <Pressable
                    onPress={() => {
                      setFiles([]);
                      setResults(null);
                    }}
                    style={({ pressed }) => ({
                      paddingVertical: 6,
                      paddingHorizontal: 12,
                      borderRadius: 6,
                      backgroundColor: theme.color.bgElev2,
                      opacity: pressed ? 0.8 : 1,
                      borderCurve: "continuous",
                    })}
                  >
                    <Text
                      style={{ color: theme.color.fg, fontSize: 13 }}
                    >
                      Upload more
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => router.back()}
                    style={({ pressed }) => ({
                      paddingVertical: 6,
                      paddingHorizontal: 12,
                      borderRadius: 6,
                      backgroundColor: theme.color.accent,
                      opacity: pressed ? 0.85 : 1,
                      borderCurve: "continuous",
                    })}
                  >
                    <Text
                      style={{
                        color: theme.color.onAccent,
                        fontSize: 13,
                        fontWeight: "600",
                      }}
                    >
                      Done
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            {error ? (
              <Text
                selectable
                style={{ color: theme.color.danger, fontSize: 14 }}
              >
                {error}
              </Text>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !results ? (
            <EmptyState
              message='Tap "Pick files" to choose audio files to upload.'
              style={{ paddingVertical: 64 }}
            />
          ) : null
        }
      />
    </>
  );
}

function PickedFileRow({
  file,
  theme,
}: {
  file: PickedFile;
  theme: ThemeTokens;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.color.bgElev1,
        borderRadius: theme.radius.sm,
        paddingVertical: 10,
        paddingHorizontal: 12,
        flexDirection: "row",
        gap: 10,
        alignItems: "center",
        borderCurve: "continuous",
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fg, fontSize: 14, fontWeight: "500" }}
        >
          {file.name}
        </Text>
        {file.size ? (
          <Text
            style={{
              color: theme.color.fgMuted,
              fontSize: 12,
              fontVariant: ["tabular-nums"],
            }}
          >
            {formatBytes(file.size)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function ResultRow({
  result,
  theme,
}: {
  result: UploadResult;
  theme: ThemeTokens;
}) {
  const kind = uploadResultStatus(result);
  const status = {
    label: uploadStatusLabel(kind),
    color:
      kind === "added"
        ? theme.color.success
        : kind === "failed"
          ? theme.color.danger
          : theme.color.fgMuted,
  };
  return (
    <View
      style={{
        backgroundColor: theme.color.bgElev1,
        borderRadius: theme.radius.sm,
        paddingVertical: 10,
        paddingHorizontal: 12,
        flexDirection: "row",
        gap: 10,
        alignItems: "center",
        borderCurve: "continuous",
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fg, fontSize: 14, fontWeight: "500" }}
        >
          {result.file}
        </Text>
        {result.error ? (
          <Text
            selectable
            style={{ color: theme.color.danger, fontSize: 12 }}
            numberOfLines={2}
          >
            {result.error}
          </Text>
        ) : null}
      </View>
      <Text style={{ color: status.color, fontSize: 13, fontWeight: "500" }}>
        {status.label}
      </Text>
    </View>
  );
}

/** "Skipped a.txt, b.pdf and 3 more (unsupported format)." */
function unsupportedFilesMessage(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `Skipped ${shown}${more} (unsupported format).`;
}

function dedupeByUri(list: PickedFile[]): PickedFile[] {
  const seen = new Set<string>();
  const out: PickedFile[] = [];
  for (const f of list) {
    if (seen.has(f.uri)) continue;
    seen.add(f.uri);
    out.push(f);
  }
  return out;
}
