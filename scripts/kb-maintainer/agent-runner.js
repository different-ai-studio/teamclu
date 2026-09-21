"use strict";

const fake = require("./fake-runner");
const pi = require("./pi-runner");

async function compile(ctx) {
  if (ctx.runner === "pi") {
    return pi.compile(ctx);
  }
  return fake.compile(ctx);
}

module.exports = { compile };
