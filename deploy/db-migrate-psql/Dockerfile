FROM public.ecr.aws/docker/library/postgres:17-alpine@sha256:f9cf3e1f0066f0eb0c48707d864f0ac5941e9ff454a072077d97a4d278d07d73

WORKDIR /opt/teamclu/db-migrate
COPY --chmod=0444 image-entrypoint.sh runner.sh ./
COPY migrations/ ./migrations/

USER 70:70
ENTRYPOINT ["/bin/sh", "/opt/teamclu/db-migrate/image-entrypoint.sh"]
CMD ["preflight"]
