#!/usr/bin/env python3
"""Manage dedicated local identity processes. No system services or containers."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import time
import urllib.request
from configure import environment, configure

ROOT = Path(__file__).resolve().parent
STATE = ROOT / '.runtime'


def run(args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def postgres_bin():
    configured = os.environ.get('IDENTITY_POSTGRES_BIN')
    if configured:
        return Path(configured)
    binaries = sorted(Path('/usr/lib/postgresql').glob('*/bin/pg_ctl'), key=lambda p: int(p.parts[-3]), reverse=True)
    if binaries:
        return binaries[0].parent
    executable = shutil.which('pg_ctl')
    if executable:
        return Path(executable).parent
    raise RuntimeError('PostgreSQL tools not found; set IDENTITY_POSTGRES_BIN to the installed bin directory')


def install():
    if os.uname().machine != 'x86_64':
        raise RuntimeError('Checked runtime lock supports Linux x86_64; supply installed runtimes for another architecture')
    STATE.mkdir(mode=0o700, exist_ok=True)
    for item in json.loads((ROOT / 'runtime-lock.json').read_text()):
        destination = STATE / item['name']
        if (destination / '.installed').exists() and (destination / '.installed').read_text().strip() == item['sha256']:
            continue
        archive = STATE / (item['name'] + '.tar.gz')
        print('Downloading pinned ' + item['name'], flush=True)
        urllib.request.urlretrieve(item['url'], archive)
        digest = hashlib.sha256()
        with archive.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                digest.update(block)
        if digest.hexdigest() != item['sha256']:
            raise RuntimeError('Checksum mismatch for ' + item['name'])
        destination.mkdir(mode=0o700, exist_ok=True)
        with tarfile.open(archive) as tar:
            tar.extractall(destination, filter='data')
        (destination / '.installed').write_text(item['sha256'])
        archive.unlink()
    print('Pinned runtimes installed privately under .runtime; PostgreSQL uses installed native tools.')


def executable(kind, relative):
    found = list((STATE / kind).glob(relative))
    if len(found) != 1:
        raise RuntimeError('Runtime missing; run identity.sh install explicitly, or configure installed runtime paths')
    return found[0]


def process_alive(name):
    pid_file = STATE / (name + '.pid')
    if not pid_file.exists():
        return False
    pid = int(pid_file.read_text())
    try:
        os.kill(pid, 0)
        command = Path('/proc/' + str(pid) + '/cmdline').read_bytes()
        # Never stop a reused PID belonging to an unrelated process.
        return str(STATE).encode() in command
    except (ProcessLookupError, FileNotFoundError):
        return False


def spawn(name, args, env):
    if process_alive(name):
        return
    with (STATE / (name + '.log')).open('ab') as log:
        process = subprocess.Popen([str(a) for a in args], env=env, stdin=subprocess.DEVNULL,
            stdout=log, stderr=log, start_new_session=True)
    (STATE / (name + '.pid')).write_text(str(process.pid))


def start():
    env = environment()
    for key in ['IDENTITY_DB_PASSWORD', 'KEYCLOAK_ADMIN_PASSWORD', 'GROWTH_OIDC_CLIENT_SECRET', 'GROWTH_SESSION_ADMIN_SECRET']:
        if not env.get(key) or env[key].startswith('replace-'):
            raise RuntimeError('Set independent secrets in .env before starting')
    STATE.mkdir(mode=0o700, exist_ok=True)
    pg = postgres_bin()
    data = STATE / 'postgres'
    password_file = STATE / 'pg-password'
    password_file.write_text(env['IDENTITY_DB_PASSWORD'] + '\n')
    password_file.chmod(0o600)
    try:
        if not (data / 'PG_VERSION').exists():
            run([pg / 'initdb', '-D', data, '-U', 'identity', '--auth=scram-sha-256', '--pwfile', password_file], stdout=subprocess.DEVNULL)
            with (data / 'postgresql.conf').open('a') as stream:
                stream.write("\nlisten_addresses='127.0.0.1'\nport=55432\nshared_buffers='32MB'\nmax_connections=30\n")
    finally:
        password_file.unlink(missing_ok=True)
    # Per-user cluster must not write sockets in the system PostgreSQL directory.
    socket_dir = STATE / 'pg-socket'
    socket_dir.mkdir(mode=0o700, exist_ok=True)
    socket_setting = "unix_socket_directories='" + str(socket_dir).replace("'", "''") + "'"
    if socket_setting not in (data / 'postgresql.conf').read_text():
        with (data / 'postgresql.conf').open('a') as stream:
            stream.write('\n' + socket_setting + '\n')
    alive = subprocess.run([str(pg / 'pg_ctl'), '-D', str(data), 'status'], stdout=subprocess.DEVNULL).returncode == 0
    if not alive:
        run([pg / 'pg_ctl', '-D', data, '-l', STATE / 'postgres.log', '-w', 'start'], stdout=subprocess.DEVNULL)
    pg_env = {**os.environ, 'PGPASSWORD': env['IDENTITY_DB_PASSWORD']}
    check = subprocess.run([str(pg / 'psql'), '-h', '127.0.0.1', '-p', '55432', '-U', 'identity', '-d', 'postgres', '-Atc', "SELECT 1 FROM pg_database WHERE datname='identity'"], env=pg_env, capture_output=True, check=True)
    if check.stdout.strip() != b'1':
        run([pg / 'createdb', '-h', '127.0.0.1', '-p', '55432', '-U', 'identity', 'identity'], env=pg_env)
    keycloak = executable('keycloak', '*/bin/kc.sh')
    java = executable('java', '*/bin/java')
    mailpit = executable('mailpit', 'mailpit')
    imported = keycloak.parent.parent / 'data/import'
    imported.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / 'kasitek-realm.json', imported / 'kasitek-realm.json')
    env.update({'JAVA_HOME': str(java.parent.parent), 'JAVA_OPTS_KC_HEAP': '-Xms128m -Xmx512m',
        'KC_DB': 'postgres', 'KC_DB_URL': 'jdbc:postgresql://127.0.0.1:55432/identity',
        'KC_DB_USERNAME': 'identity', 'KC_DB_PASSWORD': env['IDENTITY_DB_PASSWORD'],
        'KC_BOOTSTRAP_ADMIN_USERNAME': env['KEYCLOAK_ADMIN'], 'KC_BOOTSTRAP_ADMIN_PASSWORD': env['KEYCLOAK_ADMIN_PASSWORD'],
        'KC_HOSTNAME': 'http://localhost:8080', 'KC_HEALTH_ENABLED': 'true', 'KC_METRICS_ENABLED': 'true',
        'KC_FEATURES': 'recovery-codes', 'KC_DB_POOL_INITIAL_SIZE': '2', 'KC_DB_POOL_MIN_SIZE': '2', 'KC_DB_POOL_MAX_SIZE': '10'})
    spawn('mailpit', [mailpit, '--listen', '127.0.0.1:8025', '--smtp', '127.0.0.1:1025', '--database', STATE / 'mailpit.db'], env)
    spawn('keycloak', [keycloak, 'start-dev', '--import-realm', '--http-host=127.0.0.1'], env)
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen('http://localhost:9000/health/ready', timeout=3) as response:
                if response.status == 200:
                    configure()
                    print('Native identity services ready.')
                    return
        except OSError:
            pass
        if not process_alive('keycloak'):
            raise RuntimeError('Keycloak exited; inspect private .runtime/keycloak.log')
        time.sleep(2)
    raise RuntimeError('Keycloak readiness timed out; inspect private runtime logs')


def stop():
    for name in ['keycloak', 'mailpit']:
        if process_alive(name):
            pid = int((STATE / (name + '.pid')).read_text())
            os.killpg(pid, signal.SIGTERM)
            deadline = time.monotonic() + 30
            while process_alive(name) and time.monotonic() < deadline:
                time.sleep(0.2)
            if process_alive(name):
                raise RuntimeError(name + ' did not stop; inspect before retrying')
            (STATE / (name + '.pid')).unlink(missing_ok=True)
    if (STATE / 'postgres/PG_VERSION').exists():
        pg = postgres_bin()
        if subprocess.run([str(pg / 'pg_ctl'), '-D', str(STATE / 'postgres'), 'status'], stdout=subprocess.DEVNULL).returncode == 0:
            run([pg / 'pg_ctl', '-D', STATE / 'postgres', '-w', 'stop'], stdout=subprocess.DEVNULL)
    print('Dedicated local identity processes stopped.')


def backup():
    env = environment()
    folder = ROOT / '.backups'
    folder.mkdir(mode=0o700, exist_ok=True)
    target = folder / time.strftime('identity-%Y%m%dT%H%M%SZ.sql', time.gmtime())
    with target.open('wb') as output:
        target.chmod(0o600)
        run([postgres_bin() / 'pg_dump', '-h', '127.0.0.1', '-p', '55432', '-U', 'identity', '-d', 'identity'], stdout=output, env={**os.environ, 'PGPASSWORD': env['IDENTITY_DB_PASSWORD']})
    print('Backup saved to ' + str(target))


def export():
    env = environment()
    if process_alive('keycloak'):
        raise RuntimeError('Stop identity before exporting to avoid concurrent database access')
    folder = ROOT / '.backups'
    folder.mkdir(mode=0o700, exist_ok=True)
    keycloak = executable('keycloak', '*/bin/kc.sh')
    java = executable('java', '*/bin/java')
    env.update({'JAVA_HOME': str(java.parent.parent), 'JAVA_OPTS_KC_HEAP': '-Xms128m -Xmx512m',
        'KC_DB': 'postgres', 'KC_DB_URL': 'jdbc:postgresql://127.0.0.1:55432/identity',
        'KC_DB_USERNAME': 'identity', 'KC_DB_PASSWORD': env['IDENTITY_DB_PASSWORD'], 'KC_FEATURES': 'recovery-codes'})
    pg = postgres_bin()
    run([pg / 'pg_ctl', '-D', STATE / 'postgres', '-l', STATE / 'postgres.log', '-w', 'start'], stdout=subprocess.DEVNULL)
    try:
        export_dir = folder / 'realm-export'
        export_dir.mkdir(mode=0o700, exist_ok=True)
        run([keycloak, 'export', '--realm', 'kasitek', '--dir', export_dir, '--users', 'skip'], env=env)
        (export_dir / 'kasitek-realm.json').chmod(0o600)
    finally:
        run([pg / 'pg_ctl', '-D', STATE / 'postgres', '-w', 'stop'], stdout=subprocess.DEVNULL)


def restore(source):
    source = Path(source).resolve()
    if not source.is_file():
        raise RuntimeError('Backup file missing')
    if process_alive('keycloak'):
        raise RuntimeError('Stop identity before restoring')
    env = environment()
    pg = postgres_bin()
    run([pg / 'pg_ctl', '-D', STATE / 'postgres', '-l', STATE / 'postgres.log', '-w', 'start'], stdout=subprocess.DEVNULL)
    pg_env = {**os.environ, 'PGPASSWORD': env['IDENTITY_DB_PASSWORD']}
    args = [pg / 'psql', '-h', '127.0.0.1', '-p', '55432', '-U', 'identity', '-v', 'ON_ERROR_STOP=1']
    # Only an isolated validation DB is replaced, never the active identity or Growth DB.
    try:
        run(args + ['-d', 'postgres', '-c', 'DROP DATABASE IF EXISTS identity_restore_check WITH (FORCE)'], env=pg_env)
        run(args + ['-d', 'postgres', '-c', 'CREATE DATABASE identity_restore_check OWNER identity'], env=pg_env)
        with source.open('rb') as stream:
            run(args + ['-d', 'identity_restore_check'], stdin=stream, stdout=subprocess.DEVNULL, env=pg_env)
        run(args + ['-d', 'identity_restore_check', '-c', 'SELECT count(*) FROM realm'], env=pg_env)
        print('Backup restored into isolated identity_restore_check. Active identity database unchanged.')
    finally:
        run([pg / 'pg_ctl', '-D', STATE / 'postgres', '-w', 'stop'], stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['install', 'start', 'stop', 'status', 'configure', 'backup', 'export', 'restore'])
    parser.add_argument('source', nargs='?')
    parsed = parser.parse_args()
    action = parsed.action
    try:
        if action == 'status':
            for name in ['keycloak', 'mailpit']:
                print(name + ': ' + ('running' if process_alive(name) else 'stopped'))
            pg_running = (STATE / 'postgres/PG_VERSION').exists() and subprocess.run([str(postgres_bin() / 'pg_ctl'), '-D', str(STATE / 'postgres'), 'status'], stdout=subprocess.DEVNULL).returncode == 0
            print('postgres: ' + ('running' if pg_running else 'stopped'))
        elif action == 'restore':
            if not parsed.source:
                raise RuntimeError('Provide a SQL backup file')
            restore(parsed.source)
        else:
            globals()[action]()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        raise SystemExit('Identity operation failed: ' + str(error))
