import { Badge, Card, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import type { MarketResponse } from "../../../api/types";
import { ago, dayLabel, istTime, pnlColor, price, signed } from "../../format";

/** The index, today's session, whether the bot is live, and what's coming up. */
export function MarketStrip({ market }: { market: MarketResponse }) {
  const { index, today } = market;
  // Prices are written every second while the bot runs; a recent write means it's connected.
  const live = market.pricesUpdatedAt !== undefined && Date.now() - new Date(market.pricesUpdatedAt).getTime() < 60_000;
  const statusColor = { open: "teal", "pre-open": "yellow", closed: "gray" }[today.status];

  return (
    <Card withBorder>
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="lg">
        <Section label={index?.symbol ?? "Index"}>
          {index ? (
            <>
              <Text size="xl" fw={700} className="num">
                {price(index.ltp)}
              </Text>
              <Text size="sm" className="num" c={pnlColor(index.change)}>
                {index.change > 0 ? "▲" : index.change < 0 ? "▼" : ""} {signed(index.change)} ({signed(index.changePct)}%)
              </Text>
            </>
          ) : (
            <Text size="sm" c="dimmed">
              No price yet (the bot records it while running)
            </Text>
          )}
        </Section>

        <Section label="Market">
          <Group gap="xs">
            <Badge color={statusColor} variant="light">
              {today.status}
            </Badge>
            {today.note && (
              <Text size="sm" c="dimmed">
                {today.note}
              </Text>
            )}
          </Group>
          <Text size="sm" c="dimmed" className="num">
            {today.session ? `${istTime(today.session.open).slice(0, 5)}–${istTime(today.session.close).slice(0, 5)} IST` : "No session today"}
          </Text>
        </Section>

        <Section label="Bot">
          <Group gap={6}>
            <span
              aria-hidden
              style={{ width: 8, height: 8, borderRadius: 4, background: live ? "var(--mantine-color-teal-6)" : "var(--mantine-color-gray-6)" }}
            />
            <Text size="sm" fw={500}>
              {live ? "Live" : "Not receiving prices"}
            </Text>
          </Group>
          <Text size="sm" c="dimmed">
            {market.pricesUpdatedAt ? `last price ${ago(market.pricesUpdatedAt)}` : "no prices recorded yet"}
          </Text>
        </Section>

        <Section label="Coming up">
          {market.holidaysMissing ? (
            <Text size="sm" c="yellow">
              Holiday list not downloaded yet. Run <code>bun run holidays</code> (the bot also fetches it when it starts).
            </Text>
          ) : market.nextTradingDay ? (
            <Text size="sm">Next trading day: {dayLabel(market.nextTradingDay)}</Text>
          ) : null}
          {market.holidaysMissing ? null : market.upcoming.length === 0 ? (
            <Text size="sm" c="dimmed">
              No holidays listed
            </Text>
          ) : (
            market.upcoming.slice(0, 2).map((h) => (
              <Text size="sm" c="dimmed" key={h.date}>
                {dayLabel(h.date)}: {h.description}
                {h.special ? " (special session)" : ""}
              </Text>
            ))
          )}
        </Section>
      </SimpleGrid>
    </Card>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack gap={4}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      {children}
    </Stack>
  );
}
