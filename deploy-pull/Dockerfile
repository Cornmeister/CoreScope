# Pull-only Dockerfile for Coolify: deploy the prebuilt GHCR image
# (built off-host by .github/workflows/docker-publish.yml) instead of
# compiling Go + frontend on the prod host. Point the Coolify app's
# base_directory at /deploy-pull so its "build" is just this image pull.
FROM ghcr.io/cornmeister/corescope:sha-86ef006
