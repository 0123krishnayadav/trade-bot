import { Badge, Card, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import type { PositionsResponse, StatusResponse } from "../../../api/types";
import { dayLabel, inr, istTime, price } from "../../format";
import { MtmMeter } from "./MtmMeter";

/** Today's trade: strikes, credit and limits, with the live MTM between stop and target. */
export function TradePlanCard({ status, positions }: { status: StatusResponse; positions: PositionsResponse }) {
  const today = status.today.date;
  const strategy = status.strategies.find((s) => s.trade && s.date === today);

  if (!strategy?.trade) {
    return (
      <Card withBorder>
        <Text fw={600} mb="xs">
          Today's trade
        </Text>
        <Text size="sm" c="dimmed">
          No trade yet today. The plan (strikes, credit, target and stop) appears here once a strategy enters.
        </Text>
      </Card>
    );
  }

  const t = strategy.trade;
  const own = positions.positions.filter((p) => p.strategyId === strategy.id);
  const mtm = Math.round(own.reduce((sum, p) => sum + (p.pnl ?? 0), 0) * 100) / 100;
  const isOpen = ["entering", "open", "exiting"].includes(strategy.phase);

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Text fw={600}>Today's trade</Text>
        <Group gap="xs">
          <Text size="sm" c="dimmed">
            {strategy.id}
          </Text>
          <Badge variant="light" color={isOpen ? "blue" : "teal"}>
            {strategy.exitReason ? `${strategy.phase} · ${strategy.exitReason.replace(/_/g, " ")}` : strategy.phase}
          </Badge>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm" mb="md">
        <Fact label="ATM strike" value={t.atm !== undefined ? String(t.atm) : "—"} />
        <Fact label="Expiry" value={t.expiry ? dayLabel(t.expiry) : "—"} />
        <Fact label="Spot at entry" value={t.spot !== undefined ? price(t.spot) : "—"} hint={t.openedAt && `at ${istTime(t.openedAt).slice(0, 5)}`} />
        <Fact label="Credit / unit" value={t.credit !== undefined ? price(t.credit) : "—"} />
        <Fact label="Max profit" value={t.maxProfit !== undefined ? inr(t.maxProfit) : "—"} />
        <Fact label="Max loss" value={t.maxLoss !== undefined ? inr(t.maxLoss) : "—"} />
        <Fact label="Target" value={t.target !== undefined ? inr(t.target) : "—"} />
        <Fact label="Stop loss" value={t.stopLoss !== undefined ? inr(t.stopLoss) : "—"} />
      </SimpleGrid>

      {isOpen && t.target !== undefined && t.stopLoss !== undefined ? (
        positions.pricesRecorded && own.length > 0 && own.every((p) => p.pnl !== undefined) ? (
          <MtmMeter mtm={mtm} stopLoss={t.stopLoss} target={t.target} />
        ) : (
          <Text size="xs" c="yellow">
            Live MTM needs prices from the bot (restart it on this version so it records them).
          </Text>
        )
      ) : (
        <Text size="sm" c="dimmed">
          Closed{strategy.exitReason ? ` (${strategy.exitReason.replace(/_/g, " ").toLowerCase()})` : ""}: see today's closed P&L above.
        </Text>
      )}
    </Card>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={600} className="num">
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Stack>
  );
}
