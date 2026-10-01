import { Anchor, Card, Group, Paper, Text } from "@mantine/core";
import { useElementSize } from "@mantine/hooks";
import { useState } from "react";
import { useLocation } from "wouter";
import type { HistorySummary } from "../../../api/types";
import { dayLabel, inr, pnlColor } from "../../format";

// One series, so no legend: the title names it. Line colour checked with the dataviz palette
// validator against the dark card surface (#2e2e2e): lightness band and contrast pass.
const LINE = "#0ca678";
const SURFACE = "var(--mantine-color-dark-6)";
const GRID = "var(--mantine-color-dark-5)";
const ZERO = "var(--mantine-color-dark-3)";
const AXIS_TEXT = "var(--mantine-color-dimmed)";

const HEIGHT = 200;
const PAD = { top: 12, right: 84, bottom: 26, left: 56 };

const compact = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });

/** Round tick values (…, -1,000, 0, 1,000, 2,000, …) covering [min, max]. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min - 1, min, min + 1];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= Math.ceil(max / step) * step + step / 2; v += step) ticks.push(Math.round(v));
  return ticks;
}

/** Cumulative net P&L by trading day, with a crosshair tooltip. The History page has the same numbers as a table. */
export function PnlChartCard({ summary }: { summary: HistorySummary }) {
  const { ref, width } = useElementSize();
  const [hover, setHover] = useState<number>();
  const [, navigate] = useLocation();
  const days = summary.daily;

  const header = (
    <Group justify="space-between" mb="xs">
      <div>
        <Text fw={600}>Cumulative P&L</Text>
        <Text size="xs" c="dimmed">
          net of charges, by trading day
        </Text>
      </div>
      <Anchor size="xs" onClick={() => navigate("/history")}>
        View as table →
      </Anchor>
    </Group>
  );

  if (days.length === 0) {
    return (
      <Card withBorder h="100%">
        {header}
        <Text size="sm" c="dimmed">
          The curve appears after the first closed trade.
        </Text>
      </Card>
    );
  }

  const values = days.map((d) => d.cumulative);
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values));
  const [lo, hi] = [ticks[0]!, ticks.at(-1)!];
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (days.length === 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v: number) => PAD.top + ((hi - v) / (hi - lo)) * plotH;

  const line = days.map((d, i) => `${i ? "L" : "M"}${x(i)},${y(d.cumulative)}`).join(" ");
  const area = `${line} L${x(days.length - 1)},${y(0)} L${x(0)},${y(0)} Z`;
  const last = days.length - 1;
  const active = hover ?? undefined;

  const onMove = (e: React.MouseEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - box.left;
    const i = days.length === 1 ? 0 : Math.round((px / box.width) * (days.length - 1));
    setHover(Math.max(0, Math.min(last, i)));
  };

  return (
    <Card withBorder h="100%">
      {header}
      <div ref={ref} style={{ position: "relative", width: "100%", height: HEIGHT }}>
        {width > 0 && (
          <svg width={width} height={HEIGHT} role="img" aria-label={`Cumulative net P&L, now ${inr(values[last]!)}`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? ZERO : GRID} strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill={AXIS_TEXT}>
                  {t === 0 ? "0" : compact.format(t)}
                </text>
              </g>
            ))}
            <text x={PAD.left} y={HEIGHT - 6} fontSize={11} fill={AXIS_TEXT}>
              {dayLabel(days[0]!.date)}
            </text>
            {days.length > 1 && (
              <text x={PAD.left + plotW} y={HEIGHT - 6} textAnchor="end" fontSize={11} fill={AXIS_TEXT}>
                {dayLabel(days[last]!.date)}
              </text>
            )}

            <path d={area} fill={LINE} fillOpacity={0.1} />
            <path d={line} fill="none" stroke={LINE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />

            {/* End marker and its value: the one direct label. */}
            <circle cx={x(last)} cy={y(values[last]!)} r={4} fill={LINE} stroke={SURFACE} strokeWidth={2} />
            <text x={x(last) + 10} y={y(values[last]!)} dy="0.32em" fontSize={12} fontWeight={600} fill="var(--mantine-color-text)">
              {inr(values[last]!)}
            </text>

            {active !== undefined && (
              <g pointerEvents="none">
                <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} stroke={ZERO} strokeWidth={1} />
                <circle cx={x(active)} cy={y(values[active]!)} r={5} fill={LINE} stroke={SURFACE} strokeWidth={2} />
              </g>
            )}

            {/* The whole plot is the hover target; the crosshair snaps to the nearest day. */}
            <rect
              x={PAD.left}
              y={PAD.top}
              width={plotW}
              height={plotH}
              fill="transparent"
              onMouseMove={onMove}
              onMouseLeave={() => setHover(undefined)}
            />
          </svg>
        )}

        {active !== undefined && (
          <Paper
            withBorder
            shadow="md"
            p="xs"
            style={{
              position: "absolute",
              pointerEvents: "none",
              top: 4,
              left: Math.min(Math.max(0, x(active) + 12), Math.max(0, width - 170)),
              width: 160,
            }}
          >
            <Text size="xs" fw={600}>
              {dayLabel(days[active]!.date)}
            </Text>
            <Group justify="space-between" gap={4}>
              <Text size="xs" c="dimmed">
                Day ({days[active]!.trades} trade{days[active]!.trades === 1 ? "" : "s"})
              </Text>
              <Text size="xs" className="num" c={pnlColor(days[active]!.netPnl)}>
                {inr(days[active]!.netPnl)}
              </Text>
            </Group>
            <Group justify="space-between" gap={4}>
              <Group gap={4}>
                <span aria-hidden style={{ width: 10, height: 2, background: LINE, display: "inline-block" }} />
                <Text size="xs" c="dimmed">
                  Total
                </Text>
              </Group>
              <Text size="xs" fw={600} className="num">
                {inr(days[active]!.cumulative)}
              </Text>
            </Group>
          </Paper>
        )}
      </div>
    </Card>
  );
}
