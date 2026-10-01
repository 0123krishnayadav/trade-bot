import { Badge, Card, Group, Progress, Stack, Text } from "@mantine/core";
import type { PositionsResponse, StatusResponse } from "../../../api/types";
import { inr, istTime } from "../../format";

/** Severity colour for how much of a limit is used. */
const used = (pct: number) => (pct < 50 ? "teal" : pct < 80 ? "yellow" : "red");

/** How close today is to the bot's risk limits. Same limits as the bot; the P&L is the dashboard's estimate. */
export function RiskCard({ status, positions }: { status: StatusResponse; positions: PositionsResponse }) {
  const dayPnl = status.today.netPnl + positions.openPnl;
  const loss = Math.max(0, -dayPnl);
  const lossPct = Math.min(100, (loss / status.risk.maxDailyLoss) * 100);
  const open = positions.positions.length;
  const openPct = Math.min(100, (open / status.risk.maxOpenPositions) * 100);

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Risk</Text>
        <Badge color={status.killSwitch ? "red" : "gray"} variant={status.killSwitch ? "filled" : "light"}>
          {status.killSwitch ? `kill switch on · ${istTime(status.killSwitch.activatedAt).slice(0, 5)}` : "kill switch off"}
        </Badge>
      </Group>
      <Stack gap="md">
        <div>
          <Group justify="space-between" mb={4}>
            <Text size="sm">Daily loss</Text>
            <Text size="sm" className="num" c="dimmed">
              {inr(loss)} of {inr(status.risk.maxDailyLoss)}
            </Text>
          </Group>
          <Progress value={lossPct} color={used(lossPct)} size="md" aria-label="Daily loss used" />
          <Text size="xs" c="dimmed" mt={4}>
            At the limit the bot turns the kill switch on.
          </Text>
        </div>
        <div>
          <Group justify="space-between" mb={4}>
            <Text size="sm">Open positions</Text>
            <Text size="sm" className="num" c="dimmed">
              {open} of {status.risk.maxOpenPositions}
            </Text>
          </Group>
          <Progress value={openPct} color={used(openPct)} size="md" aria-label="Open positions used" />
        </div>
      </Stack>
    </Card>
  );
}
