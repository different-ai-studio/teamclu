import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCatalog, pickImageRoute } from "../src/catalog.js";
import {
  countImages, prepareImageUpstream, pricePerImage, readImageUsage, readUsage,
} from "../src/proxy.js";

const ENV = { DEEPSEEK_API_KEY: "k1", OPENAI_API_KEY: "k2" } as NodeJS.ProcessEnv;
const SHIPPED = readFileSync(
  new URL("../../../deploy/self-host/ai/catalog.example.yaml", import.meta.url),
  "utf8",
);
const cat = parseCatalog(SHIPPED, ENV);
const pricing = cat.image_models.image.pricing;

test("an image tier never leaks into the chat model list", () => {
  // public_models is served verbatim to clients and drives the desktop's model
  // picker. An image id in there is a model the user can select and never use.
  for (const id of Object.keys(cat.image_models)) {
    assert.ok(!(id in cat.public_models), `${id} must not be a chat tier`);
  }
});

test("price lookup goes most-specific first", () => {
  assert.equal(pricePerImage(pricing, "1024x1024", "high"), 4_500_000);
  assert.equal(pricePerImage(pricing, "1024x1024", undefined), 1_500_000);
  // A quality with no exact key falls back to the size, not to `default`.
  assert.equal(pricePerImage(pricing, "1024x1536", "medium"), 2_250_000);
  assert.equal(pricePerImage(pricing, undefined, undefined), 1_500_000);
});

test("a size we have not priced is refused, not charged the default", () => {
  // The whole point: an unrecognised size is most likely a new, expensive tier
  // the upstream just shipped. Serving it at the cheapest price we happen to
  // have is how a catalogue gap becomes free images.
  assert.equal(pricePerImage(pricing, "4096x4096"), null);
  assert.equal(pricePerImage(pricing, "4096x4096", "high"), null);
});

test("the chat usage parser reads ZEROS off an image response", () => {
  // Not a hypothetical: images report input_tokens/output_tokens while chat
  // reports prompt_tokens/completion_tokens. Reusing readUsage here would look
  // like a working meter that records nothing, so images need their own parser.
  const body = {
    usage: {
      input_tokens: 59, output_tokens: 515, total_tokens: 574,
      output_tokens_details: { image_tokens: 515, text_tokens: 0 },
    },
  };
  const wrong = readUsage(body);
  assert.equal(wrong?.inputTokens, 0);
  assert.equal(wrong?.outputTokens, 0);

  const right = readImageUsage(body);
  assert.equal(right?.inputTokens, 59);
  assert.equal(right?.outputTokens, 515);
});

test("images are counted from what came back, not what was asked for", () => {
  assert.equal(countImages({ data: [{ b64_json: "a" }, { b64_json: "b" }] }), 2);
  assert.equal(countImages({ data: [] }), 0);
  assert.equal(countImages(null), 0);
});

test("the image request keeps the prompt and targets the images path", () => {
  // filterBody with the CHAT allowlist would drop `prompt` entirely and send
  // the upstream an empty request — the reason default_image_params exists.
  const picked = pickImageRoute(cat, "image", 0)!;
  const p = prepareImageUpstream(
    cat, picked.provider, picked.backend,
    { model: "image", prompt: "a red leaf", size: "1024x1024", messages: [{ role: "user" }] },
    "sk-test", new AbortController().signal,
  );
  assert.ok(p.url.endsWith("/images/generations"), p.url);
  const sent = JSON.parse(String(p.init.body));
  assert.equal(sent.prompt, "a red leaf");
  assert.equal(sent.model, "gpt-image-2", "the upstream name, not our public id");
  assert.ok(!("messages" in sent), "chat-only keys are dropped");
});

test("an image tier with no default price refuses to start", () => {
  // Every lookup can fall through to `default`, so its absence is not a partial
  // catalogue — it is an unpriced product that would serve for free.
  const broken = SHIPPED.replace("        default: 1500000\n", "");
  assert.throws(() => parseCatalog(broken, ENV), /needs pricing.per_image_credits.default/);
});

test("a non-positive or fractional image price refuses to start", () => {
  assert.throws(
    () => parseCatalog(SHIPPED.replace("default: 1500000", "default: 0"), ENV),
    /must be a positive integer/,
  );
  assert.throws(
    () => parseCatalog(SHIPPED.replace("default: 1500000", "default: 1.5"), ENV),
    /must be a positive integer/,
  );
});

test("an image tier routing to an unknown backend refuses to start", () => {
  assert.throws(
    () => parseCatalog(SHIPPED.replace("- backend: mx5-gpt-image-2", "- backend: nope"), ENV),
    /image model image routes to unknown backend nope/,
  );
});
