// Entry points bundled into api/<name>.js. Data files live in api/_data (underscore: never served, never a function).
import { join } from "node:path";
import { buildServer as buildMetro } from "../../servers/metro/src/server.ts";
import { MetroService } from "../../servers/metro/src/service.ts";
import { buildServer as buildBuses } from "../../servers/buses/src/server.ts";
import { BusesService } from "../../servers/buses/src/service.ts";
import { buildServer as buildKnowledge } from "../../servers/knowledge/src/server.ts";
import { KnowledgeService } from "../../servers/knowledge/src/service.ts";
import { loadLibrary } from "../../servers/knowledge/src/library.ts";
import { mcpHandler } from "./http.ts";
export { planHandler } from "./plan/plan.ts";

const DATA = () => join(process.cwd(), "api", "_data");

let metro: MetroService | null = null;
export const metroHandler = mcpHandler("adhvaga-metro", () => buildMetro((metro ??= new MetroService({ root: join(DATA(), "metro") }))), {
  tools: ["list_cities", "list_stations", "find_station", "route_between_stations"],
  attribution: ["Contains data provided by Kochi Metro Rail Limited.", "Contains data provided by Hyderabad Metro Rail Ltd."],
});

const buses = new BusesService();
export const busesHandler = mcpHandler("adhvaga-buses", () => buildBuses(buses), {
  tools: ["list_bus_cities", "search_buses", "add_user_bus"],
  note: "Intercity buses are SIMULATED demo data; no free bus data exists in India.",
});

let knowledge: KnowledgeService | null = null;
export const knowledgeHandler = mcpHandler(
  "adhvaga-knowledge",
  () => buildKnowledge((knowledge ??= new KnowledgeService({ library: loadLibrary(join(DATA(), "library.json")) }))),
  { tools: ["list_rule_documents", "search_rules", "get_passage"], sources: ["DGCA CAR Section 3 Series M Part IV Rev. 4", "Indian Railways refund rules (2015)", "IRCTC e-ticket cancellation page"] },
);
