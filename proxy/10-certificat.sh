#!/bin/sh
# Génère un certificat auto-signé au premier démarrage (à remplacer par un certificat de l'OFPPT en production).
set -e
if [ ! -f /etc/nginx/certs/cert.pem ]; then
  openssl req -x509 -nodes -newkey rsa:3072 -days 825 \
    -keyout /etc/nginx/certs/key.pem -out /etc/nginx/certs/cert.pem \
    -subj "/C=MA/O=OFPPT - Prototype SECURE-eNOTE/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
  chmod 600 /etc/nginx/certs/key.pem
fi
