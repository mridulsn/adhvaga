// Cities the simulated bus search knows, with approximate centre coordinates (decimal degrees).
// Used only to make plausible DEMO buses: straight-line distance x a road factor. Not a route planner.

export interface BusCity {
  key: string;
  name: string;
  aliases: string[];
  lat: number;
  lon: number;
}

export const CITIES: BusCity[] = [
  { key: "delhi", name: "Delhi", aliases: ["new delhi", "ndls", "dli"], lat: 28.6139, lon: 77.209 },
  { key: "jaipur", name: "Jaipur", aliases: ["jp"], lat: 26.9124, lon: 75.7873 },
  { key: "ajmer", name: "Ajmer", aliases: ["aii"], lat: 26.4499, lon: 74.6399 },
  { key: "agra", name: "Agra", aliases: ["agc"], lat: 27.1767, lon: 78.0081 },
  { key: "chandigarh", name: "Chandigarh", aliases: ["cdg"], lat: 30.7333, lon: 76.7794 },
  { key: "dehradun", name: "Dehradun", aliases: ["ddn"], lat: 30.3165, lon: 78.0322 },
  { key: "lucknow", name: "Lucknow", aliases: ["lko"], lat: 26.8467, lon: 80.9462 },
  { key: "kanpur", name: "Kanpur", aliases: ["cnb"], lat: 26.4499, lon: 80.3319 },
  { key: "varanasi", name: "Varanasi", aliases: ["banaras", "bsb"], lat: 25.3176, lon: 82.9739 },
  { key: "udaipur", name: "Udaipur", aliases: [], lat: 24.5854, lon: 73.7125 },
  { key: "jodhpur", name: "Jodhpur", aliases: [], lat: 26.2389, lon: 73.0243 },
  { key: "ahmedabad", name: "Ahmedabad", aliases: ["adi", "amdavad"], lat: 23.0225, lon: 72.5714 },
  { key: "mumbai", name: "Mumbai", aliases: ["bombay"], lat: 19.076, lon: 72.8777 },
  { key: "pune", name: "Pune", aliases: ["poona"], lat: 18.5204, lon: 73.8567 },
  { key: "nagpur", name: "Nagpur", aliases: [], lat: 21.1458, lon: 79.0882 },
  { key: "indore", name: "Indore", aliases: [], lat: 22.7196, lon: 75.8577 },
  { key: "bhopal", name: "Bhopal", aliases: [], lat: 23.2599, lon: 77.4126 },
  { key: "goa", name: "Goa (Panaji)", aliases: ["panaji", "panjim"], lat: 15.4909, lon: 73.8278 },
  { key: "bengaluru", name: "Bengaluru", aliases: ["bangalore", "blr", "sbc"], lat: 12.9716, lon: 77.5946 },
  { key: "mysuru", name: "Mysuru", aliases: ["mysore"], lat: 12.2958, lon: 76.6394 },
  { key: "chennai", name: "Chennai", aliases: ["madras", "mas"], lat: 13.0827, lon: 80.2707 },
  { key: "puducherry", name: "Puducherry", aliases: ["pondicherry", "pondy"], lat: 11.9416, lon: 79.8083 },
  { key: "coimbatore", name: "Coimbatore", aliases: ["cbe"], lat: 11.0168, lon: 76.9558 },
  { key: "madurai", name: "Madurai", aliases: [], lat: 9.9252, lon: 78.1198 },
  { key: "kochi", name: "Kochi", aliases: ["cochin", "ernakulam"], lat: 9.9312, lon: 76.2673 },
  { key: "thiruvananthapuram", name: "Thiruvananthapuram", aliases: ["trivandrum"], lat: 8.5241, lon: 76.9366 },
  { key: "hyderabad", name: "Hyderabad", aliases: ["secunderabad"], lat: 17.385, lon: 78.4867 },
  { key: "vijayawada", name: "Vijayawada", aliases: [], lat: 16.5062, lon: 80.648 },
  { key: "visakhapatnam", name: "Visakhapatnam", aliases: ["vizag"], lat: 17.6868, lon: 83.2185 },
  { key: "kolkata", name: "Kolkata", aliases: ["calcutta"], lat: 22.5726, lon: 88.3639 },
  { key: "bhubaneswar", name: "Bhubaneswar", aliases: [], lat: 20.2961, lon: 85.8245 },
  { key: "patna", name: "Patna", aliases: [], lat: 25.5941, lon: 85.1376 },
  { key: "guwahati", name: "Guwahati", aliases: [], lat: 26.1445, lon: 91.7362 },
  { key: "amritsar", name: "Amritsar", aliases: [], lat: 31.634, lon: 74.8723 },
  { key: "shimla", name: "Shimla", aliases: [], lat: 31.1048, lon: 77.1734 },
  { key: "manali", name: "Manali", aliases: [], lat: 32.2432, lon: 77.1892 },
];

export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

export function findCity(q: string): BusCity | null {
  const n = norm(q);
  if (!n) return null;
  for (const c of CITIES) if (c.key === n || norm(c.name) === n || c.aliases.includes(n)) return c;
  // "Delhi ISBT", "Jaipur Sindhi Camp": accept a city name at the start of what was typed
  for (const c of CITIES) for (const name of [c.key, norm(c.name), ...c.aliases]) if (n.startsWith(name + " ")) return c;
  return null;
}

/** Straight-line distance in km (haversine). */
export function crowKm(a: BusCity, b: BusCity): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Roads are not straight; 1.3 is a common rule of thumb for Indian intercity roads. Demo only. */
export const ROAD_FACTOR = 1.3;
