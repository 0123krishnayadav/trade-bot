import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import { createTheme, MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createRoot } from "react-dom/client";
import { App } from "./App";

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "md",
});

createRoot(document.getElementById("root")!).render(
  // Dark only: forceColorScheme ignores the OS setting.
  <MantineProvider theme={theme} forceColorScheme="dark">
    <Notifications position="top-right" />
    <App />
  </MantineProvider>,
);
