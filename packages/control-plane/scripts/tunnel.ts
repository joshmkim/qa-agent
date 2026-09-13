/**
 * Relays GitHub webhooks from the App's smee.io channel to the local control
 * plane. Reads SMEE_URL and PORT from packages/control-plane/.env.
 *
 *   pnpm --filter @qa-agent/control-plane tunnel
 */
import "dotenv/config";
import SmeeClient from "smee-client";

const source = process.env.SMEE_URL;
if (!source) {
  console.error("SMEE_URL is not set. Run `pnpm --filter @qa-agent/control-plane create-app` first.");
  process.exit(1);
}
const target = `http://localhost:${process.env.PORT ?? 3001}/webhooks/github`;

const smee = new SmeeClient({ source, target, logger: console });
await smee.start();
console.log(`Forwarding ${source} -> ${target}`);
