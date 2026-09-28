FROM mongo:5.0

COPY keyfile /data/configdb/keyfile
RUN chmod 400 /data/configdb/keyfile && \
    chown mongodb:mongodb /data/configdb/keyfile

COPY init-mongo.js /docker-entrypoint-initdb.d/