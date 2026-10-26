# Red Hat UBI Node.js image: runs as a non-root user and works with
# OpenShift's random-UID restricted SCC out of the box.
FROM registry.access.redhat.com/ubi9/nodejs-20-minimal AS build
WORKDIR /opt/app-root/src
COPY --chown=1001:0 package.json package-lock.json ./
# npm can crash with "Exit handler never called" yet exit 0, so verify the
# runtime deps actually resolve before moving on.
RUN npm ci --omit=dev && npm cache clean --force \
 && node -e "require('express'); require('socket.io'); require('uuid')"

FROM registry.access.redhat.com/ubi9/nodejs-20-minimal
WORKDIR /opt/app-root/src
COPY --from=build --chown=1001:0 /opt/app-root/src/node_modules ./node_modules
COPY --chown=1001:0 package.json server.js ./
COPY --chown=1001:0 public ./public
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER 1001
CMD ["node", "server.js"]
