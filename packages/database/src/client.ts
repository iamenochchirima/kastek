import { PrismaClient } from "./generated/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import ws from "ws";

neonConfig.webSocketConstructor = ws;

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
  const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
