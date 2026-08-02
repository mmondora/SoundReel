#!/bin/bash
# Nightly one-way sync of the SoundReel media library to the FRITZ!Box USB
# stick, where the box's own DLNA server picks it up for the TV.
#
# Runs entirely as an unprivileged user. Mounting a CIFS share is the one
# privileged step, and it is delegated to a one-off /etc/fstab entry carrying
# the `user` option (see fritz-sync.fstab.example): `mount <mountpoint>` with
# no options is then permitted for the user who owns that entry, and
# mount.cifs — which is setuid root — does the rest. Nothing here needs sudo.
#
# The credentials never pass through this script: fstab points mount.cifs at
# a 0600 credentials file directly, so the password lives in exactly one
# place and is read by the mount helper, not by us.
#
# The stick is the car's Tesla media drive and already holds its own Music/
# and Movies/ trees, so everything written here lives under a dedicated
# SoundReel/ subdirectory and --delete is scoped to those. Syncing onto the
# parent directories would wipe that library.
set -euo pipefail

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
ENV_FILE="${FRITZ_SYNC_ENV:-$CONFIG_HOME/soundreel/fritz-sync.env}"
LOG_FILE="${FRITZ_SYNC_LOG:-$DATA_HOME/soundreel/fritz-sync.log}"

# Set once the mount succeeds, so the cleanup trap unmounts only what this
# run actually mounted — a share left mounted by hand stays mounted.
MOUNTED_BY_US=0

log() {
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "$(date -Is) $*" | tee -a "$LOG_FILE"
}

cleanup() {
  local status=$?
  if [ "$MOUNTED_BY_US" -eq 1 ] && mountpoint -q "$MOUNTPOINT"; then
    if ! umount "$MOUNTPOINT"; then
      log "WARN umount failed, retrying with lazy unmount (umount -l)"
      if ! umount -l "$MOUNTPOINT"; then
        log "ERROR could not unmount $MOUNTPOINT even with -l; failing the run so it is never mistaken for success"
        status=1
      fi
    fi
  fi
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

: "${MOUNTPOINT:?}" "${FRITZ_VOLUME:?}" "${MUSIC_SRC:?}" "${FILMS_SRC:?}"

# The mountpoint must be the one named in the fstab entry, or `mount` with a
# bare path has nothing to resolve.
if [ ! -d "$MOUNTPOINT" ]; then
  log "ERROR mountpoint does not exist: $MOUNTPOINT (create it, and add the fstab line from scripts/fritz-sync.fstab.example)"
  exit 1
fi

if mountpoint -q "$MOUNTPOINT"; then
  log "already mounted, reusing: $MOUNTPOINT"
else
  log "mounting $MOUNTPOINT (options come from /etc/fstab)"
  if ! mount "$MOUNTPOINT"; then
    log "ERROR mount failed — check the fstab entry has the 'user' option and that the credentials file is readable"
    exit 1
  fi
  MOUNTED_BY_US=1
fi

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
# --no-links: nor can it represent symlinks — rsync aborts the entire run
# with "Operation not supported (95)" on the first one it meets. Skipping
# them is right for a media replica: a DLNA server plays files, not links.
rsync -a --delete --partial --no-perms --no-owner --no-group --no-links \
  "$MUSIC_SRC/" "$MUSIC_DEST/"

if [ -d "$FILMS_SRC" ] && has_content "$FILMS_SRC"; then
  log "syncing films"
  rsync -a --delete --partial --no-perms --no-owner --no-group --no-links \
    "$FILMS_SRC/" "$FILMS_DEST/"
else
  log "films source missing or empty, skipped: $FILMS_SRC"
fi

log "exporting watchlist"
WATCHLIST_TMP="$(mktemp -t watchlist.XXXXXX.html)"
# Surfaced in the final OK line below: a permanently failing export must not
# be able to hide behind a run that otherwise reports success every night.
WATCHLIST_STATUS="ok"
if docker exec soundreel npm run --silent export:watchlist -- /tmp/watchlist.html \
   && docker cp soundreel:/tmp/watchlist.html "$WATCHLIST_TMP"; then
  cp "$WATCHLIST_TMP" "$VOLUME_DIR/watchlist.html"
else
  WATCHLIST_STATUS="stale"
  log "WARN watchlist export failed, keeping the previous copy"
fi
rm -f "$WATCHLIST_TMP"

MUSIC_COUNT=$(find "$MUSIC_DEST" -type f | wc -l)
FILMS_COUNT=$(find "$FILMS_DEST" -type f | wc -l)
log "OK music=$MUSIC_COUNT films=$FILMS_COUNT watchlist=$WATCHLIST_STATUS"
