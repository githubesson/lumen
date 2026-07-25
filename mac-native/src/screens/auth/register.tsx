import { useState } from 'react';
import { api, errorMessage, useAuth } from '@music-library/core';
import { Button, ErrorText, Field } from '../../components/primitives';
import { AuthShell } from './auth-shell';

/**
 * Registration is invite-only. The iOS client receives the token through a deep
 * link; on desktop the user pastes the invite link (or the bare token) they were
 * sent, and anything that looks like a URL has its `token` query param lifted
 * out so both forms work.
 */
function extractToken(input: string): string {
  const trimmed = input.trim();
  const match = /[?&]token=([^&\s]+)/.exec(trimmed);
  if (match) return decodeURIComponent(match[1]);
  return trimmed;
}

export function RegisterScreen({ onBack }: { onBack: () => void }) {
  const { setMe } = useAuth();
  const [invite, setInvite] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const token = extractToken(invite);
    if (!token || !username || !password || pending) return;
    setError(null);
    setPending(true);
    try {
      const check = await api.checkInvite(token);
      if (!check.valid) {
        setError('That invite is no longer valid.');
        return;
      }
      const me = await api.register(token, username, password);
      // register() establishes the session cookie; publishing `me` moves the
      // gate straight into the app without a second round trip.
      setMe(me);
    } catch (err) {
      setError(errorMessage(err, "Couldn't complete registration."));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell
      title="Redeem invite"
      subtitle="Paste the invite link you were sent."
      footer={<Button title="Back to sign in" variant="plain" onPress={onBack} />}>
      <Field
        label="Invite link or code"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        value={invite}
        onChangeText={setInvite}
        editable={!pending}
      />
      <Field
        label="Username"
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        value={username}
        onChangeText={setUsername}
        editable={!pending}
      />
      <Field
        label="Password"
        autoCapitalize="none"
        autoCorrect={false}
        secure
        value={password}
        onChangeText={setPassword}
        editable={!pending}
        onSubmitEditing={submit}
        returnKeyType="go"
      />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Create account"
        variant="primary"
        fullWidth
        pending={pending}
        disabled={!invite || !username || !password}
        onPress={submit}
      />
    </AuthShell>
  );
}
