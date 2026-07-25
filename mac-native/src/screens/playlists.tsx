import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage, useAuth, type Playlist } from '@music-library/core';
import { HEADER_HEIGHT, Screen } from '../components/screen';
import { DOCK_CLEARANCE } from '../components/track-list';
import { Dialog } from '../components/dialog';
import {
  AppText,
  Button,
  EmptyState,
  ErrorText,
  Field,
} from '../components/primitives';
import { SkeletonTrackRows } from '../components/skeleton';
import { useHover } from '../components/hoverable';
import { SFSymbol } from '../native/sf-symbol';
import { useNavigation } from '../navigation/navigation';
import { qk } from '../lib/query-keys';
import { QUERY_STALE_TIME } from '../lib/query-policy';
import { useTheme } from '../theme/theme';

export function PlaylistsScreen() {
  const t = useTheme();
  const { me } = useAuth();
  const { push } = useNavigation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playlists = useQuery({
    queryKey: qk.playlists(me?.id),
    queryFn: ({ signal }) => api.listPlaylists({ signal }),
    staleTime: QUERY_STALE_TIME.default,
  });

  const closeDialog = useCallback(() => {
    if (pending) return;
    setCreating(false);
    setName('');
    setError(null);
  }, [pending]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    setError(null);
    setPending(true);
    try {
      const playlist = await api.createPlaylist({ name: trimmed });
      await queryClient.invalidateQueries({ queryKey: qk.playlists(me?.id) });
      setName('');
      setCreating(false);
      push({ screen: 'playlist', id: playlist.id, name: playlist.name });
    } catch (err) {
      setError(errorMessage(err, "Couldn't create that playlist."));
    } finally {
      setPending(false);
    }
  };

  const items = playlists.data ?? [];
  const loading = playlists.isLoading && !playlists.data;

  return (
    <Screen
      title="Playlists"
      accessory={<Button title="New Playlist" onPress={() => setCreating(true)} />}
      overlay={
        <Dialog
          open={creating}
          title="New Playlist"
          detail="Give it a name. You can add tracks from any list afterwards."
          onClose={closeDialog}
          actions={
            <>
              <Button title="Cancel" variant="plain" onPress={closeDialog} />
              <Button
                title="Create"
                variant="primary"
                pending={pending}
                disabled={name.trim().length === 0}
                onPress={create}
              />
            </>
          }>
          <Field
            placeholder="Playlist name"
            value={name}
            onChangeText={setName}
            onSubmitEditing={create}
            editable={!pending}
            autoCorrect={false}
            autoFocus
          />
          <ErrorText>{error}</ErrorText>
        </Dialog>
      }>
      {loading ? (
        <SkeletonTrackRows topInset={HEADER_HEIGHT} rows={8} />
      ) : items.length === 0 ? (
        <EmptyState
          title="No playlists"
          detail="Playlists you create or collaborate on appear here."
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={item => item.id}
          contentContainerStyle={{
            paddingHorizontal: t.space.lg,
            paddingTop: HEADER_HEIGHT,
            paddingBottom: DOCK_CLEARANCE,
          }}
          renderItem={({ item }) => (
            <PlaylistRow
              playlist={item}
              onPress={() =>
                push({ screen: 'playlist', id: item.id, name: item.name })
              }
            />
          )}
        />
      )}
    </Screen>
  );
}

function PlaylistRow({
  playlist,
  onPress,
}: {
  playlist: Playlist;
  onPress: () => void;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.row,
        {
          height: 48,
          paddingHorizontal: t.space.md,
          gap: t.space.md,
          borderRadius: t.radius.md,
          backgroundColor: hovered ? t.color.hover : 'transparent',
        },
      ]}
      {...hoverProps}>
      <SFSymbol name="music.note.list" size={16} color={t.color.fgSubtle} />
      <AppText variant="label" numberOfLines={1} style={styles.grow}>
        {playlist.name}
      </AppText>
      {playlist.visibility === 'collaborative' ? (
        <SFSymbol name="person.2" size={13} color={t.color.fgMuted} />
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  grow: { flex: 1 },
});
