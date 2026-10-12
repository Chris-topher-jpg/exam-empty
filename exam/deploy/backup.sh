#!/usr/bin/env bash
set -euo pipefail
umask 077
backup_dir=/var/backups/bibiniao-exam
install -d -m 700 "$backup_dir"
archive="$backup_dir/state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
# Business files are replaced atomically by the app. tar's code 1 means a file
# changed during reading: leave the previous backups and report the failure.
tar -czf "$archive" -C /var/lib bibiniao-exam
sha256sum "$archive" > "$archive.sha256"
