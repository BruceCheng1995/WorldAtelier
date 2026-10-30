FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 zip unzip libseccomp2 \
    libfontconfig1 libfreetype6 libx11-6 libxcursor1 libxinerama1 libxi6 \
    libxrandr2 libxrender1 libxkbcommon0 libgl1 libegl1 libvulkan1 libasound2 \
    fonts-dejavu-core fontconfig && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV GODOT_BIN=/usr/local/bin/godot \
    WORLD_ATELIER_EXPORT_TEMPLATES=/opt/godot/templates/4.6.stable \
    WORLD_ATELIER_LINUX_SANDBOX=/usr/local/libexec/wa-linux-sandbox

FROM runtime AS toolchain
ARG TARGETARCH
COPY deploy/install-godot.py deploy/install-godot.py
COPY tools/install-release-templates.py tools/install-release-templates.py
RUN python3 deploy/install-godot.py "$TARGETARCH" /usr/local/bin/godot \
    && python3 tools/install-release-templates.py web --directory /opt/godot/templates/4.6.stable \
    && mkdir -p /root/.local/share/godot/export_templates \
    && ln -s /opt/godot/templates/4.6.stable /root/.local/share/godot/export_templates/4.6.stable
FROM toolchain AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libseccomp-dev && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY apps ./apps
COPY services ./services
COPY packages ./packages
COPY tools ./tools
COPY runtimes ./runtimes
COPY skills ./skills
COPY content ./content
COPY AGENTS.md PROJECT.md README.md ./
COPY docs ./docs
RUN node tools/build-linux-sandbox.mjs --out=/usr/local/libexec/wa-linux-sandbox \
    && node tools/build-model-preview.mjs --out=/opt/world-atelier/preview-build \
    && find /app -type d -name .godot -prune -exec rm -rf '{}' +

FROM runtime AS application
COPY --from=build /app /app
COPY --from=build /usr/local/bin/godot /usr/local/bin/godot
COPY --from=build /usr/local/libexec/wa-linux-sandbox /usr/local/libexec/wa-linux-sandbox
COPY --from=build /opt/godot /opt/godot
COPY --from=build /opt/world-atelier /opt/world-atelier
RUN mkdir -p /data /app/.local /home/node/.local/share/godot/export_templates \
    && ln -s /opt/godot/templates/4.6.stable /home/node/.local/share/godot/export_templates/4.6.stable \
    && chown -R node:node /data /app/.local /home/node/.local
USER node
ENV WORLD_ATELIER_PREVIEW_DATA=/data/preview \
    WORLD_ATELIER_CREATION_DATA=/data/creation \
    WORLD_ATELIER_PREVIEW_BUILD=/opt/world-atelier/preview-build \
    WORLD_ATELIER_DEFAULT_PROJECTS=1 \
    WORLD_ATELIER_PUBLIC_PLAY=1 \
    WORLD_ATELIER_DISABLE_AGENT=1 \
    WORLD_ATELIER_DISABLE_WORLDS=1 \
    WORLD_ATELIER_LAN=0 \
    WORLD_ATELIER_LISTEN_HOST=0.0.0.0
EXPOSE 48910
ENTRYPOINT ["node", "tools/container-entry.mjs"]

FROM application AS verification
USER root
RUN npm ci --include=dev --no-audit --no-fund
COPY tests ./tests
USER node
ENTRYPOINT ["node"]
CMD ["--test", "tests/creation/linux-execution.test.mjs"]

# `docker build .` should still produce the application, not the test image.
FROM application AS final
