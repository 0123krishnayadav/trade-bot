import { Alert, Button, Center, Paper, PasswordInput, PinInput, Stack, Text, Title } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api-client";

const PIN_LENGTH = 6;

export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (pinValue = pin) => {
    if (busy || !password || pinValue.length !== PIN_LENGTH) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.login({ password, pin: pinValue });
      onLoggedIn();
    } catch (err) {
      setPin("");
      if (err instanceof ApiError && err.status === 429) {
        setError(`Too many failed attempts. Try again in ${Math.ceil((err.retryAfterSeconds ?? 60) / 60)} min.`);
      } else if (err instanceof ApiError && err.status === 401) {
        setError("Invalid password or PIN.");
      } else {
        setError(err instanceof Error ? err.message : "Login failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit();
  };

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="md" p="xl" w="100%" maw={380}>
        <form onSubmit={onSubmit}>
          <Stack gap="lg">
            <div>
              <Title order={2}>Trade Bot</Title>
              <Text c="dimmed" size="sm">
                Sign in to the dashboard
              </Text>
            </div>

            {/* Lets password managers file the password under a name. */}
            <input type="text" name="username" autoComplete="username" value="trade-bot" readOnly hidden />
            <PasswordInput
              label="Password"
              name="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
            />

            <div>
              <Text size="sm" fw={500} mb={6}>
                PIN
              </Text>
              <PinInput
                length={PIN_LENGTH}
                type="number"
                mask
                oneTimeCode={false}
                value={pin}
                onChange={setPin}
                onComplete={(value) => void submit(value)}
                aria-label="PIN"
              />
            </div>

            {error && (
              <Alert color="red" variant="light">
                {error}
              </Alert>
            )}

            <Button type="submit" loading={busy} disabled={!password || pin.length !== PIN_LENGTH} fullWidth>
              Sign in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
