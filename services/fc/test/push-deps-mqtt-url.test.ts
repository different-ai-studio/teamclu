import { test } from "node:test";
import assert from "node:assert/strict";
import { mqttPublisherUrl } from "../src/lib/push-deps.js";

const BROKER = "mqtt://127.0.0.1:1883";
const INTERNAL = "mqtt://emqx:1883";

test("publisher dials MQTT_INTERNAL_URL when it is set", () => {
  assert.equal(
    mqttPublisherUrl({ MQTT_INTERNAL_URL: INTERNAL, MQTT_BROKER_URL: BROKER }),
    INTERNAL,
  );
});

test("publisher falls back to MQTT_BROKER_URL when internal is unset", () => {
  assert.equal(
    mqttPublisherUrl({ MQTT_BROKER_URL: "wss://mqtt.service.ucar.cc/mqtt" }),
    "wss://mqtt.service.ucar.cc/mqtt",
  );
});

test("a blank MQTT_INTERNAL_URL is absent, including whitespace", () => {
  for (const blank of ["", "   ", "\n"]) {
    assert.equal(
      mqttPublisherUrl({ MQTT_INTERNAL_URL: blank, MQTT_BROKER_URL: BROKER }),
      BROKER,
    );
  }
});

test("publisher has no url when both addresses are blank", () => {
  assert.equal(mqttPublisherUrl({ MQTT_INTERNAL_URL: "", MQTT_BROKER_URL: "  " }), "");
  assert.equal(mqttPublisherUrl({}), "");
});
