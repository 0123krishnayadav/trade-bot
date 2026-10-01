import { Anchor, Badge, Card, Group, Stack, Text } from "@mantine/core";
import { useLocation } from "wouter";
import type { HistoryResponse } from "../../../api/types";
import { dayLabel, inr, pnlColor } from "../../format";

/** The last few closed trades, with a link to the full history. */
export function RecentTradesCard({ history }: { history: HistoryResponse }) {
  const [, navigate] = useLocation();
  const recent = history.trades.slice(0, 5);
  return (
    <Card withBorder h="100%">
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Recent trades</Text>
        <Anchor size="xs" onClick={() => navigate("/history")}>
          All trades →
        </Anchor>
      </Group>
      {recent.length === 0 ? (
        <Text size="sm" c="dimmed">
          No closed trades yet.
        </Text>
      ) : (
        <Stack gap="xs">
          {recent.map((t) => (
            <Group key={t.id} justify="space-between" wrap="nowrap">
              <div>
                <Text size="sm">{dayLabel(t.tradeDate)}</Text>
                <Text size="xs" c="dimmed">
                  {t.strategyId}
                </Text>
              </div>
              <Group gap="sm" wrap="nowrap">
                <Badge size="xs" variant="light" color="gray">
                  {t.exitReason.replace(/_/g, " ")}
                </Badge>
                <Text size="sm" fw={600} className="num" c={pnlColor(t.netPnl)} miw={90} ta="right">
                  {inr(t.netPnl)}
                </Text>
              </Group>
            </Group>
          ))}
        </Stack>
      )}
    </Card>
  );
}
