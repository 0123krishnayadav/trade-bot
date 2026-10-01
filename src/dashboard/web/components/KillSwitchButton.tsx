import { Alert, Badge, Button, Group, List, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useState } from "react";
import { api } from "../api-client";
import { istTime } from "../format";

/**
 * Red button + confirm dialog. Turns the kill switch on for today; the bot sees it within a
 * second, squares off every strategy and makes no new trades until tomorrow.
 */
export function KillSwitchButton({ active, onDone }: { active?: { activatedAt: string }; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (active) {
    // Phones: the red banner on the page already says it; the header has no room to repeat it.
    return (
      <Badge color="red" variant="filled" size="lg" visibleFrom="sm">
        Kill switch on since {istTime(active.activatedAt)}
      </Badge>
    );
  }

  const fire = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.killSwitch();
      notifications.show({ color: "red", title: "Kill switch on", message: "The bot squares off within a second; no new trades today." });
      setOpen(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kill switch failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button color="red" size="xs" onClick={() => setOpen(true)}>
        Kill switch
      </Button>
      <Modal opened={open} onClose={() => !busy && setOpen(false)} title={<Text fw={700}>Kill switch</Text>} centered>
        <Stack>
          <Text size="sm">For the rest of today, every strategy will:</Text>
          <List size="sm" spacing={4}>
            <List.Item>square off its open positions at market (shorts first, then the wings)</List.Item>
            <List.Item>make no new trades, even if the bot is restarted</List.Item>
          </List>
          <Text size="sm" c="dimmed">
            It can't be undone today. Trading resumes automatically tomorrow.
          </Text>
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void fire()} loading={busy}>
              Square off now
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
