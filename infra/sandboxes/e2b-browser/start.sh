#!/bin/sh
# The only process that starts or restarts X, x11vnc, and noVNC.
exec 9>/tmp/autoseo-start.lock
flock -n 9 || exit 0

display_up() {
  xdpyinfo -display :0 >/dev/null 2>&1
}

vnc_up() {
  pgrep -x x11vnc >/dev/null 2>&1
}

novnc_up() {
  if command -v nc >/dev/null 2>&1; then
    nc -z localhost 6080 >/dev/null 2>&1
    return $?
  fi
  python3 -c 'import socket; socket.create_connection(("127.0.0.1", 6080), 2).close()' >/dev/null 2>&1
}

while true; do
  if ! display_up; then
    Xvfb :0 -ac -screen 0 1280x800x24 -nolisten tcp >/tmp/autoseo-xvfb.log 2>&1 &
  fi
  if display_up; then
    xsetroot -solid '#0c0c0e' >/dev/null 2>&1 || true
  fi
  if display_up && ! vnc_up; then
    x11vnc -display :0 -forever -shared -viewonly -nopw -rfbport 5900 -noxdamage >/tmp/autoseo-x11vnc.log 2>&1 &
  fi
  if ! novnc_up; then
    /opt/noVNC/utils/novnc_proxy --vnc localhost:5900 --listen 6080 >/tmp/autoseo-novnc.log 2>&1 &
  fi
  if display_up && vnc_up && novnc_up; then
    touch /tmp/autoseo-display-ready
  fi
  sleep 2
done
