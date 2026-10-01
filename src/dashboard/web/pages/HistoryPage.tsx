import { Alert, Badge, Button, Card, Grid, Group, SimpleGrid, Skeleton, Stack, Table, Text, Title } from "@mantine/core";
import { useLocation } from "wouter";
import { useCallback, useEffect, useState } from "react";
import type { HistoryResponse, TradeFill } from "../../api/types";
import { api } from "../api-client";
import { Layout } from "../components/Layout";
import { inr, pnlColor, price } from "../format";

const EXIT_COLOR: Record<string, string> = {
  TARGET: "teal",
  STOP_LOSS: "red",
  TIME_EXIT: "blue",
  SHUTDOWN: "gray",
  ENTRY_FAILED: "orange",
  KILL_SWITCH: "grape",
};

/** Every closed trade: totals at the top, one row per trade with what was bought and sold. */
export function HistoryPage({ mode, onLoggedOut }: { mode: "paper" | "live"; onLoggedOut: () => void }) {
  const [data, setData] = useState<HistoryResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [, navigate] = useLocation();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.history());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = (
    <Button variant="default" size="xs" onClick={() => void load()} loading={loading}>
      Refresh
    </Button>
  );

  return (
    <Layout mode={mode} onLoggedOut={onLoggedOut} actions={refresh}>
      <Stack maw={1200} mx="auto">
        <Group gap="sm">
          <Button variant="subtle" color="gray" size="xs" onClick={() => navigate("/")}>
            ← Back
          </Button>
          <Title order={3}>Trade history</Title>
        </Group>
        {error && (
          <Alert color="red" variant="light" title="Something went wrong">
            {error}
          </Alert>
        )}
        {!data ? (
          <>
            <SimpleGrid cols={{ base: 2, md: 4 }}>
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} h={80} />
              ))}
            </SimpleGrid>
            <Skeleton h={300} />
          </>
        ) : (
          <>
            <Summary data={data} />
            {data.summary.trades > 0 && (
              <Grid>
                <Grid.Col span={{ base: 12, md: 5 }}>
                  <ExitReasons data={data} />
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 7 }}>
                  <DailyPnl data={data} />
                </Grid.Col>
              </Grid>
            )}
            <TradesTable data={data} />
          </>
        )}
      </Stack>
    </Layout>
  );
}

function Stat({ label, value, color, hint }: { label: string; value: string; color?: string; hint?: string }) {
  return (
    <Card withBorder padding="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Text size="lg" fw={700} className="num" c={color}>
        {value}
      </Text>
      {hint && (
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      )}
    </Card>
  );
}

function Summary({ data }: { data: HistoryResponse }) {
  const s = data.summary;
  return (
    <>
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Stat label="Net P&L" value={inr(s.netPnl)} color={pnlColor(s.netPnl)} hint={s.since && `since ${s.since}`} />
        <Stat label="Gross P&L" value={inr(s.grossPnl)} color={pnlColor(s.grossPnl)} />
        <Stat label="Charges" value={inr(s.charges)} />
        <Stat label="Trades" value={String(s.trades)} hint={s.trades ? `${s.wins} won · ${s.losses} lost · ${s.winRate}% win rate` : undefined} />
      </SimpleGrid>
      {s.trades > 0 && (
        <SimpleGrid cols={{ base: 2, md: 4 }}>
          <Stat label="Expectancy" value={inr(s.expectancy)} color={pnlColor(s.expectancy)} hint="per trade, after costs" />
          <Stat label="Avg win / loss" value={`${inr(s.avgWin)} / ${inr(s.avgLoss)}`} />
          <Stat label="Max drawdown" value={inr(s.maxDrawdown)} color={s.maxDrawdown > 0 ? "red" : undefined} hint="from a previous high" />
          <Stat
            label="Profit factor"
            value={s.profitFactor === undefined ? "—" : String(s.profitFactor)}
            hint={`best ${inr(s.bestTrade)} · worst ${inr(s.worstTrade)}`}
          />
        </SimpleGrid>
      )}
    </>
  );
}

