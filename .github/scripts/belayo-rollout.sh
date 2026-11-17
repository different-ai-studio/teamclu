#!/usr/bin/env bash
# Roll one Belayo Swarm service to a new image and prove it is serving, on the
# Dokploy manager. Uploaded and run by belayo-cloud-api.yml.
#
# Usage: belayo-rollout.sh <service> <image> <worker> <dokploy app id> <port>
#
# Order matters: Dokploy's desired image is recorded last, so a rollout that
# fails any check leaves both the running service (rolled back by the trap) and
# Dokploy's record on the previous image.
set -Eeuo pipefail
service="$1" image="$2" worker="$3" app_id="$4" port="$5"
old=$(docker service inspect "$service" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')
rollback() {
  echo "rollout failed; restoring $old"
  docker service ps "$service" --no-trunc | head -5 || true
  docker service update --with-registry-auth --update-order start-first --image "$old" --detach=true "$service" >/dev/null || true
}
trap rollback ERR
docker service update --with-registry-auth --update-order start-first --update-failure-action rollback --update-monitor 30s --image "$image" --detach=false "$service"
live=$(docker service ps "$service" --filter desired-state=running --format '{{.Node}} {{.Image}}' | head -1)
[[ "$live" == "$worker $image"* ]]

# The service is reached through Traefik only; a published port would bypass it.
ports=$(docker service inspect "$service" --format '{{json .Spec.EndpointSpec.Ports}}')
[ "$ports" = "null" ] || [ "$ports" = "[]" ]

# Ask the new task itself, over the overlay network, from the Dokploy
# container (the manager host is not on that network).
dokploy=$(docker ps --format '{{.Names}}' | grep '^dokploy\.1\.' | head -1)
healthy=""
for _ in $(seq 1 10); do
  if docker exec "$dokploy" node -e \
    "fetch('http://$service:$port/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    healthy=1
    break
  fi
  sleep 3
done
[ -n "$healthy" ] || { echo "http://$service:$port/healthz did not answer 2xx"; false; }

pg=$(docker ps --format '{{.Names}}' | grep dokploy-postgres | head -1)
docker exec -i "$pg" psql -U dokploy -d dokploy -v ON_ERROR_STOP=1 -c "update application set \"dockerImage\" = '$image' where \"applicationId\" = '$app_id';" >/dev/null
trap - ERR
echo "running=$live"
