import { useState } from 'react';
import { Button, ErrorText, Field } from '../../components/primitives';
import {
  normalizeServerUrl,
  probeServerUrl,
  saveServerUrl,
} from '../../bootstrap/server-url';
import { AuthShell } from './auth-shell';

/**
 * First-launch screen: the desktop build ships without a baked-in server
 * address, so the user points it at their library before anything else can
 * happen.
 */
export function ServerSetupScreen({
  onConnected,
}: {
  onConnected: (url: string) => void;
}) {
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const url = normalizeServerUrl(value);
    if (url.length === 0 || pending) return;
    setError(null);
    setPending(true);
    try {
      const result = await probeServerUrl(url);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await saveServerUrl(url);
      onConnected(url);
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell
      title="Lumen"
      subtitle="Connect to your library server to get started.">
      <Field
        label="Server address"
        placeholder="lumen.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        value={value}
        onChangeText={setValue}
        editable={!pending}
        onSubmitEditing={submit}
        returnKeyType="go"
      />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Connect"
        variant="primary"
        fullWidth
        pending={pending}
        disabled={normalizeServerUrl(value).length === 0}
        onPress={submit}
      />
    </AuthShell>
  );
}
