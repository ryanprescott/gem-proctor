// P0 test run (SPEC §11.0, P0.md S18 / build step 3): Fastify and the plugins we need, on Bun.
// Recorded in docs/P0-test-runs.md. No database needed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";

describe("test run: Fastify plugins on Bun", () => {
  test("runtime is Bun", () => {
    expect(typeof Bun.version).toBe("string");
  });

  test("fastify-type-provider-zod validates requests and serializes responses", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.post(
      "/echo",
      { schema: { body: z.object({ n: z.number().int() }), response: { 200: z.object({ doubled: z.number() }) } } },
      async (req) => ({ doubled: req.body.n * 2, extra: "stripped" }) as { doubled: number },
    );
    const ok = await app.inject({ method: "POST", url: "/echo", payload: { n: 21 } });
    expect(ok.json()).toEqual({ doubled: 42 });
    const bad = await app.inject({ method: "POST", url: "/echo", payload: { n: "x" } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  test("@fastify/cookie: signed, httpOnly cookies round-trip", async () => {
    const app = Fastify();
    await app.register(cookie, { secret: "a".repeat(32) });
    app.get("/set", async (_req, reply) => {
      reply.setCookie("s", "value", { signed: true, httpOnly: true, sameSite: "lax", secure: true, path: "/" });
      return {};
    });
    app.get("/read", async (req) => req.unsignCookie(req.cookies.s ?? ""));
    const set = await app.inject({ method: "GET", url: "/set" });
    const c = set.cookies[0];
    expect(c).toMatchObject({ name: "s", httpOnly: true, sameSite: "Lax", secure: true });
    const read = await app.inject({ method: "GET", url: "/read", headers: { cookie: `s=${c?.value}` } });
    expect(read.json()).toMatchObject({ valid: true, value: "value" });
    const forged = await app.inject({ method: "GET", url: "/read", headers: { cookie: "s=value.forged" } });
    expect(forged.json().valid).toBe(false);
    await app.close();
  });

  test("@fastify/rate-limit: per-route limit returns 429", async () => {
    const app = Fastify();
    await app.register(rateLimit, { global: false });
    app.get("/limited", { config: { rateLimit: { max: 2, timeWindow: 60_000 } } }, async () => ({}));
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) codes.push((await app.inject({ method: "GET", url: "/limited" })).statusCode);
    expect(codes).toEqual([200, 200, 429]);
    await app.close();
  });

  test("@fastify/multipart: file upload with size limit", async () => {
    const app = Fastify();
    await app.register(multipart);
    app.post("/upload", async (req) => {
      const file = await req.file({ limits: { fileSize: 16 } });
      const buf = await file?.toBuffer().catch(() => null);
      return { name: file?.filename, size: buf?.length ?? null, truncated: file?.file.truncated ?? false };
    });
    const body = (content: string) =>
      `--b\r\nContent-Disposition: form-data; name="file"; filename="q.json"\r\nContent-Type: application/json\r\n\r\n${content}\r\n--b--\r\n`;
    const headers = { "content-type": "multipart/form-data; boundary=b" };
    const ok = await app.inject({ method: "POST", url: "/upload", payload: body('{"a":1}'), headers });
    expect(ok.json()).toEqual({ name: "q.json", size: 7, truncated: false });
    const big = await app.inject({ method: "POST", url: "/upload", payload: body("x".repeat(100)), headers });
    expect(big.json().size).toBeNull();
    await app.close();
  });

  test("@fastify/swagger: OpenAPI generated from Zod route schemas", async () => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(swagger, { openapi: { info: { title: "t", version: "1" } }, transform: jsonSchemaTransform });
    app.get(
      "/thing",
      { schema: { querystring: z.object({ q: z.string() }), response: { 200: z.object({ id: z.uuid() }) } } },
      async () => ({
        id: crypto.randomUUID(),
      }),
    );
    await app.ready();
    const doc = app.swagger() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toStartWith("3.");
    expect(doc.paths).toHaveProperty("/thing");
    await app.close();
  });

  test("@fastify/static: sendFile serves the built web app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gem-static-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>");
    const app = Fastify();
    await app.register(fastifyStatic, { root: dir, serve: false });
    app.get("/*", async (_req, reply) => reply.sendFile("index.html"));
    const res = await app.inject({ method: "GET", url: "/some/spa/route" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>x</title>");
    await app.close();
  });

  test("a real listening server (not just inject) answers over HTTP", async () => {
    const app = Fastify();
    app.get("/ping", async () => ({ pong: true }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(await res.json()).toEqual({ pong: true });
    await app.close();
  });
});
