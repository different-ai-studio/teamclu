// MQTT topic path helpers.
//
// Wire-literal mirror of `crates/teamclu-types/src/mqtt.rs`. FC does not depend
// on the Rust crate, so each side asserts its own literal. Resource is last so
// ACL `amux/%s/sync/+` covers future resources without migration.

/**
 * Sync hint topic: `amux/<teamId>/sync/<resource>`.
 */
export function syncTopic(teamId: string, resource: string): string {
  return `amux/${teamId}/sync/${resource}`;
}