function ExitReasons({ data }: { data: HistoryResponse }) {
  return (
    <Card withBorder h="100%">
      <Text fw={600} mb="xs">
        Exit reasons
      </Text>
      <Table className="num" verticalSpacing={6}>
        <Table.Tbody>
          {data.summary.exitReasons.map((e) => (
            <Table.Tr key={e.reason}>
              <Table.Td>
                <Badge size="sm" variant="light" color={EXIT_COLOR[e.reason] ?? "gray"}>
                  {e.reason.replace(/_/g, " ")}
                </Badge>
              </Table.Td>
              <Table.Td ta="right">{e.trades}</Table.Td>
              <Table.Td ta="right" c={pnlColor(e.netPnl)}>
                {inr(e.netPnl)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Card>
  );
}

function DailyPnl({ data }: { data: HistoryResponse }) {
  return (
    <Card withBorder h="100%">
      <Text fw={600} mb="xs">
        Per day
      </Text>
      <Table.ScrollContainer minWidth={360} mah={260}>
        <Table className="num" verticalSpacing={6} stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th ta="right">Trades</Table.Th>
              <Table.Th ta="right">Net P&L</Table.Th>
              <Table.Th ta="right">Running total</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {[...data.summary.daily].reverse().map((d) => (
              <Table.Tr key={d.date}>
                <Table.Td>{d.date}</Table.Td>
                <Table.Td ta="right">{d.trades}</Table.Td>
                <Table.Td ta="right" c={pnlColor(d.netPnl)}>
                  {inr(d.netPnl)}
                </Table.Td>
                <Table.Td ta="right" c={pnlColor(d.cumulative)}>
                  {inr(d.cumulative)}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}

/** One line per instrument: symbol, then quantity @ average price. */
function Fills({ fills }: { fills: TradeFill[] }) {
  if (fills.length === 0) return <Text c="dimmed">—</Text>;
  return (
    <Stack gap={4}>
      {fills.map((f) => (
        <div key={f.instrumentKey}>
          <Text size="sm" lh={1.3}>
            {f.symbol}
          </Text>
          <Text size="xs" c="dimmed" className="num">
            {f.quantity} @ {price(f.averagePrice)}
          </Text>
        </div>
      ))}
    </Stack>
  );
}

function TradesTable({ data }: { data: HistoryResponse }) {
  if (data.trades.length === 0) {
    return (
      <Card withBorder>
        <Text c="dimmed">No closed trades yet.</Text>
      </Card>
    );
  }
  const s = data.summary;
  return (
    <Card withBorder padding={0}>
      <Table.ScrollContainer minWidth={900}>
        <Table striped highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Date</Table.Th>
              <Table.Th>Strategy</Table.Th>
              <Table.Th>Bought</Table.Th>
              <Table.Th>Sold</Table.Th>
              <Table.Th ta="right">Gross P&L</Table.Th>
              <Table.Th ta="right">Charges</Table.Th>
              <Table.Th ta="right">Net P&L</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {data.trades.map((t) => (
              <Table.Tr key={t.id} style={{ verticalAlign: "top" }}>
                <Table.Td className="num" style={{ whiteSpace: "nowrap" }}>
                  {t.tradeDate}
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{t.strategyId}</Text>
                  <Badge size="xs" variant="light" color={EXIT_COLOR[t.exitReason] ?? "gray"} mt={4}>
                    {t.exitReason.replace(/_/g, " ")}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Fills fills={t.bought} />
                </Table.Td>
                <Table.Td>
                  <Fills fills={t.sold} />
                </Table.Td>
                <Table.Td ta="right" className="num" c={pnlColor(t.grossPnl)}>
                  {inr(t.grossPnl)}
                </Table.Td>
                <Table.Td ta="right" className="num">
                  {inr(t.charges)}
                </Table.Td>
                <Table.Td ta="right" className="num" fw={600} c={pnlColor(t.netPnl)}>
                  {inr(t.netPnl)}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
          <Table.Tfoot>
            <Table.Tr>
              <Table.Th colSpan={4}>Total ({s.trades})</Table.Th>
              <Table.Th ta="right" className="num" c={pnlColor(s.grossPnl)}>
                {inr(s.grossPnl)}
              </Table.Th>
              <Table.Th ta="right" className="num">
                {inr(s.charges)}
              </Table.Th>
              <Table.Th ta="right" className="num" c={pnlColor(s.netPnl)}>
                {inr(s.netPnl)}
              </Table.Th>
            </Table.Tr>
          </Table.Tfoot>
        </Table>
      </Table.ScrollContainer>
    </Card>
  );
}
