import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { buildOpenApiDocument } from "./openapi.ts";

// Every route file under src/app/api/v1 has a path in the OpenAPI
// description, with the same methods, and nothing is described that does
// not exist.

const V1_DIR = path.join(import.meta.dirname, "../../app/api/v1");

async function listRouteFiles(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(
        ...(await listRouteFiles(
          path.join(dir, entry.name),
          `${prefix}/${entry.name.replace(/^\[(.+)\]$/, "{$1}")}`,
        )),
      );
    } else if (entry.name === "route.ts") {
      found.push(prefix);
    }
  }

  return found;
}

test("the OpenAPI description matches the route files", async () => {
  const { readFile } = await import("node:fs/promises");
  const document = buildOpenApiDocument("https://sign.example.com/api/v1");
  const routes = await listRouteFiles(V1_DIR);

  assert.deepEqual([...routes].sort(), Object.keys(document.paths).sort());

  for (const route of routes) {
    const source = await readFile(
      path.join(V1_DIR, route.replace(/\{(\w+)\}/g, "[$1]"), "route.ts"),
      "utf8",
    );
    const methods = [
      ...source.matchAll(
        /export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g,
      ),
    ]
      .map((match) => match[1]?.toLowerCase())
      .sort();
    const described = Object.keys(
      document.paths[route as keyof typeof document.paths],
    ).sort();

    assert.deepEqual(described, methods, `methods for ${route}`);
  }
});
