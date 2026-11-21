import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

type ReviewPort = {
  get(accountId: string, reviewId: string): Promise<unknown>;
  decide(accountId: string, reviewId: string, approved: boolean): Promise<unknown>;
};

/** Signed-in review decisions requested through the inbound MCP server. */
export function registerMcpReviewRoutes(app: FastifyInstance, options: {
  website: ReviewPort;
  source: ReviewPort;
  configuration: ReviewPort;
  account(request: FastifyRequest): Promise<{ id: string }>;
}) {
  const uuid = z.uuid();
  const reviewId = (request: FastifyRequest) => uuid.parse((request.params as { id: string }).id);
  const decide = (request: FastifyRequest) => z.strictObject({ approved: z.boolean() }).parse(request.body).approved;

  app.get("/api/mcp/website-reviews/:id", async request => options.website.get((await options.account(request)).id, reviewId(request)));
  app.post("/api/mcp/website-reviews/:id/decision", async request =>
    options.website.decide((await options.account(request)).id, reviewId(request), decide(request)));
  app.get("/api/mcp/source-reviews/:id", async request => options.source.get((await options.account(request)).id, reviewId(request)));
  app.post("/api/mcp/source-reviews/:id/decision", async request =>
    options.source.decide((await options.account(request)).id, reviewId(request), decide(request)));
  app.get("/api/mcp/config-reviews/:id", async request => options.configuration.get((await options.account(request)).id, reviewId(request)));
  app.post("/api/mcp/config-reviews/:id/decision", async request =>
    options.configuration.decide((await options.account(request)).id, reviewId(request), decide(request)));
}
