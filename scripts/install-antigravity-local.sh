#!/usr/bin/env bash
set -euo pipefail

# Independent localhost SSH identity selects this backend without changing the
# existing Chrys or native Codex route. All files are owned by the current user.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
INSTALL_DIR="$HOME/.local/share/antigravity-codex-adapter"
ROUTE_DIR="$HOME/.local/antigravity-codex"
STATE_DIR="$HOME/.antigravity-codex"
IDENTITY="$HOME/.ssh/antigravity_codex"
NODE_BIN="$(command -v node)"
AGY_BIN="${ANTIGRAVITY_CODEX_EXECUTABLE:-$HOME/.local/bin/agy}"
REAL_CODEX="${CODEX_REAL:-/usr/local/bin/codex}"

"$NODE_BIN" -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)'
"$AGY_BIN" acp --help >/dev/null 2>&1
test -f "$ROOT/dist/src/adapter.mjs"
mkdir -p "$INSTALL_DIR" "$ROUTE_DIR/bin" "$STATE_DIR" "$HOME/.ssh"
chmod 700 "$STATE_DIR" "$HOME/.ssh"
# Keep a rollback copy on upgrades; never delete the running release in place.
if [ -d "$INSTALL_DIR/dist" ]; then
  mv "$INSTALL_DIR/dist" "$INSTALL_DIR/dist.backup.$(date +%Y%m%d%H%M%S)"
fi
cp -R "$ROOT/dist" "$INSTALL_DIR/dist"
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/LICENSE" "$ROOT/NOTICE" "$INSTALL_DIR/"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --prefix "$INSTALL_DIR"
install -m 0755 "$ROOT/scripts/codex-shim" "$ROUTE_DIR/bin/codex"

# %q avoids interpreting spaces or shell metacharacters in local paths.
{
  echo 'unset CHRYS_CODEX_ADAPTER CHRYS_CODEX_EXECUTABLE CHRYS_CODEX_HOME CHRYS_CODEX_COMPAT_VERSION CHRYS_CODEX_RUNTIME_TYPE CHRYS_CODEX_NODE'
  printf 'export PATH=%q:"$PATH"\n' "$ROUTE_DIR/bin:$HOME/.local/bin:/usr/local/bin"
  printf 'export CODEX_HOME=%q\n' "$STATE_DIR"
  printf 'export CLAUDE_CODEX_HOME=%q\n' "$STATE_DIR/adapter"
  printf 'export CLAUDE_CODEX_ADAPTER=%q\n' "$INSTALL_DIR/dist/src/adapter.mjs"
  printf 'export CLAUDE_CODEX_NODE=%q\n' "$NODE_BIN"
  printf 'export ANTIGRAVITY_CODEX_EXECUTABLE=%q\n' "$AGY_BIN"
  printf 'export CODEX_REAL=%q\n' "$REAL_CODEX"
  printf 'export CLAUDE_CODEX_RUNTIME_ENV=%q\n' "$ROUTE_DIR/runtime.env"
  echo 'export CLAUDE_CODEX_RUNTIME_TYPE=antigravity-acp'
  echo 'export CLAUDE_CODEX_ROUTE=antigravity-acp'
  echo 'export CLAUDE_CODEX_VERSION_SUFFIX=antigravity-codex'
  echo 'export CLAUDE_CODEX_DISABLE_CODEX_PROXY=1'
  echo 'export CLAUDE_CODEX_IDLE_EXIT_MS=0'
} > "$ROUTE_DIR/runtime.env"
chmod 600 "$ROUTE_DIR/runtime.env"

cat > "$ROUTE_DIR/ssh-entry" <<'ENTRY'
#!/usr/bin/env bash
set -euo pipefail
export ANTIGRAVITY_CODEX_SSH=1
source "$HOME/.local/antigravity-codex/runtime.env"
if [ -z "${SSH_ORIGINAL_COMMAND:-}" ]; then
  echo 'Antigravity Codex SSH endpoint expects a command.' >&2
  exit 1
