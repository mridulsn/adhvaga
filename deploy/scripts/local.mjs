// Local stand-in for Vercel: serves api/<name>.js handlers on http://127.0.0.1:8790/api/<name>
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(HERE);
const handlers = {};
for (const n of ["metro", "buses", "knowledge", "plan"]) handlers[n] = (await import(pathToFileURL(join(HERE, "api", `${n}.js`)).href)).default;

const port = Number(process.env.PORT ?? 8790);
createServer((req, res) => {
  const m = /^\/api\/([a-z]+)/.exec(req.url ?? "");
  const h = m && handlers[m[1]];
  if (!h) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  h(req, res);
}).listen(port, "127.0.0.1", () => console.log(`listening on http://127.0.0.1:${port}/api/{metro,buses,knowledge,plan}`));
