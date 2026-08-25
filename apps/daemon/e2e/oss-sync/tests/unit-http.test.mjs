import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { postJson, getJson, HttpCallError } from "../harness/http.mjs";

function serve(handler) {
  const srv = createServer(handler);
  return new Promise((res) => srv.listen(0, "127.0.0.1", () => res(srv)));
}

test("postJson sends bearer + body and parses json", async () => {
  const srv = await serve((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      assert.equal(req.headers.authorization, "Bearer T");
      assert.equal(JSON.parse(body).a, 1);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const port = srv.address().port;
  const out = await postJson(`http://127.0.0.1:${port}/x`, { a: 1 }, "T");
  assert.deepEqual(out, { ok: true });
  srv.close();
});

test("postJson throws HttpCallError with status+body on non-2xx", async () => {
  const srv = await serve((req, res) => {
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "conflict" }));
  });
  const port = srv.address().port;
  await assert.rejects(
    () => postJson(`http://127.0.0.1:${port}/x`, {}, null),
    (e) => e instanceof HttpCallError && e.status === 409 && /conflict/.test(e.body),
  );
  srv.close();
});

test("getJson appends query and parses", async () => {
  const srv = await serve((req, res) => {
    assert.match(req.url, /teamId=t1/);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ mode: "oss" }));
  });
  const port = srv.address().port;
  const out = await getJson(`http://127.0.0.1:${port}/s`, { teamId: "t1" }, "T");
  assert.equal(out.mode, "oss");
  srv.close();
});
