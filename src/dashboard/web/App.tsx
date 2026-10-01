import { Center, Loader } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import { Redirect, Route, Switch } from "wouter";
import type { MeResponse } from "../api/types";
import { api, setUnauthorizedHandler } from "./api-client";
import { HistoryPage } from "./pages/HistoryPage";
import { HomePage } from "./pages/HomePage";
import { LoginPage } from "./pages/LoginPage";

/** undefined while checking; null when logged out. */
type Me = MeResponse | null | undefined;

export function App() {
  const [me, setMe] = useState<Me>(undefined);

  const checkSession = useCallback(() => {
    api.me().then(setMe, () => setMe(null));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    checkSession();
  }, [checkSession]);

  if (me === undefined) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  const loggedOut = () => setMe(null);
  return (
    <Switch>
      <Route path="/login">{me ? <Redirect to="/" /> : <LoginPage onLoggedIn={checkSession} />}</Route>
      <Route path="/">{me ? <HomePage mode={me.mode} onLoggedOut={loggedOut} /> : <Redirect to="/login" />}</Route>
      <Route path="/history">{me ? <HistoryPage mode={me.mode} onLoggedOut={loggedOut} /> : <Redirect to="/login" />}</Route>
      <Route>
        <Redirect to="/" />
      </Route>
    </Switch>
  );
}
