import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const plugin = require("../../plugins/withTeamCluMqtt");

describe("withTeamCluMqtt config plugin helpers", () => {
  it("adds the HiveMQ dependency once", () => {
    const gradle = 'dependencies {\n    implementation("com.facebook.react:react-android")\n}';

    const once = plugin.addMqttDependency(gradle);
    const twice = plugin.addMqttDependency(once);

    expect(once).toContain('implementation("com.hivemq:hivemq-mqtt-client:1.3.3")');
    expect(twice.match(/com\.hivemq:hivemq-mqtt-client/g)).toHaveLength(1);
  });

  it("excludes duplicate Netty Java resources once", () => {
    const gradle = [
      "android {",
      "    packagingOptions {",
      "        jniLibs {",
      "            useLegacyPackaging false",
      "        }",
      "    }",
      "}",
    ].join("\n");

    const once = plugin.addMqttPackagingExcludes(gradle);
    const twice = plugin.addMqttPackagingExcludes(once);

    expect(once).toContain("excludes += 'META-INF/INDEX.LIST'");
    expect(once).toContain("excludes += 'META-INF/io.netty.versions.properties'");
    expect(twice.match(/META-INF\/INDEX\.LIST/g)).toHaveLength(1);
    expect(twice.match(/META-INF\/io\.netty\.versions\.properties/g)).toHaveLength(1);
  });

  it("registers the React package once", () => {
    const mainApplication = [
      "          override fun getPackages(): List<ReactPackage> {",
      "            val packages = PackageList(this).packages",
      "            // Packages that cannot be autolinked yet can be added manually here, for example:",
      "            // packages.add(MyReactNativePackage())",
      "            return packages",
      "          }",
    ].join("\n");

    const once = plugin.addPackageRegistration(mainApplication);
    const twice = plugin.addPackageRegistration(once);

    expect(once).toContain("packages.add(TeamCluMqttPackage())");
    expect(twice.match(/TeamCluMqttPackage/g)).toHaveLength(1);
  });

  it("registers the package in the SDK 57 PackageList.apply template", () => {
    const mainApplication = [
      "        packageList =",
      "          PackageList(this).packages.apply {",
      "            // Packages that cannot be autolinked yet can be added manually here, for example:",
      "            // add(MyReactNativePackage())",
      "          }",
    ].join("\n");

    const once = plugin.addPackageRegistration(mainApplication);
    const twice = plugin.addPackageRegistration(once);

    expect(once).toContain("            // add(MyReactNativePackage())\n            add(TeamCluMqttPackage())");
    expect(twice.match(/TeamCluMqttPackage/g)).toHaveLength(1);
  });

  it("fails the prebuild when MainApplication has no known anchor", () => {
    expect(() => plugin.addPackageRegistration("class MainApplication {}")).toThrow(/TeamCluMqttPackage/);
  });

  it("adds the CocoaMQTT pod once", () => {
    const podfile = [
      "platform :ios, '15.1'",
      "",
      "target 'TeamCluExpo' do",
      "  use_expo_modules!",
      "end",
    ].join("\n");

    const once = plugin.addCocoaMqttPod(podfile);
    const twice = plugin.addCocoaMqttPod(once);

    expect(once).toContain("pod 'CocoaMQTT', '~> 2.2.3'");
    expect(twice.match(/pod 'CocoaMQTT'/g)).toHaveLength(1);
    // CocoaMQTT is Swift and depends on the Objective-C MqttCocoaAsyncSocket,
    // which ships no module map — without this `pod install` refuses to
    // integrate it as a static library at all.
    expect(once).toContain("pod 'MqttCocoaAsyncSocket', :modular_headers => true");
    expect(twice.match(/MqttCocoaAsyncSocket/g)).toHaveLength(1);
  });
});

describe("writeMqttModuleFiles", () => {
  it("emits the Kotlin sources into the app's own package", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mqtt-plugin-"));

    plugin.writeMqttModuleFiles(projectRoot, "com.teamclu");

    const dir = join(projectRoot, "android/app/src/main/java/com/teamclu");
    const module = readFileSync(join(dir, "TeamCluMqttModule.kt"), "utf8");
    const pkg = readFileSync(join(dir, "TeamCluMqttPackage.kt"), "utf8");

    // The declared package has to match the directory, or Android never finds
    // the class and `TeamCluMqttPackage()` fails to resolve at build time.
    expect(module.startsWith("package com.teamclu\n")).toBe(true);
    expect(pkg.startsWith("package com.teamclu\n")).toBe(true);
  });

  it("follows a renamed applicationId rather than a baked-in one", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mqtt-plugin-"));

    plugin.writeMqttModuleFiles(projectRoot, "com.example.renamed");

    const module = readFileSync(
      join(projectRoot, "android/app/src/main/java/com/example/renamed/TeamCluMqttModule.kt"),
      "utf8",
    );
    expect(module.startsWith("package com.example.renamed\n")).toBe(true);
  });

  it("refuses to emit without an applicationId", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "mqtt-plugin-"));
    expect(() => plugin.writeMqttModuleFiles(projectRoot, undefined)).toThrow(
      /android\.package is required/,
    );
  });
});

describe("addIosSourceFiles", () => {
  // The files were written to ios/ but never added to the target, so no iOS
  // build ever compiled the native client and MQTT silently never connected.
  it("adds both generated files to the app target, once", async () => {
    const { vi } = await import("vitest");
    const { IOSConfig } = require("expo/config-plugins");
    const added: string[] = [];
    const spy = vi
      .spyOn(IOSConfig.XcodeUtils, "addBuildSourceFileToGroup")
      .mockImplementation((...raw: unknown[]) => {
        const args = raw[0] as { filepath: string; groupName: string };
        expect(args.groupName).toBe("TeamCluExpo");
        added.push(args.filepath);
      });
    const project = { hasFile: (p: string) => added.includes(p) };

    plugin.addIosSourceFiles(project, "TeamCluExpo");
    plugin.addIosSourceFiles(project, "TeamCluExpo");

    expect(added).toEqual(["TeamCluExpo/TeamCluMqtt.swift", "TeamCluExpo/TeamCluMqttBridge.m"]);
    spy.mockRestore();
  });
});
