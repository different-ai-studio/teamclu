// services/fc/src/lib/mqtt-client.ts
//
// Singleton MQTT publisher for FC. The connection is established lazily on the
// first publish and reused across invocations within the same warm FC instance.
// mqtt.js handles reconnect transparently; QoS-1 publishes queue until the link
// is back up.
import mqtt from 'mqtt';

export function createMqttPublisher({ url, username, password, clientId }: { url: any; username?: any; password?: any; clientId?: any }) {
  let client = null;
  let firstConnect = null;

  function init() {
    if (client) return firstConnect;
    client = mqtt.connect(url, {
      username,
      password,
      clientId: clientId || `fc-publisher-${process.pid}-${Date.now()}`,
      reconnectPeriod: 5000,
      connectTimeout: 8000,
      keepalive: 60,
      clean: true,
    });
    firstConnect = new Promise((resolve, reject) => {
      const onConnect = () => { cleanup(); resolve(client); };
      const onError = (err) => { cleanup(); reject(err); };
      const cleanup = () => {
        client.off('connect', onConnect);
        client.off('error', onError);
      };
      client.once('connect', onConnect);
      client.once('error', onError);
    });
    client.on('error', (err) => console.error('[mqtt] error', err.message));
    return firstConnect;
  }

  return {
    async publish(topic, payload, options = {}) {
      await init();
      return new Promise<void>((resolve, reject) => {
        client.publish(topic, payload, { qos: 1, ...options }, (err) => {
          if (err) reject(err); else resolve();
        });
      });
    },
    async close() {
      if (!client) return;
      const c = client;
      client = null;
      firstConnect = null;
      await new Promise((resolve) => c.end(false, {}, resolve));
    },
  };
}
