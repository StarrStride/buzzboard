import { DiscordSDK } from "@discord/embedded-app-sdk";

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;

export function createDiscordSdk() {
  if (!clientId) {
    throw new Error("Missing VITE_DISCORD_CLIENT_ID");
  }

  return new DiscordSDK(clientId);
}