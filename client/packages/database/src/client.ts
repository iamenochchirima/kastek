import { PrismaClient } from "./generated/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function loadEnvFiles() {
  if (process.env.DATABASE_URL) return;

  const cwd = process.cwd();
  const candidatePaths = [
    path.resolve(cwd, ".env.local"),
    path.resolve(cwd, ".env"),
    path.resolve(cwd, "../.env.local"),
    path.resolve(cwd, "../.env"),
    path.resolve(cwd, "../../.env.local"),
    path.resolve(cwd, "../../.env"),
  ];

  for (const envPath of candidatePaths) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, override: false });
    }
  }
}

function createPrismaClient() {
  loadEnvFiles();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
