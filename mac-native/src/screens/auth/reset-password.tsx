import { useState } from 'react';
import { api, errorMessage, useAuth } from '@music-library/core';
import { Button, ErrorText, Field } from '../../components/primitives';
import { AuthShell } from './auth-shell';

/**
 * Forced password change. An admin-issued account lands here with
 * `must_reset_password` set and cannot reach the library until it clears.
 */
export function ResetPasswordScreen() {
  const { me, refresh, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!current || !next || pending) return;
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      await api.resetPassword(current, next);
      // The flag lives on the session; re-reading it is what clears the gate.
      await refresh();
    } catch (err) {
      setError(errorMessage(err, "Couldn't change the password."));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell
      title="Choose a new password"
      subtitle={
        me
          ? `${me.username} must set a new password before continuing.`
          : 'Set a new password before continuing.'
      }
      footer={<Button title="Sign out" variant="plain" onPress={() => void logout()} />}>
      <Field
        label="Current password"
        autoCapitalize="none"
        autoCorrect={false}
        secure
        value={current}
        onChangeText={setCurrent}
        editable={!pending}
      />
      <Field
        label="New password"
        autoCapitalize="none"
        autoCorrect={false}
        secure
        value={next}
        onChangeText={setNext}
        editable={!pending}
      />
      <Field
        label="Confirm new password"
        autoCapitalize="none"
        autoCorrect={false}
        secure
        value={confirm}
        onChangeText={setConfirm}
        editable={!pending}
        onSubmitEditing={submit}
        returnKeyType="go"
      />
      <ErrorText>{error}</ErrorText>
      <Button
        title="Update password"
        variant="primary"
        fullWidth
        pending={pending}
        disabled={!current || !next || !confirm}
        onPress={submit}
      />
    </AuthShell>
  );
}
