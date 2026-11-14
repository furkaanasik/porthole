#!/bin/sh
# A virtual screen and sound card. Chromium draws on the Xvfb display, which vstream.js encodes
# as H.264, and plays into the "pencere" null sink, which audio.js records. Nothing here touches
# real hardware.
set -e
# -nolisten local: with --network host, the abstract X socket would clash with other containers.
export DISPLAY=:99
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -nolisten local >/dev/null 2>&1 &
for i in $(seq 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done
# Chromium's kiosk mode needs a window manager to make its windows fullscreen.
openbox >/dev/null 2>&1 &
export TZ=Europe/Istanbul
export XDG_RUNTIME_DIR=/tmp/runtime-pwuser
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit -n \
  --load=module-native-protocol-unix \
  --load="module-null-sink sink_name=pencere sink_properties=device.description=Pencere"
pactl set-default-sink pencere
exec node server.js