fi
exec /bin/zsh -c "$SSH_ORIGINAL_COMMAND"
ENTRY
chmod 700 "$ROUTE_DIR/ssh-entry"

if [ ! -f "$IDENTITY" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$IDENTITY" -C antigravity-codex-local
fi
# Only loopback can use this key, and every command selects the isolated route.
python3 - "$IDENTITY" "$ROUTE_DIR" <<'PY'
import os, pathlib, sys, shutil, datetime
home = pathlib.Path.home()
identity, route = map(pathlib.Path, sys.argv[1:])
stamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
def backup(path):
    if path.exists(): shutil.copy2(path, str(path) + '.antigravity-backup.' + stamp)
authorized = home / '.ssh/authorized_keys'
old = authorized.read_text() if authorized.exists() else ''
pub = pathlib.Path(str(identity) + '.pub').read_text().strip()
if pub.split()[1] not in old:
    backup(authorized)
    with authorized.open('a') as f:
        f.write('\nfrom="127.0.0.1,::1",command="' + str(route / 'ssh-entry') + '" ' + pub + '\n')
    authorized.chmod(0o600)
config = home / '.ssh/config'
old = config.read_text() if config.exists() else ''
if 'Host antigravity-local\n' not in old:
    backup(config)
    with config.open('a') as f:
        f.write('\n# >>> antigravity codex local >>>\nHost antigravity-local\n  HostName 127.0.0.1\n  User ' + os.environ['USER'] + '\n  Port 22\n  IdentityFile ' + str(identity) + '\n  IdentitiesOnly yes\n  PreferredAuthentications publickey\n# <<< antigravity codex local <<<\n')
    config.chmod(0o600)
zshenv = home / '.zshenv'
old = zshenv.read_text() if zshenv.exists() else ''
if '# >>> antigravity codex ssh route >>>' not in old:
    backup(zshenv)
    with zshenv.open('a') as f:
        f.write('\n# >>> antigravity codex ssh route >>>\nif [[ "${ANTIGRAVITY_CODEX_SSH:-}" == "1" ]]; then\n  source "$HOME/.local/antigravity-codex/runtime.env"\nfi\n# <<< antigravity codex ssh route <<<\n')
PY

# macOS keychain credentials are available to the GUI login session, not
# necessarily an SSH login. Run the agent there; SSH only carries the socket.
if [ "$(uname -s)" = Darwin ]; then
  cat > "$ROUTE_DIR/daemon" <<'DAEMON'
#!/usr/bin/env bash
set -euo pipefail
source "$HOME/.local/antigravity-codex/runtime.env"
unset CHRYS_CODEX_DAEMONIZE CHRYS_CODEX_DAEMON_CHILD
exec "$CLAUDE_CODEX_NODE" "$CLAUDE_CODEX_ADAPTER" app-server --listen unix://
DAEMON
  chmod 700 "$ROUTE_DIR/daemon"
  python3 - "$ROUTE_DIR" "$STATE_DIR" <<'PY'
import pathlib, plistlib, sys
route, state = map(pathlib.Path, sys.argv[1:])
agents = pathlib.Path.home() / 'Library/LaunchAgents'
agents.mkdir(parents=True, exist_ok=True)
with (agents / 'ai.antigravity.codex-adapter.plist').open('wb') as f:
    plistlib.dump({'Label': 'ai.antigravity.codex-adapter',
      'ProgramArguments': [str(route / 'daemon')],
      'WorkingDirectory': str(pathlib.Path.home()),
      'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 10,
      'StandardOutPath': str(state / 'launch-agent.log'),
      'StandardErrorPath': str(state / 'launch-agent.log')}, f)
PY
  printf 'GUI daemon prepared. Start with: launchctl bootstrap gui/%s %s\n' "$(id -u)" "$HOME/Library/LaunchAgents/ai.antigravity.codex-adapter.plist"
fi

printf 'Installed Antigravity adapter. Verify: ssh -o BatchMode=yes antigravity-local "codex --version"\n'
