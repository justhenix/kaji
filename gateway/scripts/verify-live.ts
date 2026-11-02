import assert from "node:assert/strict";
const url = process.env.KAJI_GATEWAY_URL ?? "https://kaji-gateway.relanta.workers.dev/v1";
const token = process.env.KAJI_GATEWAY_TOKEN;
if (!token) throw new Error("Set runtime KAJI_GATEWAY_TOKEN");
const request = (body: unknown, authorization = `Bearer ${token}`) => fetch(`${url}/chat/completions`, {
  method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(65000),
});
const body = { model: "minimax-m3.1-flash", messages: [{ role: "user", content: "Reply with exactly KAJI_OK" }], max_tokens: 128, reasoning_effort: "low" };
assert.equal((await request(body, "")).status, 401);
assert.equal((await request(body, `Bearer ${"x".repeat(64)}`)).status, 401);
assert.equal((await request({ ...body, model: "not-allowed" })).status, 400);
assert.equal((await request({ ...body, max_tokens: 99999 })).status, 400);
for (const stream of [false, true]) {
  const response = await request({ ...body, stream });
  assert.equal(response.status, 200, await response.clone().text());
  const text = await response.text();
  if (stream) { assert.ok(text.includes("[DONE]")); assert.ok(text.includes("KAJI_OK") || text.includes("JI_OK")); }
  else assert.equal(JSON.parse(text).choices[0].message.content.trim(), "KAJI_OK");
}
console.log("PASS: deployed gateway rejects absent/wrong credentials, unauthorized model and excess output; real JSON and SSE inference return KAJI_OK. Sequential requests release global lease.");
