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
  ApiError,
  getBaseUrl,
  libraryChanged,
  useAuth,
  type UploadResult,
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

type Scope = "personal" | "global";

/**
 * Mobile upload screen. Pick audio files with the system document picker,
 * pick a scope (personal unless admin), and POST multipart/form-data directly
 * to `/api/library/upload` on the configured backend. The shared API helper's
 * `File[]` signature doesn't work on RN (no `File` constructor); we build the
 * RN-style `{ uri, name, type }` FormData parts here.
 */
export default function UploadScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { me } = useAuth();
  const dockInset = useBottomDockInset();

  const [files, setFiles] = useState<PickedFile[]>([]);
  const [scope, setScope] = useState<Scope>("personal");
  const [uploading, setUploading] = useState(false);
  const [results, setResults] = useState<UploadResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAdmin = me?.role === "admin";

  const pickFiles = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["audio/*"],
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const picked: PickedFile[] = res.assets.map((a) => ({
        uri: a.uri,
        name: a.name,
        type: a.mimeType ?? "audio/mpeg",
        size: a.size,
      }));
      void Haptics.selectionAsync();
      setFiles((prev) => dedupeByUri([...prev, ...picked]));
      setResults(null);
      setError(null);
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
    try {
      const fd = new FormData();
      fd.append("scope", scope);
      for (const f of files) {
        // RN FormData accepts this shape for multipart file parts.
        fd.append("files", {
          uri: f.uri,
          name: f.name,
          type: f.type,
        } as unknown as Blob);
      }
      const res = await fetch(`${getBaseUrl()}/api/library/upload`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ApiError(res.status, text.trim() || res.statusText);
      }
      const json = (await res.json()) as UploadResult[];
      setResults(json);
      // The root layout's libraryChanged subscriber invalidates the browse
      // lists and user-scoped queries, so emitting is the whole refresh.
      libraryChanged.emit();
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (err instanceof ApiError) {
        setError(err.message || `Upload failed (${err.status}).`);
      } else if (err instanceof Error) {
        setError(err.message || "Couldn't reach the server.");
      } else {
        setError("Couldn't reach the server.");
      }
    } finally {
      setUploading(false);
    }
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

  const summary = results
    ? {
        inserted: results.filter((r) => r.inserted).length,
        dedup: results.filter((r) => r.dedup).length,
        skipped: results.filter((r) => r.skipped).length,
        errored: results.filter((r) => r.error).length,
      }
    : null;

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
                <SegmentedControl<Scope>
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
                label={`Upload ${files.length} ${files.length === 1 ? "file" : "files"}`}
                onPress={confirmAndUpload}
                loading={uploading}
                accessibilityLabel={`Upload ${files.length} file${files.length === 1 ? "" : "s"}`}
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
                  {summary.inserted} inserted · {summary.dedup} deduped ·{" "}
                  {summary.skipped} skipped · {summary.errored} errors
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
  const status = result.inserted
    ? { label: "Inserted", color: theme.color.success }
    : result.dedup
      ? { label: "Deduped", color: theme.color.fgMuted }
      : result.skipped
        ? { label: "Skipped", color: theme.color.fgMuted }
        : result.error
          ? { label: "Error", color: theme.color.danger }
          : { label: "—", color: theme.color.fgMuted };
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
