import { useState } from 'react';
import { View } from 'react-native';
import { ApiError, useAuth } from '@music-library/core';
import { Button, ErrorText, Field } from '../../components/primitives';
import { AuthShell } from './auth-shell';

export function LoginScreen({
  onRegister,
  onChangeServer,
}: {
  onRegister: () => void;
  onChangeServer: () => void;
}) {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!username || !password || pending) return;
    setError(null);
    setPending(true);
    try {
      // AuthProvider flips status to "authed"; the gate above swaps the shell in.
      await login(username, password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setError('Wrong username or password.');
      } else if (err instanceof Error) {
        setError(err.message || "Couldn't reach the server.");
      } else {
        setError("Couldn't reach the server.");
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell
      title="Lumen"
      subtitle="Sign in to your library."
      footer={
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <Button title="Redeem an invite" variant="plain" onPress={onRegister} />
          <Button title="Change server" variant="plain" onPress={onChangeServer} />
        </View>
      }>
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
        title="Sign in"
        variant="primary"
        fullWidth
        pending={pending}
        disabled={!username || !password}
        onPress={submit}
      />
    </AuthShell>
  );
}
