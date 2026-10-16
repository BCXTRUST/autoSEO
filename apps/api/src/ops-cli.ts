import { createE2BFleet } from "@rakazo/adapters";
import { createDb } from "@rakazo/db";
import { stopEverything } from "./ops.js";

const command = process.argv[2];
if (command !== "stop-all") {
  process.stderr.write("usage: tsx src/ops-cli.ts stop-all\n");
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.E2B_API_KEY;
if (!databaseUrl || !apiKey) {
  process.stderr.write("DATABASE_URL and E2B_API_KEY are required\n");
  process.exit(1);
}

const { prisma, pool } = createDb(databaseUrl);
try {
  const result = await stopEverything({ prisma, fleet: createE2BFleet(apiKey) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await prisma.$disconnect().catch(() => undefined);
  await pool.end().catch(() => undefined);
}
