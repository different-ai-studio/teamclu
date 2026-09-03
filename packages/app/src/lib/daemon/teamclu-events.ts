import { fromBinary } from "@bufbuild/protobuf";
import {
  LiveEventEnvelopeSchema,
  SessionMessageEnvelopeSchema,
  type LiveEventEnvelope,
  type SessionMessageEnvelope,
  type Message,
} from "@/lib/proto/teamclu_pb";
import {
  EnvelopeSchema as AmuxEnvelopeSchema,
  type AcpEvent,
  type Envelope as AmuxEnvelope,
} from "@/lib/proto/amux_pb";
import { normalizeUnixTimestampSeconds } from "@/lib/messages/message-timestamp";

export interface DecodedLiveEvent {
  envelope: LiveEventEnvelope;
  sessionMessage?: SessionMessageEnvelope;
  message?: Message;
  // Set when event_type === 'acp.event'
  acpEvent?: AcpEvent;
  amuxEnvelope?: AmuxEnvelope;
}

export function decodeLiveEvent(bytes: Uint8Array): DecodedLiveEvent | null {
  let envelope: LiveEventEnvelope;
  try {
    envelope = fromBinary(LiveEventEnvelopeSchema, bytes);
  } catch {
    return null;
  }

  const decoded: DecodedLiveEvent = { envelope };

  if (envelope.eventType === "message.created" && envelope.body && envelope.body.length > 0) {
    try {
      const sessionMessage = fromBinary(SessionMessageEnvelopeSchema, envelope.body);
      // Normalize at the live-event boundary so every consumer (streaming,
      // cache, preview and render) sees the canonical seconds unit.
      const message = sessionMessage.message
        ? {
            ...sessionMessage.message,
            createdAt: normalizeUnixTimestampSeconds(sessionMessage.message.createdAt),
          }
        : undefined;
      decoded.sessionMessage = { ...sessionMessage, message };
      decoded.message = message;
    } catch {
      // ignore body decode failure; envelope still valid for caller inspection
    }
  } else if (envelope.eventType === "acp.event" && envelope.body && envelope.body.length > 0) {
    try {
      const amuxEnv = fromBinary(AmuxEnvelopeSchema, envelope.body);
      decoded.amuxEnvelope = amuxEnv;
      if (amuxEnv.payload?.case === "acpEvent") {
        decoded.acpEvent = amuxEnv.payload.value;
      }
    } catch {
      // ignore body decode failure; envelope still valid for caller inspection
    }
  }

  return decoded;
}

export function streamActorIdFromLiveEvent(decoded: DecodedLiveEvent): string {
  return decoded.envelope.actorId || decoded.amuxEnvelope?.runtimeId || "";
}

export function sessionIdFromLiveEvent(decoded: DecodedLiveEvent, topic: string): string | null {
  return decoded.envelope.sessionId || sessionIdFromTopic(topic);
}

export function sessionIdFromTopic(topic: string): string | null {
  const m = topic.match(/^amux\/[^/]+\/session\/([^/]+)\/live$/);
  if (!m || m[1] === "+") return null;
  return m[1];
}
