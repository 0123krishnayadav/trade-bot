import { ActionIcon, AppShell, Badge, Box, Button, Group, Menu, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { api } from "../api-client";

/**
 * Header (title, mode, actions, logout) around every signed-in page. On phones, Refresh and
 * Log out move into a ⋯ menu so the row never wraps; page actions (the kill switch) stay visible.
 */
export function Layout({
  mode,
  onLoggedOut,
  onRefresh,
  refreshing,
  actions,
  children,
}: {
  mode: "paper" | "live";
  onLoggedOut: () => void;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Always-visible page buttons, e.g. the kill switch. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const logout = async () => {
    await api.logout().catch(() => {});
    onLoggedOut();
  };

  return (
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px={{ base: "sm", sm: "md" }} justify="space-between" wrap="nowrap" gap="xs">
          <Group gap="xs" wrap="nowrap" miw={0}>
            <Title order={3} fz={{ base: "lg", sm: "xl" }} style={{ whiteSpace: "nowrap" }}>
              Trade Bot
            </Title>
            <Badge color={mode === "live" ? "red" : "yellow"} variant={mode === "live" ? "filled" : "light"} style={{ flexShrink: 0 }}>
              {mode}
            </Badge>
          </Group>

          <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
            {actions}

            {/* Wide screens: plain buttons. */}
            <Group gap="xs" wrap="nowrap" visibleFrom="sm">
              {onRefresh && (
                <Button variant="default" size="xs" onClick={onRefresh} loading={refreshing}>
                  Refresh
                </Button>
              )}
              <Button variant="subtle" color="gray" size="xs" onClick={() => void logout()}>
                Log out
              </Button>
            </Group>

            {/* Phones: one menu button. */}
            <Box hiddenFrom="sm">
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="default" size="lg" aria-label="More actions" loading={refreshing}>
                    ⋯
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  {onRefresh && <Menu.Item onClick={onRefresh}>Refresh</Menu.Item>}
                  <Menu.Item color="red" onClick={() => void logout()}>
                    Log out
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Box>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
