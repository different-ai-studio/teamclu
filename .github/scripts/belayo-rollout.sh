#!/usr/bin/env bash
set -Eeuo pipefail
service="$1" image="$2" worker="$3" app_id="$4"
old=$(docker service inspect "$service" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}')
rollback() { docker service update --with-registry-auth --update-order start-first --image "$old" --detach=true "$service" >/dev/null || true; }
trap rollback ERR
docker service update --with-registry-auth --update-order start-first --update-failure-action rollback --update-monitor 30s --image "$image" --detach=false "$service"
live=$(docker service ps "$service" --filter desired-state=running --format '{{.Node}} {{.Image}}' | head -1)
[[ "$live" == "$worker $image"* ]]
pg=$(docker ps --format '{{.Names}}' | grep dokploy-postgres | head -1)
docker exec -i "$pg" psql -U dokploy -d dokploy -v ON_ERROR_STOP=1 -c "update application set \"dockerImage\" = '$image' where \"applicationId\" = '$app_id';" >/dev/null
echo "running=$live"
