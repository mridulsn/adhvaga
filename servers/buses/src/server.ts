// Adhvaga Buses MCP server. Read-only: simulated (demo) intercity buses, and turning a bus YOU booked into a trip leg.
// No tool here saves data, books or pays; legs are added through the Trip server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fail } from "./envelope.ts";
import type { Envelope } from "./envelope.ts";
import { BusesService, SERVER } from "./service.ts";

const place = z.string().min(1).max(80);

export interface ToolDef { name: string; description: string; shape: z.ZodRawShape; run: (a: any) => Envelope } // eslint-disable-line @typescript-eslint/no-explicit-any

export function toolDefs(svc: BusesService): ToolDef[] {
  return [
    { name: "list_bus_cities", description: "Cities the demo bus search knows, and what the bus labels mean. There is no real intercity bus data.", shape: {}, run: () => svc.listCities() },
    {
      name: "search_buses",
      description: "SIMULATED intercity buses between two Indian cities, for comparison only. Every answer is labelled Simulated, low confidence, in the demo_options group; never a verified replacement and never bookable.",
      shape: {
        from: place.describe('City, e.g. "Jaipur"'),
        to: place.describe('City, e.g. "Ajmer"'),
        date: z.string().optional().describe("YYYY-MM-DD, India time. Default today"),
        depart_after: z.string().optional().describe("HH:MM, 24 h. Default now (today) or 00:00 (other dates)"),
      },
      run: (a) => svc.searchBuses(a),
    },
    {
      name: "add_user_bus",
      description: "Turn a bus YOU booked into a trip leg labelled You entered (plus the record_booking details if you give the price). Does not save anything: pass the leg to the Trip server's add_leg. No PNR, names or phone numbers.",
      shape: {
        from: place, to: place,
        depart_at: z.string().describe("ISO date-time with offset, e.g. 2026-11-21T07:00:00+05:30"),
        arrive_at: z.string().describe("ISO date-time with offset"),
        operator: z.string().max(80).optional(),
        service_no: z.string().max(40).optional(),
        price_rupees: z.union([z.string(), z.number()]).optional().describe('What you paid, e.g. "450"'),
      },
      run: (a) => svc.addUserBus(a),
    },
  ];
}

export function runTool(def: ToolDef, args: unknown): Envelope {
  const parsed = z.object(def.shape).safeParse(args ?? {});
  if (!parsed.success) return { ...fail("BAD_INPUT", "Input does not match the tool schema.", parsed.error.issues), source: SERVER };
  try {
    return def.run(parsed.data);
  } catch (e) {
    console.error(e);
    return { ...fail("INTERNAL", "The buses server hit an error."), source: SERVER };
  }
}

export function buildServer(svc: BusesService): McpServer {
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
  await buildServer(new BusesService()).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() as string)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
