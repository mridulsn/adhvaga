// Adhvaga Metro MCP server. Read-only: stations and routes from open metro timetables (GTFS).
// No tool here changes saved data; trip legs it suggests are added through the Trip server.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fail } from "./envelope.ts";
import type { Envelope } from "./envelope.ts";
import { MetroService } from "./service.ts";

const city = z.string().min(1).max(60).describe('City, e.g. "Kochi"');

export interface ToolDef { name: string; description: string; shape: z.ZodRawShape; run: (a: any) => Envelope } // eslint-disable-line @typescript-eslint/no-explicit-any

export function toolDefs(svc: MetroService): ToolDef[] {
  return [
    { name: "list_cities", description: "Cities with verified metro data, what each label means there, and the honest status of every other metro city.", shape: {}, run: () => svc.listCities() },
    { name: "list_stations", description: "All metro stations in a city (from its official timetable).", shape: { city }, run: (a) => svc.listStations(a) },
    { name: "find_station", description: "Match what someone typed to one metro station. Unclear or unknown names come back as found=false with suggestions.", shape: { city, query: z.string().max(80) }, run: (a) => svc.findStation(a) },
    {
      name: "route_between_stations",
      description: "Next metro journeys between two stations in a city: times, changes, fare estimate, and a trip_leg ready for the Trip server. Label Timetable inside the published timetable's dates, Estimated outside them. Never Live.",
      shape: {
        city,
        from: z.string().max(80).describe("Station name or id"),
        to: z.string().max(80).describe("Station name or id"),
        date: z.string().optional().describe("YYYY-MM-DD, India time. Default today"),
        depart_after: z.string().optional().describe("HH:MM, 24 h. Default now (today) or 00:00 (other dates)"),
        count: z.number().int().min(1).max(6).optional().describe("How many journeys, default 3"),
      },
      run: (a) => svc.routeBetweenStations(a),
    },
  ];
}

export function runTool(def: ToolDef, args: unknown): Envelope {
  const parsed = z.object(def.shape).safeParse(args ?? {});
  if (!parsed.success) return { ...fail("BAD_INPUT", "Input does not match the tool schema.", parsed.error.issues), source: "adhvaga-metro" };
  try {
    return def.run(parsed.data);
  } catch (e) {
    console.error(e);
    return { ...fail("INTERNAL", "The metro server hit an error."), source: "adhvaga-metro" };
  }
}

export function buildServer(svc: MetroService): McpServer {
  const server = new McpServer({ name: "adhvaga-metro", version: "0.1.0" });
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
  const svc = new MetroService();
  await buildServer(svc).connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop() as string)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
