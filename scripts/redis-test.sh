#!/usr/bin/env bash
# Throwaway Redis for integration tests. Usage: scripts/redis-test.sh start|stop|restart
# Connection: redis://127.0.0.1:6390
PORT="${REDIS_PORT:-6390}"
case "${1:-start}" in
  start)   redis-server --port "$PORT" --bind 127.0.0.1 --save "" --appendonly no --daemonize yes --pidfile /tmp/xtc-redis.pid --logfile /tmp/xtc-redis.log >/dev/null
           for _ in $(seq 1 30); do redis-cli -p "$PORT" ping 2>/dev/null | grep -q PONG && exit 0; sleep 0.2; done; echo "redis did not start" >&2; exit 1 ;;
  stop)    redis-cli -p "$PORT" shutdown nosave 2>/dev/null || true ;;
  restart) "$0" stop; sleep 0.5; "$0" start ;;
  *) echo "usage: $0 start|stop|restart" >&2; exit 2 ;;
esac
