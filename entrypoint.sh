#!/bin/sh
# A virtual sound card for page audio: Chromium plays into the "pencere" null sink, and
# audio.js records its monitor. Nothing here touches real hardware.
set -e
export XDG_RUNTIME_DIR=/tmp/runtime-pwuser
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit -n \
  --load=module-native-protocol-unix \
  --load="module-null-sink sink_name=pencere sink_properties=device.description=Pencere"
pactl set-default-sink pencere
exec node server.js
