# SECURE-eNOTE — image applicative (Node.js 22, aucune dépendance npm)
FROM node:22-alpine

# Client PostgreSQL pour les sauvegardes (pg_dump) et la restauration (psql)
RUN apk add --no-cache postgresql16-client tzdata \
 && mkdir -p /app /backups && chown -R node:node /backups

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node tests ./tests

ENV NODE_ENV=production PORT=3000 BACKUP_DIR=/backups PG_DUMP_PATH=/usr/bin/pg_dump TZ=Africa/Casablanca
# Exécution avec un utilisateur non privilégié
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/sante > /dev/null || exit 1
CMD ["node", "src/server.js"]
