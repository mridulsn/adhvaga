// Adhvaga Knowledge MCP server. Read-only: official travel rules quoted word for word, with document,
// section, date and link, kept apart from "does it fit your booking". No legal advice.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fail } from "./envelope.ts";
import type { Envelope } from "./envelope.ts";
import { KnowledgeService, SERVER } from "./service.ts";

const booking = z.object({
  ticket_channel: z.enum(["e_ticket", "counter", "unknown"]).optional(),
  ticket_status: z.enum(["confirmed", "rac", "waitlisted", "partially_confirmed", "tatkal", "unreserved", "unknown"]).optional(),
  who_cancelled: z.enum(["railway", "passenger", "airline", "unknown"]).optional(),
  event: z.enum(["flight_cancelled", "flight_delayed", "denied_boarding", "downgraded", "unknown"]).optional(),
  notice: z.enum(["2_weeks_or_more", "24h_to_2_weeks", "under_24h", "unknown"]).optional(),
  cause: z.enum(["airline", "extraordinary", "unknown"]).optional(),
  domestic: z.enum(["yes", "no", "unknown"]).optional(),
  checked_in_on_time: z.enum(["yes", "no", "unknown"]).optional(),
  gave_contact_details: z.enum(["yes", "no", "unknown"]).optional(),
}).describe("What is known about the booking. Leave out what you do not know; Adhvaga will ask.");

export interface ToolDef { name: string; description: string; shape: z.ZodRawShape; run: (a: any) => Envelope } // eslint-disable-line @typescript-eslint/no-explicit-any

export function toolDefs(svc: KnowledgeService): ToolDef[] {
  return [
    { name: "list_rule_documents", description: "Official documents in the rule library (authority, version, effective date, link) and what is NOT in it yet.", shape: {}, run: () => svc.listDocuments() },
    {
      name: "search_rules",
      description: "Find the official rule for a travel question (train refunds, TDR, flight cancellation, delay, denied boarding). Returns passages quoted word for word with section and date, kept apart from whether they fit the booking, plus questions to ask when that depends on unknown facts. Says found=false (I could not find this rule) instead of guessing.",
      shape: {
        question: z.string().min(1).max(300),
        booking: booking.optional(),
        include_superseded: z.boolean().optional().describe("Also show replaced passages (history). Default false"),
        limit: z.number().int().min(1).max(5).optional(),
      },
      run: (a) => svc.searchRules(a),
    },
    { name: "get_passage", description: "One passage in full, its conditions, its document, and the passage that replaced it if it is old.", shape: { passage_id: z.string().max(60) }, run: (a) => svc.getPassage(a) },
  ];
}

export function runTool(def: ToolDef, args: unknown): Envelope {
  const parsed = z.object(def.shape).safeParse(args ?? {});
  if (!parsed.success) return { ...fail("BAD_INPUT", "Input does not match the tool schema.", parsed.error.issues), source: SERVER };
  try {
    return def.run(parsed.data);
  } catch (e) {
    console.error(e);
    return { ...fail("INTERNAL", "The knowledge server hit an error."), source: SERVER };
  }
}

export function buildServer(svc: KnowledgeService): McpServer {
  const server = new McpServer({ name: SERVER, version: "0.1.0" });
  for (const def of toolDefs(svc)) {
    server.registerTool(def.name, {
      description: `[read] ${def.description}`,
      inputSchema: def.shape,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    }, async (args: unknown) => {
      const env = runTool(def, args);
      return { content: [{ type: "text" as const, text: JSON.stringify(env, null, 1) }], isError: env.status === "error" };
    });
  }
  return server;
}

async function main() {
  await buildServer(new KnowledgeService()).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() as string)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
