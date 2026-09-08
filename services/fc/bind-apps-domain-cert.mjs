#!/usr/bin/env node
//
// bind-apps-domain-cert.mjs — put a TLS certificate on the wildcard custom
// domain that serves deployed apps, and turn HTTPS on.
//
// WHY THIS EXISTS AS A SCRIPT
//
// Deployed apps are reached at `<slug>-<id8>.<APPS_PUBLIC_DOMAIN>`, and that
// wildcard name is an Alibaba Function Compute custom domain. FC serves a
// certificate only if one was UPLOADED to the domain: `certConfig` is a PEM
// snapshot with no link to the certificate manager, so nothing renews it. When
// the snapshot expires the whole apps zone fails its TLS handshake while every
// service behind it is perfectly healthy. mx5.cn runs Let's Encrypt, so this
// has to be rerun about every three months.
//
// Serving apps over plain HTTP is not merely untidy. Browsers attach
// `Sec-Fetch-*` metadata only to trustworthy origins, so on HTTP a framework's
// CSRF guard loses the header it relies on (see `fillFetchMetadata` in
// src/lib/apps-vanity.ts, which exists to paper over exactly that).
//
// The aliyun CLI cannot address this domain at all: its gateway rejects the `*`
// with `Illegal Path Character`. The SDK encodes it correctly, which is why
// this is a Node script and not a shell one.
//
// USAGE
//
//   node bind-apps-domain-cert.mjs --from-cas <certId>     # dry run
//   node bind-apps-domain-cert.mjs --from-cas <certId> --apply
//   node bind-apps-domain-cert.mjs --cert full.pem --key priv.key --apply
//
//   --domain <name>   default `*.apps.mx5.cn`
//   --region <name>   default cn-shenzhen (where the app functions live)
//   --profile <name>  aliyun CLI profile for credentials, default `belayo`
//
// Credentials come from ALIBABA_CLOUD_ACCESS_KEY_ID / _SECRET when set, and
// otherwise from the named aliyun CLI profile.
//
// `--from-cas` reads the PEM out of Certificate Management, which is where the
// renewed certificate lands. Note its `Cert` field is the full chain as one
// string; `CertChain` is a list of metadata dicts and is NOT a PEM.
//
// Dry run by default: it prints what would change and touches nothing.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import FcClient from "@alicloud/fc20230330";
import { Config } from "@alicloud/openapi-client";

