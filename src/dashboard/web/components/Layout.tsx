import { AppShell, Badge, Button, Group, Title } from "@mantine/core";
import type { ReactNode } from "react";
import { api } from "../api-client";

/** Header (title, mode, logout) around every signed-in page. */
export function Layout({
  mode,
  onLoggedOut,
  actions,
  children,
}: {
  mode: "paper" | "live";
  onLoggedOut: () => void;
  /** Page-specific buttons shown before Log out, e.g. Refresh. */
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
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Title order={3}>Trade Bot</Title>
            <Badge color={mode === "live" ? "red" : "yellow"} variant={mode === "live" ? "filled" : "light"}>
              {mode}
            </Badge>
          </Group>
          <Group gap="xs" wrap="nowrap">
            {actions}
            <Button variant="subtle" color="gray" size="xs" onClick={() => void logout()}>
              Log out
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Main>{children}</AppShell.Main>
    </AppShell>
  );
}
