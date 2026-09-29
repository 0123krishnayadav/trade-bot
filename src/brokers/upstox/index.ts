import type { BrokerLogin } from "../../core/types";
import { exchangeCode, type UpstoxAppCredentials } from "./auth";
import { waitForLogin } from "./login-server";

/** Upstox's daily browser login: open the link, log in, the local callback saves the token. */
export function createUpstoxLogin(creds: UpstoxAppCredentials): BrokerLogin {
  return {
    login: (onLoginUrl) =>
      waitForLogin({
        apiKey: creds.apiKey,
        redirectUri: creds.redirectUri,
        exchange: (code) => exchangeCode(creds, code),
        onAuthorizeUrl: onLoginUrl,
      }),
  };
}
