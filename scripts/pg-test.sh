#!/usr/bin/env bash
# Starts a throwaway real PostgreSQL cluster for integration tests.
# Usage: scripts/pg-test.sh start|stop|restart|crash
# Connection: postgres://xtc:xtc@127.0.0.1:54329/xtc_test
set -euo pipefail
BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)}"
DATA="${PG_DATA:-/tmp/xtc-pg-data}"
PORT="${PG_PORT:-54329}"
if [ "$(id -u)" = 0 ]; then RUN() { su postgres -c "$*"; }; else RUN() { bash -c "$*"; }; fi
opts="-p $PORT -c listen_addresses=127.0.0.1 -c unix_socket_directories=/tmp -c fsync=on"
case "${1:-start}" in
  start)
    if [ ! -d "$DATA" ]; then
      mkdir -p "$DATA"; [ "$(id -u)" = 0 ] && chown postgres "$DATA"
      RUN "$BIN/initdb -D $DATA -U postgres --auth=trust >/dev/null"
    fi
    RUN "$BIN/pg_ctl -D $DATA -o '$opts' -l $DATA/server.log -w start >/dev/null"
    RUN "psql -h 127.0.0.1 -p $PORT -U postgres -tc \"SELECT 1 FROM pg_roles WHERE rolname='xtc'\" | grep -q 1 || psql -h 127.0.0.1 -p $PORT -U postgres -c \"CREATE ROLE xtc LOGIN PASSWORD 'xtc' SUPERUSER\" >/dev/null"
    RUN "psql -h 127.0.0.1 -p $PORT -U postgres -tc \"SELECT 1 FROM pg_database WHERE datname='xtc_test'\" | grep -q 1 || createdb -h 127.0.0.1 -p $PORT -U postgres -O xtc xtc_test" ;;
  stop)    RUN "$BIN/pg_ctl -D $DATA -m fast -w stop >/dev/null" ;;
  restart) RUN "$BIN/pg_ctl -D $DATA -o '$opts' -m fast -w restart >/dev/null" ;;
  crash)   RUN "$BIN/pg_ctl -D $DATA -o '$opts' -m immediate -w restart >/dev/null" ;; # immediate = crash-style, forces WAL recovery
esac
