#!/usr/bin/env bash
set -euo pipefail
umask 077
release_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
revision=${1:?Usage: install-release.sh GIT_REVISION [INITIAL_QUESTION_BANK]}
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected full Git revision' >&2; exit 1; }
[[ "$release_dir" == "/opt/jqcn-exam/releases/$revision" ]] || { echo 'Unexpected release directory' >&2; exit 1; }
[[ $(id -u) == 0 ]] || { echo 'Run as root' >&2; exit 1; }
id jqcn-exam >/dev/null 2>&1 || useradd --system --home-dir /var/lib/jqcn-exam --shell /sbin/nologin jqcn-exam
install -d -m 700 -o jqcn-exam -g jqcn-exam /var/lib/jqcn-exam
install -d -m 755 "$release_dir/data"
if [[ ! -f /var/lib/jqcn-exam/question-bank.json ]]; then
    install -m 600 -o jqcn-exam -g jqcn-exam "${2:?Initial question bank required}" /var/lib/jqcn-exam/question-bank.json
fi
env_file=/etc/jqcn-exam.env
if [[ ! -f "$env_file" ]]; then
    admin_password=$(openssl rand -hex 24)
    cat > "$env_file" <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
ADMIN_PASSWORD=$admin_password
DEMO_AUTO_PAY=0
ONBOARDING_EXAM_PUBLIC_URL=https://exam.example.com
ONBOARDING_EXAM_STATE_PATH=/var/lib/jqcn-exam/state.json
ONBOARDING_EXAM_CONFIG_PATH=/var/lib/jqcn-exam/config.json
ONBOARDING_EXAM_ADMIN_USERS_PATH=/var/lib/jqcn-exam/admin-users.json
ONBOARDING_EXAM_QUESTION_BANK_PATH=/var/lib/jqcn-exam/question-bank.json
RELEASE_REVISION=$revision
EOF
    unset admin_password
fi
chmod 600 "$env_file"
if grep -q '^RELEASE_REVISION=' "$env_file"; then
    sed -i "s/^RELEASE_REVISION=.*/RELEASE_REVISION=$revision/" "$env_file"
else
    printf '\nRELEASE_REVISION=%s\n' "$revision" >> "$env_file"
fi
if [[ -L /opt/jqcn-exam/current ]]; then
    bash /opt/jqcn-exam/current/deploy/backup.sh
fi
ln -sfn "$release_dir" /opt/jqcn-exam/current.new
mv -Tf /opt/jqcn-exam/current.new /opt/jqcn-exam/current
install -m 644 "$release_dir/deploy/jqcn-exam.service" /etc/systemd/system/
install -m 644 "$release_dir/deploy/jqcn-exam-backup.service" /etc/systemd/system/
install -m 644 "$release_dir/deploy/jqcn-exam-backup.timer" /etc/systemd/system/
# Do not overwrite a production vhost on subsequent releases.
if [[ ! -f /etc/nginx/conf.d/jqcn-exam.conf ]]; then
    install -m 644 "$release_dir/deploy/nginx-preview.conf" /etc/nginx/conf.d/jqcn-exam.conf
fi
nginx -t
systemctl daemon-reload
systemctl enable jqcn-exam jqcn-exam-backup.timer
systemctl restart jqcn-exam
systemctl start jqcn-exam-backup.timer
systemctl enable --now nginx
systemctl reload nginx
curl --fail --silent --show-error --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8080/api/health