function parseArgs(argv) {
  const out = {
    domain: "*.apps.mx5.cn",
    region: "cn-shenzhen",
    profile: "belayo",
    apply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--from-cas") out.fromCas = argv[++i];
    else if (a === "--cert") out.cert = argv[++i];
    else if (a === "--key") out.key = argv[++i];
    else if (a === "--domain") out.domain = argv[++i];
    else if (a === "--region") out.region = argv[++i];
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

/** AK/SK from the environment, else from the named aliyun CLI profile. */
function credentials(profileName) {
  const id = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim();
  const secret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim();
  if (id && secret) return { accessKeyId: id, accessKeySecret: secret };

  const file = path.join(process.env.HOME ?? "", ".aliyun", "config.json");
  if (!fs.existsSync(file)) {
    die(
      "no credentials: set ALIBABA_CLOUD_ACCESS_KEY_ID/_SECRET, " +
        `or configure the aliyun CLI (${file} not found)`,
    );
  }
  const profile = JSON.parse(fs.readFileSync(file, "utf8")).profiles?.find(
    (p) => p.name === profileName,
  );
  if (!profile?.access_key_id) die(`aliyun CLI profile '${profileName}' has no access key`);
  return { accessKeyId: profile.access_key_id, accessKeySecret: profile.access_key_secret };
}

/**
 * The FC 3.0 data plane is ACCOUNT-scoped: `<accountId>.<region>.fc.aliyuncs.com`.
 * Read the account id off the credential rather than hardcoding it.
 */
function accountId(profileName) {
  const out = execFileSync(
    "aliyun",
    ["sts", "GetCallerIdentity", "--profile", profileName],
    { encoding: "utf8" },
  );
  const id = JSON.parse(out).AccountId;
  if (!id) die("could not determine the account id from sts:GetCallerIdentity");
  return id;
}

/** Pull the certificate and its private key out of Certificate Management. */
function certFromCas(certId, profileName) {
  const out = execFileSync(
    "aliyun",
    [
      "cas", "GetUserCertificateDetail",
      "--CertId", String(certId),
      "--region", "cn-hangzhou",
      "--profile", profileName,
    ],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  const d = JSON.parse(out);
  if (!d.Cert || !d.Key) {
    die(`CAS certificate ${certId} has no Cert/Key — is it an uploaded certificate?`);
  }
  return { certificate: d.Cert, privateKey: d.Key, name: d.Name, endDate: d.EndDate, sans: d.Sans };
}

/** Summarise a PEM chain without shelling out to openssl. */
function describeCert(pem) {
  const blocks = (pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
  return `${blocks} certificate block(s), ${pem.length} bytes`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n")
      .filter((l) => l.startsWith("//")).join("\n"));
    return;
  }

  let material;
  if (args.fromCas) {
    material = certFromCas(args.fromCas, args.profile);
    console.log(`CAS certificate ${args.fromCas}: ${material.name} — SANs ${material.sans}, expires ${material.endDate}`);
  } else if (args.cert && args.key) {
    material = {
      certificate: fs.readFileSync(args.cert, "utf8"),
      privateKey: fs.readFileSync(args.key, "utf8"),
      name: path.basename(args.cert),
    };
  } else {
    die("give either --from-cas <certId>, or both --cert <file> and --key <file>");
  }

  // A wildcard covers exactly one label. `*.mx5.cn` does NOT match
  // `app.apps.mx5.cn`, and binding it here would leave every app failing its
  // handshake with a certificate that looks present and correct.
  const wanted = args.domain.startsWith("*.") ? args.domain : `*.${args.domain}`;
  if (material.sans && !String(material.sans).split(/[,\s]+/).includes(wanted)) {
    die(
      `certificate does not cover ${wanted} (SANs: ${material.sans}). ` +
        "A wildcard matches one label only, so a *.<parent> certificate cannot serve this zone.",
    );
  }

  const { accessKeyId, accessKeySecret } = credentials(args.profile);
  const client = new FcClient.default(new Config({
    accessKeyId,
    accessKeySecret,
    endpoint: `${accountId(args.profile)}.${args.region}.fc.aliyuncs.com`,
    protocol: "https",
    readTimeout: 60000,
    connectTimeout: 15000,
  }));

  const current = (await client.getCustomDomain(args.domain))?.body ?? {};
  console.log(
    `\n${args.domain} now: protocol=${current.protocol}, ` +
      `cert=${current.certConfig?.certName ?? "none"}, ` +
      `routes -> ${current.routeConfig?.routes?.map((r) => r.functionName).join(", ")}`,
  );

  // Everything but certConfig is echoed back deliberately. An update omitting
  // routeConfig/authConfig/wafConfig CLEARS them, which on this domain means
  // every deployed app stops resolving to a function at all.
  const body = {
    protocol: "HTTP,HTTPS",
    routeConfig: current.routeConfig,
    authConfig: current.authConfig,
    wafConfig: current.wafConfig,
    ...(current.tlsConfig ? { tlsConfig: current.tlsConfig } : {}),
    certConfig: {
      certName: material.name || "apps-wildcard",
      certificate: material.certificate,
      privateKey: material.privateKey,
    },
  };

  console.log(
    `would set: protocol=HTTP,HTTPS, certName=${body.certConfig.certName} ` +
      `(${describeCert(material.certificate)}), routes and auth/waf preserved`,
  );

  if (!args.apply) {
    console.log("\nDry run — nothing changed. Re-run with --apply.");
    return;
  }

  await client.updateCustomDomain(args.domain, { body });
  const after = (await client.getCustomDomain(args.domain))?.body ?? {};
  console.log(
    `\nDone. ${args.domain}: protocol=${after.protocol}, ` +
      `cert=${after.certConfig?.certName ?? "none"}, ` +
      `routes -> ${after.routeConfig?.routes?.map((r) => r.functionName).join(", ")}`,
  );
  console.log(
    "Verify from outside:\n" +
      `  echo | openssl s_client -connect <app>.${args.domain.replace(/^\*\./, "")}:443 ` +
      `-servername <app>.${args.domain.replace(/^\*\./, "")} | openssl x509 -noout -subject -dates`,
  );
}

main().catch((e) => die(e?.message ?? String(e)));
