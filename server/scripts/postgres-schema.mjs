// Generates prisma/postgres/schema.prisma from prisma/schema.prisma.
//
// Prisma cannot pick a datasource provider from an environment variable, so
// development (SQLite, zero install) and production (Postgres) need two schema
// files. Hand-maintaining both is how they drift apart, so the Postgres one is
// generated: same models, provider swapped. Run after every schema change:
//
//   npm run db:pg:sync            regenerate the file
//   npm run db:pg:sync -- --check exit 1 if the file is stale (CI uses this)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "prisma", "schema.prisma");
const target = join(root, "prisma", "postgres", "schema.prisma");

const HEADER = `// GENERATED from ../schema.prisma by scripts/postgres-schema.mjs.
// Do not edit by hand: change ../schema.prisma, then run \`npm run db:pg:sync\`.
// Production (the Docker image) builds and migrates against this file.

`;

const input = readFileSync(source, "utf8");
const swapped = input.replace(
  /(datasource\s+db\s*\{[^}]*?provider\s*=\s*)"sqlite"/,
  '$1"postgresql"',
);

if (swapped === input) {
  console.error(`[db:pg:sync] could not find provider = "sqlite" in ${source}`);
  process.exit(1);
}

const output = HEADER + swapped;

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== output) {
    console.error(
      "[db:pg:sync] prisma/postgres/schema.prisma is out of date.\n" +
        "Run `npm run db:pg:sync` and create a migration (see docs/10-DEPLOYMENT.md).",
    );
    process.exit(1);
  }
  console.log("[db:pg:sync] postgres schema is in sync");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, output);
  console.log(`[db:pg:sync] wrote ${target}`);
}
