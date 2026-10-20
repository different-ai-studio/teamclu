const fs = require("fs");
const path = require("path");
const {
  IOSConfig,
  withAppBuildGradle,
  withDangerousMod,
  withMainApplication,
  withPodfile,
  withXcodeProject,
} = require("expo/config-plugins");

const IOS_SOURCE_FILES = ["TeamCluMqtt.swift", "TeamCluMqttBridge.m"];

const MQTT_DEPENDENCY = '    implementation("com.hivemq:hivemq-mqtt-client:1.3.3")';
const PACKAGE_REGISTRATION = "            packages.add(TeamCluMqttPackage())";
// CocoaMQTT is a Swift pod, and it depends on MqttCocoaAsyncSocket, which is
// Objective-C and ships no module map. Swift cannot import such a target when
// pods build as static libraries, and `pod install` refuses outright:
// "The following Swift pods cannot yet be integrated as static libraries."
// Declaring the transitive dependency with `:modular_headers => true` generates
// the module map for that one pod, which is narrower than flipping
// `use_modular_headers!` on for the whole Podfile.
const COCOA_MQTT_POD = [
  "  pod 'MqttCocoaAsyncSocket', :modular_headers => true",
  "  pod 'CocoaMQTT', '~> 2.2.3'",
].join("\n");
const NETTY_RESOURCE_EXCLUDES = [
  "META-INF/INDEX.LIST",
  "META-INF/io.netty.versions.properties",
];

const moduleSource = (pkg) => `package ${pkg}

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.hivemq.client.mqtt.MqttClient
import com.hivemq.client.mqtt.datatypes.MqttQos
import com.hivemq.client.mqtt.mqtt3.Mqtt3AsyncClient
import java.util.UUID

class TeamCluMqttModule(
  private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
  private var client: Mqtt3AsyncClient? = null

  override fun getName(): String = "TeamCluMqtt"

  @ReactMethod
  fun connect(options: ReadableMap, promise: Promise) {
    val host = options.getString("host")
    if (host.isNullOrBlank()) {
      promise.reject("TEAMCLU_MQTT_INVALID_HOST", "MQTT host is required")
      return
    }

    val port = if (options.hasKey("port")) options.getDouble("port").toInt() else 8883
    val useTls = if (options.hasKey("useTls")) options.getBoolean("useTls") else true
    val clientId = options.getString("clientId")
      ?: "teamclu-expo-\${UUID.randomUUID().toString().substring(0, 8)}"
    val username = options.getString("username")
    val password = options.getString("password")
    val keepalive = if (options.hasKey("keepalive")) options.getDouble("keepalive").toInt() else 90

    emitConnectionState("connecting")
    var built: Mqtt3AsyncClient? = null
    val nextClient = MqttClient.builder()
      .useMqttVersion3()
      .identifier(clientId)
      .serverHost(host)
      .serverPort(port)
      .also { builder ->
        if (useTls) builder.sslWithDefaultConfig()
      }
      // A drop after the connect succeeded (network change, broker kick) has
      // no other path to JS: without this the app kept showing a live
      // connection that was gone. A failed connect and disconnect() report
      // through their own paths, and a replaced client is not \`client\`.
      .addDisconnectedListener { _ ->
        val self = built
        if (self != null && client === self) {
          client = null
          emitConnectionState("disconnected")
        }
      }
      .buildAsync()
    built = nextClient

    val connectBuilder = nextClient.connectWith().keepAlive(keepalive)
    if (!username.isNullOrBlank() && password != null) {
      connectBuilder
        .simpleAuth()
        .username(username)
        .password(password.toByteArray(Charsets.UTF_8))
        .applySimpleAuth()
    }

    connectBuilder.send().whenComplete { _, error ->
      if (error != null) {
        if (client === nextClient) client = null
        emitConnectionState("disconnected")
        promise.reject("TEAMCLU_MQTT_CONNECT_FAILED", error)
        return@whenComplete
      }
      client = nextClient
      emitConnectionState("connected")
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun subscribe(topic: String, promise: Promise) {
    val current = client
    if (current == null) {
      promise.reject("TEAMCLU_MQTT_NOT_CONNECTED", "MQTT client is not connected")
      return
    }

    current.subscribeWith()
      .topicFilter(topic)
      .qos(MqttQos.AT_LEAST_ONCE)
      .callback { message ->
        emitMessage(message.topic.toString(), message.payloadAsBytes ?: ByteArray(0))
      }
      .send()
      .whenComplete { _, error ->
        if (error != null) {
          promise.reject("TEAMCLU_MQTT_SUBSCRIBE_FAILED", error)
          return@whenComplete
        }
        promise.resolve(null)
      }
  }

  @ReactMethod
  fun publish(topic: String, payload: ReadableArray, retain: Boolean, promise: Promise) {
    val current = client
    if (current == null) {
      promise.reject("TEAMCLU_MQTT_NOT_CONNECTED", "MQTT client is not connected")
      return
    }

    current.publishWith()
      .topic(topic)
      .qos(MqttQos.AT_LEAST_ONCE)
      .retain(retain)
      .payload(readByteArray(payload))
      .send()
      .whenComplete { _, error ->
        if (error != null) {
          promise.reject("TEAMCLU_MQTT_PUBLISH_FAILED", error)
          return@whenComplete
        }
        promise.resolve(null)
      }
  }

  @ReactMethod
  fun disconnect(promise: Promise) {
    val current = client
    if (current == null) {
      emitConnectionState("disconnected")
      promise.resolve(null)
      return
    }
    client = null
    current.disconnect().whenComplete { _, error ->
      emitConnectionState("disconnected")
      if (error != null) {
        promise.reject("TEAMCLU_MQTT_DISCONNECT_FAILED", error)
        return@whenComplete
      }
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun addListener(eventName: String) {
  }

  @ReactMethod
  fun removeListeners(count: Int) {
  }

  private fun emitConnectionState(state: String) {
    val payload = Arguments.createMap().apply {
      putString("state", state)
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("TeamCluMqttConnectionState", payload)
  }

  private fun emitMessage(topic: String, payload: ByteArray) {
    val bytes = Arguments.createArray()
    for (byte in payload) {
      bytes.pushInt(byte.toInt() and 0xff)
    }
    val event = Arguments.createMap().apply {
      putString("topic", topic)
      putArray("payload", bytes)
    }
    reactContext
      .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
      .emit("TeamCluMqttMessage", event)
  }

  private fun readByteArray(payload: ReadableArray): ByteArray {
    return ByteArray(payload.size()) { index ->
      payload.getDouble(index).toInt().toByte()
    }
  }
}
`;

