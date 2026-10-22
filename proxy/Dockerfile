# Reverse-proxy TLS (chiffrement des échanges — H4)
FROM nginx:1.27-alpine
RUN apk add --no-cache openssl
COPY nginx.conf /etc/nginx/nginx.conf
COPY 10-certificat.sh /docker-entrypoint.d/10-certificat.sh
RUN chmod +x /docker-entrypoint.d/10-certificat.sh
