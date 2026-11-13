// Bundles the MCP servers into api/_lib/entries.js and copies their data into api/_data.
// api/metro.js, api/buses.js, api/knowledge.js, api/plan.js are one-line Vercel functions that re-export a handler.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS = join(HERE, "..", "servers");
const API = join(HERE, "api");

rmSync(API, { recursive: true, force: true });
mkdirSync(join(API, "_lib"), { recursive: true });

await build({
  entryPoints: [join(HERE, "src", "entries.ts")],
  outfile: join(API, "_lib", "entries.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // one copy of the SDK and zod for every server: resolve them from deploy/node_modules (keeps package exports)
  plugins: [{
    name: "one-sdk",
    setup(b) {
      b.onResolve({ filter: /^(@modelcontextprotocol\/sdk|zod)(\/|$)/ }, async (args) => {
        if (args.pluginData === "one-sdk") return undefined;
        const r = await b.resolve(args.path, { kind: args.kind, resolveDir: HERE, pluginData: "one-sdk" });
        return r.errors.length ? { errors: r.errors } : { path: r.path };
      });
    },
  }],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "warning",
});

for (const [file, name] of [["metro", "metroHandler"], ["buses", "busesHandler"], ["knowledge", "knowledgeHandler"], ["plan", "planHandler"]]) {
  writeFileSync(join(API, `${file}.js`), `export { ${name} as default } from "./_lib/entries.js";\n`);
}

cpSync(join(SERVERS, "metro", "feeds"), join(API, "_data", "metro", "feeds"), { recursive: true });
cpSync(join(SERVERS, "knowledge", "library", "library.json"), join(API, "_data", "library.json"));
// The only static file: a short page for people who open the base URL.
mkdirSync(join(HERE, "public"), { recursive: true });
writeFileSync(join(HERE, "public", "index.html"), `<!doctype html><meta charset="utf-8"><title>Adhvaga MCP servers</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}code{background:#f2f2f2;padding:1px 5px}</style>
<h1>Adhvaga MCP servers</h1>
<p>Read-only MCP servers (Streamable HTTP). POST JSON-RPC to:</p>
<ul><li><code>/api/metro</code> - metro routes from official timetables (Kochi, Hyderabad)</li>
<li><code>/api/buses</code> - simulated intercity buses (demo data, clearly labelled)</li>
<li><code>/api/knowledge</code> - official travel rules quoted with section and date</li></ul>
<p>Contains data provided by Kochi Metro Rail Limited. Contains data provided by Hyderabad Metro Rail Ltd.</p>
<p><a href="https://mridulsaravanan.com/">mridulsaravanan.com</a></p>
`);
console.log("bundled -> api/ and public/");