const packageSource = (pkg) => `package ${pkg}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class TeamCluMqttPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
    return listOf(TeamCluMqttModule(reactContext))
  }

  override fun createViewManagers(
    reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> {
    return emptyList()
  }
}
`;

const swiftSource = `import CocoaMQTT
import Foundation
import React

@objc(TeamCluMqtt)
class TeamCluMqtt: RCTEventEmitter, CocoaMQTTDelegate {
  private var mqtt: CocoaMQTT?
  private var connectResolve: RCTPromiseResolveBlock?
  private var connectReject: RCTPromiseRejectBlock?

  override static func requiresMainQueueSetup() -> Bool {
    return false
  }

  override func supportedEvents() -> [String]! {
    return ["TeamCluMqttMessage", "TeamCluMqttConnectionState"]
  }

  @objc(connect:resolver:rejecter:)
  func connect(_ options: NSDictionary, resolver resolve: @escaping RCTPromiseResolveBlock, rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard let host = options["host"] as? String, !host.isEmpty else {
      reject("TEAMCLU_MQTT_INVALID_HOST", "MQTT host is required", nil)
      return
    }

    let port = options["port"] as? Int ?? 8883
    let useTLS = options["useTls"] as? Bool ?? true
    let clientId = options["clientId"] as? String ?? "teamclu-expo-\\(UUID().uuidString.prefix(8))"
    let username = options["username"] as? String
    let password = options["password"] as? String
    let keepalive = UInt16(options["keepalive"] as? Int ?? 90)

    sendConnectionState("connecting")
    let client = CocoaMQTT(clientID: clientId, host: host, port: UInt16(port))
    client.username = username
    client.password = password
    client.keepAlive = keepalive
    client.enableSSL = useTLS
    client.allowUntrustCACertificate = true
    client.delegate = self
    mqtt = client
    connectResolve = resolve
    connectReject = reject
    client.connect()
  }

  @objc(subscribe:resolver:rejecter:)
  func subscribe(_ topic: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let client = mqtt else {
      reject("TEAMCLU_MQTT_NOT_CONNECTED", "MQTT client is not connected", nil)
      return
    }
    client.subscribe(topic, qos: .qos1)
    resolve(nil)
  }

  @objc(publish:payload:retain:resolver:rejecter:)
  func publish(_ topic: String, payload: [NSNumber], retain: Bool, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    guard let client = mqtt else {
      reject("TEAMCLU_MQTT_NOT_CONNECTED", "MQTT client is not connected", nil)
      return
    }
    let bytes = payload.map { UInt8(truncating: $0) }
    let message = CocoaMQTTMessage(topic: topic, payload: bytes, qos: .qos1, retained: retain)
    client.publish(message)
    resolve(nil)
  }

  @objc(disconnect:rejecter:)
  func disconnect(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    mqtt?.disconnect()
    mqtt = nil
    sendConnectionState("disconnected")
    resolve(nil)
  }

  private func sendConnectionState(_ state: String) {
    sendEvent(withName: "TeamCluMqttConnectionState", body: ["state": state])
  }

  private func sendMessage(topic: String, payload: [UInt8]) {
    sendEvent(withName: "TeamCluMqttMessage", body: [
      "topic": topic,
      "payload": payload.map { Int($0) },
    ])
  }

  func mqtt(_ mqtt: CocoaMQTT, didConnectAck ack: CocoaMQTTConnAck) {
    if ack == .accept {
      sendConnectionState("connected")
      connectResolve?(nil)
    } else {
      sendConnectionState("disconnected")
      connectReject?("TEAMCLU_MQTT_CONNECT_FAILED", "MQTT connect failed", nil)
    }
    connectResolve = nil
    connectReject = nil
  }

  func mqtt(_ mqtt: CocoaMQTT, didPublishMessage message: CocoaMQTTMessage, id: UInt16) {}
  func mqtt(_ mqtt: CocoaMQTT, didPublishAck id: UInt16) {}

  func mqtt(_ mqtt: CocoaMQTT, didReceiveMessage message: CocoaMQTTMessage, id: UInt16) {
    sendMessage(topic: message.topic, payload: message.payload)
  }

  func mqtt(_ mqtt: CocoaMQTT, didSubscribeTopics success: NSDictionary, failed: [String]) {}
  func mqtt(_ mqtt: CocoaMQTT, didUnsubscribeTopics topics: [String]) {}
  func mqttDidPing(_ mqtt: CocoaMQTT) {}
  func mqttDidReceivePong(_ mqtt: CocoaMQTT) {}

  func mqttDidDisconnect(_ mqtt: CocoaMQTT, withError err: (any Error)?) {
    sendConnectionState("disconnected")
    if let reject = connectReject {
      reject("TEAMCLU_MQTT_CONNECT_FAILED", err?.localizedDescription ?? "MQTT disconnected", err)
      connectResolve = nil
      connectReject = nil
    }
  }

  func mqtt(_ mqtt: CocoaMQTT, didStateChangeTo state: CocoaMQTTConnState) {}

  func mqtt(_ mqtt: CocoaMQTT, didReceive trust: SecTrust, completionHandler: @escaping (Bool) -> Void) {
    completionHandler(true)
  }
}
`;

