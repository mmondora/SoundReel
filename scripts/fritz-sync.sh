#!/bin/bash
# Nightly one-way sync of the SoundReel media library to the FRITZ!Box USB
# stick, where the box's own DLNA server picks it up for the TV.
#
# The stick is the car's Tesla media drive and already holds its own Music/
# and Movies/ trees, so everything written here lives under a dedicated
# SoundReel/ subdirectory and --delete is scoped to those. Syncing onto the
# parent directories would wipe that library.
set -euo pipefail

ENV_FILE="${FRITZ_SYNC_ENV:-/etc/soundreel/fritz-sync.env}"
LOG_FILE="${FRITZ_SYNC_LOG:-/var/log/soundreel/fritz-sync.log}"
MOUNTPOINT="$(mktemp -d /tmp/fritz-sync.XXXXXX)"

log() {
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "$(date -Is) $*" | tee -a "$LOG_FILE"
}

cleanup() {
  local status=$?
  if mountpoint -q "$MOUNTPOINT"; then
    if ! umount "$MOUNTPOINT"; then
      log "WARN umount failed, retrying with lazy unmount (umount -l)"
      if ! umount -l "$MOUNTPOINT"; then
        log "ERROR could not unmount $MOUNTPOINT even with -l; failing the run so it is never mistaken for success"
        status=1
      fi
    fi
  fi
  rmdir "$MOUNTPOINT" 2>/dev/null || true
  [ $status -ne 0 ] && log "FAILED (exit $status)"
  exit $status
}
trap cleanup EXIT

if [ ! -r "$ENV_FILE" ]; then
  log "ERROR env file not readable: $ENV_FILE"
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${FRITZ_HOST:?}" "${FRITZ_SHARE:?}" "${FRITZ_USER:?}" "${FRITZ_PASSWORD:?}"
: "${FRITZ_VOLUME:?}" "${MUSIC_SRC:?}" "${FILMS_SRC:?}"

log "mounting //$FRITZ_HOST/$FRITZ_SHARE"
mount -t cifs "//$FRITZ_HOST/$FRITZ_SHARE" "$MOUNTPOINT" \
  -o "username=$FRITZ_USER,password=$FRITZ_PASSWORD,vers=3.0,iocharset=utf8,uid=$(id -u),gid=$(id -g)"

# A swapped or unplugged stick would leave the mount pointing at something
# unexpected, and --delete would then act on the wrong tree. Refuse to
# proceed unless the expected volume is really there.
VOLUME_DIR="$MOUNTPOINT/$FRITZ_VOLUME"
if [ ! -d "$VOLUME_DIR" ]; then
  log "ERROR expected volume '$FRITZ_VOLUME' not found on the share"
  exit 1
fi

MUSIC_DEST="$VOLUME_DIR/Music/SoundReel"
FILMS_DEST="$VOLUME_DIR/Movies/SoundReel"
mkdir -p "$MUSIC_DEST" "$FILMS_DEST"

# True if the given directory has at least one entry. An rsync --delete
# against a source that exists but is empty (stalled bind mount, container
# hiccup around the Films volume, ...) would look like a legitimately empty
# tree and silently wipe everything previously synced into the matching
# SoundReel/ subtree. Every --delete sync below is gated on this.
has_content() {
  [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]
}

if ! has_content "$MUSIC_SRC"; then
  log "ERROR music source is empty, refusing to delete-sync: $MUSIC_SRC"
  exit 1
fi

log "syncing music"
# --no-perms --no-owner --no-group: a CIFS mount cannot represent POSIX
# ownership, so without these flags rsync would see every file as changed
# and re-copy the whole tree every night.
rsync -a --delete --partial --no-perms --no-owner --no-group \
  "$MUSIC_SRC/" "$MUSIC_DEST/"

if [ -d "$FILMS_SRC" ] && has_content "$FILMS_SRC"; then
  log "syncing films"
  rsync -a --delete --partial --no-perms --no-owner --no-group \
    "$FILMS_SRC/" "$FILMS_DEST/"
else
  log "films source missing or empty, skipped: $FILMS_SRC"
fi

log "exporting watchlist"
WATCHLIST_TMP="$(mktemp /tmp/watchlist.XXXXXX.html)"
if docker exec soundreel npm run --silent export:watchlist -- /tmp/watchlist.html \
   && docker cp soundreel:/tmp/watchlist.html "$WATCHLIST_TMP"; then
  cp "$WATCHLIST_TMP" "$VOLUME_DIR/watchlist.html"
else
  log "WARN watchlist export failed, keeping the previous copy"
fi
rm -f "$WATCHLIST_TMP"

MUSIC_COUNT=$(find "$MUSIC_DEST" -type f | wc -l)
FILMS_COUNT=$(find "$FILMS_DEST" -type f | wc -l)
log "OK music=$MUSIC_COUNT films=$FILMS_COUNT"
