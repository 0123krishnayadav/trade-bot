import { Alert, Badge, Card, Grid, Group, SimpleGrid, Skeleton, Stack, Table, Text } from "@mantine/core";
import { useLocation } from "wouter";
import { useCallback, useEffect, useState } from "react";
import type { HistoryResponse, HistorySummary, MarketResponse, OrdersResponse, PositionsResponse, StatusResponse, StrategyStatus } from "../../api/types";
import { api } from "../api-client";
import { KillSwitchButton } from "../components/KillSwitchButton";
import { MarketStrip } from "../components/cards/MarketStrip";
import { OrdersCard } from "../components/cards/OrdersCard";
import { PnlChartCard } from "../components/cards/PnlChartCard";
import { RecentTradesCard } from "../components/cards/RecentTradesCard";
import { RiskCard } from "../components/cards/RiskCard";
import { TradePlanCard } from "../components/cards/TradePlanCard";
import { Layout } from "../components/Layout";
import { inr, istDateTime, istTime, pnlColor, price } from "../format";

const PHASE_COLOR: Record<string, string> = {
  idle: "gray",
  entering: "yellow",
  open: "blue",
  exiting: "orange",
  done: "teal",
};

export function HomePage({ mode, onLoggedOut }: { mode: "paper" | "live"; onLoggedOut: () => void }) {
  const [status, setStatus] = useState<StatusResponse>();
  const [positions, setPositions] = useState<PositionsResponse>();
  const [history, setHistory] = useState<HistoryResponse>();
  const [market, setMarket] = useState<MarketResponse>();
  const [orders, setOrders] = useState<OrdersResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p, h, m, o] = await Promise.all([api.status(), api.positions(), api.history(), api.market(), api.orders()]);
      setStatus(s);
      setPositions(p);
      setHistory(h);
      setMarket(m);
      setOrders(o);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Layout
      mode={mode}
      onLoggedOut={onLoggedOut}
      onRefresh={() => void load()}
      refreshing={loading}
      actions={status && <KillSwitchButton active={status.killSwitch} onDone={() => void load()} />}
    >
      <Stack maw={1200} mx="auto">
        {error && (
          <Alert color="red" variant="light" title="Something went wrong">
            {error}
          </Alert>
        )}

        {status?.killSwitch && (
          <Alert color="red" variant="filled" title="Kill switch is on for today">
            Pressed at {istTime(status.killSwitch.activatedAt)} IST. Open positions are squared off and no new trades are placed
            until tomorrow. Press Refresh to see the exits.
          </Alert>
        )}

        {!status || !positions || !history || !market || !orders ? (
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
            <Skeleton h={140} />
            <Skeleton h={140} />
            <Skeleton h={140} />
            <Skeleton h={140} />
          </SimpleGrid>
        ) : (
          <>
            {/* Connection first, then money: live, today, all time. */}
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }}>
              <BrokerCard status={status} />
              <OpenPnlCard positions={positions} />
              <TodayCard status={status} />
              <HistoryCard summary={history.summary} />
            </SimpleGrid>
            <MarketStrip market={market} />
            <Grid>
              <Grid.Col span={{ base: 12, md: 8 }}>
                <Stack>
                  <TradePlanCard status={status} positions={positions} />
                  <PositionsCard positions={positions} />
                </Stack>
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 4 }}>
                <Stack>
                  <RiskCard status={status} positions={positions} />
                  <StrategiesCard strategies={status.strategies} />
                </Stack>
              </Grid.Col>
            </Grid>
            <Grid>
              <Grid.Col span={{ base: 12, md: 7 }}>
                <PnlChartCard summary={history.summary} />
              </Grid.Col>
              <Grid.Col span={{ base: 12, md: 5 }}>
                <RecentTradesCard history={history} />
              </Grid.Col>
            </Grid>
            <OrdersCard orders={orders} />
            <Text size="xs" c="dimmed">
              Updated {istDateTime(status.serverTime)} IST
            </Text>
          </>
        )}
      </Stack>
    </Layout>
  );
}

/** P&L of all closed trades so far; opens the history page. */
function HistoryCard({ summary }: { summary: HistorySummary }) {
  const [, navigate] = useLocation();
  return (
    <Card withBorder component="button" onClick={() => navigate("/history")} style={{ cursor: "pointer", textAlign: "left" }}>
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Text fw={600}>P&L till now</Text>
        <Text size="xs" c="dimmed">
          History →
        </Text>
      </Group>
      <Text size="xl" fw={700} className="num" c={pnlColor(summary.netPnl)}>
        {inr(summary.netPnl)}
      </Text>
      <Text size="sm" c="dimmed" className="num">
        {summary.trades === 0
          ? "No closed trades yet"
          : `${summary.trades} trade${summary.trades === 1 ? "" : "s"} · ${summary.winRate}% won · charges ${inr(summary.charges)}`}
      </Text>
      {summary.since && (
        <Text size="xs" c="dimmed">
          since {summary.since}
        </Text>
      )}
    </Card>
  );
}