const objcBridgeSource = `#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(TeamCluMqtt, RCTEventEmitter)

RCT_EXTERN_METHOD(connect:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(subscribe:(NSString *)topic
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(publish:(NSString *)topic
                  payload:(NSArray *)payload
                  retain:(BOOL)retain
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(disconnect:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
`;

function addMqttDependency(contents) {
  if (contents.includes("com.hivemq:hivemq-mqtt-client")) return contents;
  return contents.replace(
    '    implementation("com.facebook.react:react-android")',
    `    implementation("com.facebook.react:react-android")\n${MQTT_DEPENDENCY}`,
  );
}

function addMqttPackagingExcludes(contents) {
  const missingExcludes = NETTY_RESOURCE_EXCLUDES.filter((resource) => !contents.includes(resource));
  if (missingExcludes.length === 0) return contents;
  const additions = missingExcludes
    .map((resource) => `            excludes += '${resource}'`)
    .join("\n");
  return contents.replace(
    /(\s+packagingOptions\s+\{\n)/,
    `$1${additions}\n`,
  );
}

/**
 * Registers the package in MainApplication. Two templates are in the wild:
 * the older `packages.add(...)` form and SDK 57's `PackageList(this).packages
 * .apply { add(...) }`. Only the first used to be matched, and `replace` on a
 * missing anchor is a silent no-op — so on SDK 57 the package was never
 * registered, the module never existed, and Android MQTT never connected.
 * An unrecognised template now fails the prebuild instead.
 */
function addPackageRegistration(contents) {
  if (contents.includes("TeamCluMqttPackage()")) return contents;
  const legacy = "            // packages.add(MyReactNativePackage())";
  if (contents.includes(legacy)) {
    return contents.replace(legacy, `${legacy}\n${PACKAGE_REGISTRATION}`);
  }
  const applyBlock = /^([ \t]*)\/\/ add\(MyReactNativePackage\(\)\)$/m;
  const match = contents.match(applyBlock);
  if (match) {
    return contents.replace(applyBlock, `${match[0]}\n${match[1]}add(TeamCluMqttPackage())`);
  }
  throw new Error(
    "withTeamCluMqtt: couldn't find where to register TeamCluMqttPackage in MainApplication; " +
      "the template changed — update addPackageRegistration.",
  );
}

function addCocoaMqttPod(contents) {
  if (contents.includes("pod 'CocoaMQTT'")) return contents;
  return contents.replace(/(target ['"][^'"]+['"] do\n)/, `$1${COCOA_MQTT_POD}\n`);
}

/**
 * Emits the Kotlin module into the app's own package.
 *
 * The package was hardcoded here until the applicationId changed and the two
 * silently diverged — the generated sources would land in a package Android
 * never looks in, and `TeamCluMqttPackage()` fails to resolve deep into a
 * cloud build. Deriving it from `android.package` keeps the two in step.
 */
function writeMqttModuleFiles(projectRoot, androidPackage) {
  if (!androidPackage) {
    throw new Error(
      "withTeamCluMqtt: android.package is required to emit the MQTT module.",
    );
  }
  const targetDir = path.join(
    projectRoot,
    "android/app/src/main/java",
    ...androidPackage.split("."),
  );
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "TeamCluMqttModule.kt"), moduleSource(androidPackage));
  fs.writeFileSync(path.join(targetDir, "TeamCluMqttPackage.kt"), packageSource(androidPackage));
}

