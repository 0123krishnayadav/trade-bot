import { Badge, Card, Group, Table, Text, Tooltip } from "@mantine/core";
import type { OrdersResponse } from "../../../api/types";
import { istTime, price } from "../../format";

const STATUS_COLOR: Record<string, string> = { FILLED: "teal", REJECTED: "red", CANCELLED: "gray", PARTIALLY_FILLED: "yellow" };

/** Every order placed today, newest first. */
export function OrdersCard({ orders }: { orders: OrdersResponse }) {
  return (
    <Card withBorder>
      <Group justify="space-between" mb="xs">
        <Text fw={600}>Today's orders</Text>
        <Text size="xs" c="dimmed">
          {orders.orders.length} order{orders.orders.length === 1 ? "" : "s"}
        </Text>
      </Group>
      {orders.orders.length === 0 ? (
        <Text size="sm" c="dimmed">
          No orders today.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={560} mah={320}>
          <Table className="num" verticalSpacing={6} stickyHeader highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Time</Table.Th>
                <Table.Th>Side</Table.Th>
                <Table.Th>Instrument</Table.Th>
                <Table.Th ta="right">Qty</Table.Th>
                <Table.Th ta="right">Avg price</Table.Th>
                <Table.Th>Status</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {orders.orders.map((o) => (
                <Table.Tr key={o.id}>
                  <Table.Td>{istTime(o.placedAt)}</Table.Td>
                  <Table.Td>
                    <Badge size="sm" variant="light" color={o.side === "BUY" ? "blue" : "orange"}>
                      {o.side}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{o.symbol}</Table.Td>
                  <Table.Td ta="right">{o.filledQuantity === o.quantity ? o.quantity : `${o.filledQuantity}/${o.quantity}`}</Table.Td>
                  <Table.Td ta="right">{o.averagePrice ? price(o.averagePrice) : "—"}</Table.Td>
                  <Table.Td>
                    <Tooltip label={o.statusMessage} disabled={!o.statusMessage}>
                      <Badge size="sm" variant="light" color={STATUS_COLOR[o.status] ?? "yellow"}>
                        {o.status.replace(/_/g, " ")}
                      </Badge>
                    </Tooltip>
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