function OpenPnlCard({ positions }: { positions: PositionsResponse }) {
  const count = positions.positions.length;
  return (
    <Card withBorder>
      <Text fw={600} mb="xs">
        Open P&L
      </Text>
      <Text size="xl" fw={700} className="num" c={pnlColor(positions.openPnl)}>
        {inr(positions.openPnl)}
      </Text>
      <Text size="sm" c="dimmed">
        {count === 0 ? "No open positions" : `${count} open position${count === 1 ? "" : "s"} · before charges`}
        {positions.pricesAsOf && ` · prices ${istTime(positions.pricesAsOf)}`}
      </Text>
      {count > 0 && !positions.pricesRecorded && (
        <Text size="xs" c="yellow" mt={4}>
          No live prices yet: restart the bot on this version so it records them.
        </Text>
      )}
      {positions.pricesRecorded && positions.missingPrices > 0 && (
        <Text size="xs" c="yellow" mt={4}>
          {positions.missingPrices} position{positions.missingPrices === 1 ? " has" : "s have"} no price yet (not included).
        </Text>
      )}
    </Card>
  );
}

function PositionsCard({ positions }: { positions: PositionsResponse }) {
  return (
    <Card withBorder>
      <Text fw={600} mb="xs">
        Open positions
      </Text>
      {positions.positions.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing open right now.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={480}>
          <Table className="num" verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Instrument</Table.Th>
                <Table.Th ta="right">Qty</Table.Th>
                <Table.Th ta="right">Avg</Table.Th>
                <Table.Th ta="right">LTP</Table.Th>
                <Table.Th ta="right">P&L</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {positions.positions.map((p) => (
                <Table.Tr key={`${p.strategyId}:${p.instrumentKey}`}>
                  <Table.Td>
                    <Text size="sm">{p.symbol}</Text>
                    {p.strategyId && (
                      <Text size="xs" c="dimmed">
                        {p.strategyId}
                      </Text>
                    )}
                  </Table.Td>
                  <Table.Td ta="right" c={p.quantity < 0 ? "red" : "teal"}>
                    {p.quantity > 0 ? `+${p.quantity}` : p.quantity}
                  </Table.Td>
                  <Table.Td ta="right">{price(p.averagePrice)}</Table.Td>
                  <Table.Td ta="right">{p.ltp === undefined ? "—" : price(p.ltp)}</Table.Td>
                  <Table.Td ta="right" c={pnlColor(p.pnl)}>
                    {p.pnl === undefined ? "—" : inr(p.pnl)}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Card>
  );
}

function BrokerCard({ status }: { status: StatusResponse }) {
  const { broker } = status;
  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <Text fw={600} tt="capitalize">
          {broker.name}
        </Text>
        <Badge color={broker.loggedIn ? "teal" : "red"} variant="light">
          {broker.loggedIn ? "connected" : "logged out"}
        </Badge>
      </Group>
      {broker.loggedIn ? (
        <Stack gap={4}>
          <Text size="sm">{broker.userName ?? broker.userId}</Text>
          <Text size="sm" c="dimmed">
            Token valid until {istDateTime(broker.validUntil!)} IST
          </Text>
        </Stack>
      ) : (
        <Text size="sm" c="dimmed">
          No valid session. Run <code>bun run login</code>.
        </Text>
      )}
    </Card>
  );
}

function TodayCard({ status }: { status: StatusResponse }) {
  const { today } = status;
  return (
    <Card withBorder>
      <Text fw={600} mb="xs">
        Today's closed P&L
      </Text>
      <Text size="xl" fw={700} className="num" c={pnlColor(today.netPnl)}>
        {inr(today.netPnl)}
      </Text>
      <Text size="sm" c="dimmed" className="num">
        {today.closedTrades} trade{today.closedTrades === 1 ? "" : "s"} · gross {inr(today.grossPnl)} · charges {inr(today.charges)}
      </Text>
    </Card>
  );
}

function StrategiesCard({ strategies }: { strategies: StrategyStatus[] }) {
  return (
    <Card withBorder>
      <Text fw={600} mb="xs">
        Strategies
      </Text>
      {strategies.length === 0 ? (
        <Text size="sm" c="dimmed">
          No strategy has saved state yet.
        </Text>
      ) : (
        <Stack gap="sm">
          {strategies.map((s) => (
            <div key={s.id}>
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm">{s.id}</Text>
                <Badge color={PHASE_COLOR[s.phase] ?? "red"} variant="light">
                  {s.phase}
                </Badge>
              </Group>
              <Text size="xs" c="dimmed">
                {[s.date, s.exitReason, s.note].filter(Boolean).join(" · ")}
              </Text>
            </div>
          ))}
        </Stack>
      )}
    </Card>
  );
}