function writeIosMqttModuleFiles(projectRoot, projectName) {
  const targetDir = path.join(projectRoot, "ios", projectName);
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "TeamCluMqtt.swift"), swiftSource);
  fs.writeFileSync(path.join(targetDir, "TeamCluMqttBridge.m"), objcBridgeSource);
}

/** Adds the generated module files to the app target (idempotent). */
function addIosSourceFiles(project, projectName) {
  for (const file of IOS_SOURCE_FILES) {
    const filepath = `${projectName}/${file}`;
    if (project.hasFile(filepath)) continue;
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath,
      groupName: projectName,
      project,
    });
  }
  return project;
}

function withTeamCluMqtt(config) {
  config = withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = addMqttPackagingExcludes(
      addMqttDependency(mod.modResults.contents),
    );
    return mod;
  });

  config = withMainApplication(config, (mod) => {
    mod.modResults.contents = addPackageRegistration(mod.modResults.contents);
    return mod;
  });

  config = withDangerousMod(config, [
    "android",
    async (mod) => {
      writeMqttModuleFiles(mod.modRequest.projectRoot, mod.android?.package);
      return mod;
    },
  ]);

  config = withPodfile(config, (mod) => {
    mod.modResults.contents = addCocoaMqttPod(mod.modResults.contents);
    return mod;
  });

  config = withDangerousMod(config, [
    "ios",
    async (mod) => {
      writeIosMqttModuleFiles(mod.modRequest.projectRoot, mod.modRequest.projectName);
      return mod;
    },
  ]);

  // Writing the files is not enough: they have to be in the app target's
  // sources, or they are never compiled. Without this every iOS build shipped
  // without the native client, the JS fell back to mqtt.js — which cannot open
  // a raw `mqtt://` TCP socket in React Native — and MQTT never connected.
  config = withXcodeProject(config, (mod) => {
    addIosSourceFiles(mod.modResults, mod.modRequest.projectName);
    return mod;
  });

  return config;
}

module.exports = withTeamCluMqtt;
module.exports.addMqttDependency = addMqttDependency;
module.exports.addMqttPackagingExcludes = addMqttPackagingExcludes;
module.exports.addPackageRegistration = addPackageRegistration;
module.exports.addCocoaMqttPod = addCocoaMqttPod;
module.exports.writeMqttModuleFiles = writeMqttModuleFiles;
module.exports.writeIosMqttModuleFiles = writeIosMqttModuleFiles;
module.exports.addIosSourceFiles = addIosSourceFiles;
