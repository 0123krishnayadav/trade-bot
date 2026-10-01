import { Box, Group, Text } from "@mantine/core";
import { inr, pnlColor } from "../../format";

/**
 * Where the live MTM sits between the stop loss (left) and the target (right), from zero in the
 * middle. The fill grows from the centre towards the side the trade is on.
 */
export function MtmMeter({ mtm, stopLoss, target }: { mtm: number; stopLoss: number; target: number }) {
  const side = mtm >= 0 ? target : stopLoss;
  const pct = side > 0 ? Math.min(1, Math.abs(mtm) / side) * 50 : 0;
  const color = mtm >= 0 ? "var(--mantine-color-teal-7)" : "var(--mantine-color-red-7)";
  return (
    <div>
      <Group justify="space-between" mb={6}>
        <Text size="xs" c="dimmed" className="num">
          Stop −{inr(stopLoss)}
        </Text>
        <Text size="sm" fw={700} className="num" c={pnlColor(mtm)}>
          MTM {inr(mtm)}
        </Text>
        <Text size="xs" c="dimmed" className="num">
          Target {inr(target)}
        </Text>
      </Group>
      <Box
        role="meter"
        aria-label="MTM between stop loss and target"
        aria-valuemin={-stopLoss}
        aria-valuemax={target}
        aria-valuenow={mtm}
        pos="relative"
        h={10}
        style={{ borderRadius: 5, background: "var(--mantine-color-dark-4)", overflow: "hidden" }}
      >
        <Box
          pos="absolute"
          top={0}
          bottom={0}
          style={{
            background: color,
            width: `${pct}%`,
            ...(mtm >= 0 ? { left: "50%" } : { right: "50%" }),
          }}
        />
        <Box pos="absolute" top={0} bottom={0} left="calc(50% - 1px)" w={2} style={{ background: "var(--mantine-color-dark-1)" }} />
      </Box>
    </div>
  );
}
