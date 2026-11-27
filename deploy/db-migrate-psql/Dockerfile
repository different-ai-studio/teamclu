FROM public.ecr.aws/docker/library/postgres@sha256:36dd0a523ce9ab5d4be69d79c116bbfe3af83ed1f708233d491d2884ca7d8a02

WORKDIR /opt/teamclu/db-migrate
COPY --chmod=0444 image-entrypoint.sh runner.sh ./
COPY migrations/ ./migrations/

USER 70:70
ENTRYPOINT ["/bin/sh", "/opt/teamclu/db-migrate/image-entrypoint.sh"]
CMD ["preflight"]
