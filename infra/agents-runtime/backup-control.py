#!/usr/bin/env python3
"""Offline Agents backup operations. Configuration contains paths/commands, never credentials."""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile

UTC = dt.timezone.utc
WAL_NAME = re.compile(r"(?:[0-9A-F]{24}(?:\.[0-9A-F]{8}\.backup)?|[0-9A-F]{8}\.history)\Z")
SNAPSHOT_NAME = re.compile(r"\d{8}T\d{6}Z\.age\Z")

def now():
    return dt.datetime.now(UTC)

def instant(value):
    result = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise ValueError("TIMESTAMP_TIMEZONE_REQUIRED")
    return result.astimezone(UTC)

def emit(event, **fields):
    print(json.dumps({"event": event, "at": now().isoformat(), **fields}), flush=True)

def run(argv, **kwargs):
    subprocess.run(argv, check=True, stdout=kwargs.pop("stdout", subprocess.DEVNULL), stderr=subprocess.DEVNULL, **kwargs)

def hook(config, key, **values):
    command = config.get(key)
    if not isinstance(command, list) or not command or not all(isinstance(v, str) and v for v in command):
        raise ValueError("MISSING_" + key.upper())
    # Arguments remain arguments; no shell expansion or command evaluation.
    run([v.format(**values) for v in command])

def root(config):
    value = Path(config["backup_root"]).resolve()
    value.mkdir(mode=0o700, parents=True, exist_ok=True)
    if value.stat().st_mode & 0o077:
        raise ValueError("BACKUP_DIRECTORY_MUST_BE_PRIVATE")
    return value

def staging(config):
    value = Path(config["staging_root"]).resolve()
    value.mkdir(mode=0o700, parents=True, exist_ok=True)
    if value.stat().st_mode & 0o077:
        raise ValueError("STAGING_DIRECTORY_MUST_BE_PRIVATE")
    return str(value)

def identity(config):
    value = Path(config["age_identity"]).resolve()
    if value.stat().st_mode & 0o077:
        raise ValueError("RESTORE_KEY_MUST_BE_PRIVATE")
    if value.is_relative_to(root(config)):
        raise ValueError("RESTORE_KEY_MUST_BE_OUTSIDE_BACKUP_STORAGE")
    return value

def signing_key(config, setting, private):
    path = Path(config[setting]).resolve(strict=True)
    stat = path.stat()
    if not path.is_file() or stat.st_uid not in {0, os.getuid()} or stat.st_mode & (0o077 if private else 0o022):
        raise ValueError("SIGNING_KEY_OWNERSHIP_INVALID")
    if private:
        excluded = [root(config), Path(config["staging_root"]).resolve()]
        excluded += [Path(config[key]).resolve() for key in ["object_root", "restate_root"] if config.get(key)]
        if any(path.is_relative_to(directory) for directory in excluded):
            raise ValueError("SIGNING_KEY_INSIDE_CAPTURED_STORAGE")
    return path

def sign_file(config, source, signature, setting="snapshot_signing_key"):
    run(["openssl", "pkeyutl", "-sign", "-rawin", "-inkey", str(signing_key(config, setting, True)), "-in", str(source), "-out", str(signature)])

def verify_file(config, source, signature, setting="snapshot_verify_key"):
    run(["openssl", "pkeyutl", "-verify", "-rawin", "-pubin", "-inkey", str(signing_key(config, setting, False)), "-in", str(source), "-sigfile", str(signature)])

def encrypt(config, source, target):
    temporary = target.with_name(target.name + ".partial")
    try:
        run(["age", "--recipient", config["age_recipient"], "--output", str(temporary), str(source)])
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)

def decrypt(config, source, target):
    run(["age", "--decrypt", "--identity", str(identity(config)), "--output", str(target), str(source)])

def copy_private(source, target):
    source = Path(source).resolve(strict=True)
    for current, dirs, files in os.walk(source):
        for name in dirs + files:
            item = Path(current) / name
            if item.is_symlink() or not (item.is_dir() or item.is_file()):
                raise ValueError("SNAPSHOT_SOURCE_CONTAINS_SPECIAL_FILE")
    shutil.copytree(source, target)

def backup(config):
    signing_key(config, "snapshot_signing_key", True)
    for setting in ["ledger_signing_key", "age_identity"]:
        if config.get(setting): signing_key(config, setting, True)
    destination = root(config) / "snapshots"
    destination.mkdir(mode=0o700, exist_ok=True)
    snapshot = now().strftime("%Y%m%dT%H%M%SZ")
    output = destination / (snapshot + ".age")
    if output.exists():
        raise ValueError("SNAPSHOT_ALREADY_EXISTS")
    stopped = False
    with tempfile.TemporaryDirectory(prefix="agents-backup-", dir=staging(config)) as temporary:
        stage = Path(temporary)
        try:
            # Stop new writers and close Restate cleanly before copying its data directory.
            stopped = True
            hook(config, "quiesce_command")
            hook(config, "writers_stopped_command")
            env = {**os.environ, "PGSERVICE": config["postgres_service"]}
            catalog = subprocess.check_output(["psql", "-X", "-qAt", "--set", "ON_ERROR_STOP=1", "-c",
                "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname<>'postgres' ORDER BY datname"], env=env, stderr=subprocess.DEVNULL).decode().splitlines()
            if catalog != [config["postgres_database"]]:
                raise ValueError("DEDICATED_AGENTS_CLUSTER_REQUIRED")
            tablespaces = subprocess.check_output(["psql", "-X", "-qAt", "--set", "ON_ERROR_STOP=1", "-c",
                "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN ('pg_default','pg_global')"], env=env, stderr=subprocess.DEVNULL).decode().strip()
            if tablespaces != "0":
                raise ValueError("EXTERNAL_TABLESPACES_UNSUPPORTED")
            run(["pg_basebackup", "--pgdata", str(stage / "postgres"), "--wal-method=stream", "--checkpoint=fast"], env=env)
            run(["pg_verifybackup", str(stage / "postgres")])
            if config.get("object_root"):
                copy_private(config["object_root"], stage / "objects")
            else:
                (stage / "objects").mkdir(mode=0o700)
                hook(config, "object_export_command", objects=str(stage / "objects"))
            copy_private(config["restate_root"], stage / "restate")
            hook(config, "ledger_export_command", ledger=str(stage / "deletions.json"))
            validate_ledger(stage / "deletions.json", now() - dt.timedelta(minutes=15))
            manifest = {"format": "agents-backup-v1", "id": snapshot, "completedAt": now().isoformat(),
                        "databaseService": config["postgres_service"], "restateVersion": config["restate_version"],
                        "hardExpiryDays": 35, "pitrDays": 7}
            (stage / "manifest.json").write_text(json.dumps(manifest))
            archive = stage / "bundle.tar.gz"
            with tarfile.open(archive, "w:gz") as tar:
                for name in ["postgres", "objects", "restate", "deletions.json", "manifest.json"]:
                    tar.add(stage / name, arcname=name)
            encrypt(config, archive, output)
            sign_file(config, output, output.with_suffix(".age.sig"))
            emit("agents.backup.completed", snapshot=snapshot)
        finally:
            if stopped:
                hook(config, "resume_command")

def archive_wal(config, source, name):
    if not WAL_NAME.fullmatch(name):
        raise ValueError("WAL_NAME_INVALID")
    directory = root(config) / "wal"
    directory.mkdir(mode=0o700, exist_ok=True)
    source = Path(source).resolve(strict=True)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    target = directory / (name + ".age")
    receipt = directory / (name + ".sha256")
    if target.exists():
        if not receipt.exists() or receipt.read_text() != digest:
            raise ValueError("WAL_ARCHIVE_COLLISION")
        if not target.with_suffix(".age.sig").exists():
            sign_file(config, target, target.with_suffix(".age.sig"))
        return
    with tempfile.TemporaryDirectory(prefix="agents-wal-", dir=staging(config)) as temporary:
        stage = Path(temporary)
        (stage / "manifest.json").write_text(json.dumps({"name": name, "sha256": digest}))
        archive = stage / "wal.tar"
        with tarfile.open(archive, "w") as tar:
            tar.add(source, arcname="wal")
            tar.add(stage / "manifest.json", arcname="manifest.json")
        encrypt(config, archive, target)
        sign_file(config, target, target.with_suffix(".age.sig"))
    receipt.write_text(digest)

def restore_wal(config, name, target):
    if not WAL_NAME.fullmatch(name):
        raise ValueError("WAL_NAME_INVALID")
    source = root(config) / "wal" / (name + ".age")
    if not source.is_file():
        raise ValueError("WAL_UNAVAILABLE")
    verify_file(config, source, source.with_suffix(".age.sig"))
    with tempfile.TemporaryDirectory(prefix="agents-wal-restore-", dir=staging(config)) as temporary:
        archive = Path(temporary) / "wal.tar"
        decrypt(config, source, archive)
        with tarfile.open(archive) as tar:
            if sorted(member.name for member in tar.getmembers()) != ["manifest.json", "wal"] or any(not member.isfile() for member in tar.getmembers()):
                raise ValueError("WAL_ENVELOPE_INVALID")
            manifest = json.load(tar.extractfile("manifest.json"))
            data = tar.extractfile("wal").read()
            if manifest != {"name": name, "sha256": hashlib.sha256(data).hexdigest()}:
                raise ValueError("WAL_IDENTITY_MISMATCH")
        output = Path(target)
        temporary_output = output.with_name(output.name + ".agents-partial")
        temporary_output.write_bytes(data)
        os.replace(temporary_output, output)

def validate_ledger(path, minimum):
    ledger = json.loads(path.read_text())
    if ledger.get("complete") is not True or not isinstance(ledger.get("conversations"), list) or not isinstance(ledger.get("memory"), list):
        raise ValueError("DELETION_LEDGER_INCOMPLETE")
    exported = instant(ledger["exportedAt"])
    if exported < minimum or exported > now() + dt.timedelta(minutes=1):
        raise ValueError("DELETION_LEDGER_STALE")
    return ledger

def export_ledger(config):
    with tempfile.TemporaryDirectory(prefix="agents-ledger-", dir=staging(config)) as temporary:
        source = Path(temporary) / "ledger.json"
        hook(config, "ledger_export_command", ledger=str(source))
        ledger = validate_ledger(source, now() - dt.timedelta(minutes=15))
        source.write_bytes(json.dumps(ledger, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())
        signature = Path(temporary) / "signature"
        sign_file(config, source, signature, "ledger_signing_key")
        envelope = Path(temporary) / "signed-ledger.json"
        envelope.write_text(json.dumps({"ledger": ledger, "signature": base64.b64encode(signature.read_bytes()).decode()}))
        encrypt(config, envelope, root(config) / "current-deletions.age")
    emit("agents.backup.ledger_exported")

def restore_stage(config, snapshot, target):
    source = Path(snapshot).resolve(strict=True)
    target = Path(target).resolve()
    if target.exists():
        raise ValueError("RESTORE_TARGET_MUST_NOT_EXIST")
    hook(config, "writers_stopped_command")
    verify_file(config, source, source.with_suffix(".age.sig"))
    with tempfile.TemporaryDirectory(prefix="agents-restore-", dir=staging(config)) as temporary:
        archive = Path(temporary) / "bundle.tar.gz"
        decrypt(config, source, archive)
        target.mkdir(mode=0o700, parents=True)
        (target / "RESTORE_BLOCKED.json").write_text(json.dumps({"at": now().isoformat(), "reason": "ledger_and_custody_verification_required"}))
        with tarfile.open(archive) as tar:
            for member in tar.getmembers():
                path = Path(member.name)
                if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
                    raise ValueError("BACKUP_MEMBER_INVALID")
                if path.parts[0] not in {"postgres", "objects", "restate", "deletions.json", "manifest.json"}:
                    raise ValueError("BACKUP_MEMBER_INVALID")
            tar.extractall(target, filter="data")
        manifest = json.loads((target / "manifest.json").read_text())
        if manifest.get("format") != "agents-backup-v1" or instant(manifest["completedAt"]) < now() - dt.timedelta(days=35):
            raise ValueError("BACKUP_EXPIRED_OR_UNSUPPORTED")
        if not all((target / name).exists() for name in ["postgres/PG_VERSION", "postgres/backup_manifest", "objects", "restate", "deletions.json"]):
            raise ValueError("BACKUP_CONTENT_INCOMPLETE")
        run(["pg_verifybackup", str(target / "postgres")])
    emit("agents.restore.staged", snapshot=manifest["id"], access="blocked")

def restore_release(config, target, ledger):
    target = Path(target).resolve(strict=True)
    blocked = target / "RESTORE_BLOCKED.json"
    if not blocked.is_file():
        raise ValueError("RESTORE_BLOCK_MARKER_REQUIRED")
    manifest = json.loads((target / "manifest.json").read_text())
    started = now()
    hook(config, "writers_stopped_command")
    # This must be a current independently retained export, never only the ledger in the snapshot.
    with tempfile.TemporaryDirectory(prefix="agents-restore-ledger-", dir=staging(config)) as temporary:
        current = Path(temporary) / "ledger.json"
        signed = Path(temporary) / "signed-ledger.json"
        decrypt(config, Path(ledger).resolve(strict=True), signed)
        envelope = json.loads(signed.read_text())
        if set(envelope) != {"ledger", "signature"}:
            raise ValueError("SIGNED_LEDGER_INVALID")
        current.write_bytes(json.dumps(envelope["ledger"], sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode())
        signature = Path(temporary) / "signature"
        signature.write_bytes(base64.b64decode(envelope["signature"], validate=True))
        verify_file(config, current, signature, "ledger_verify_key")
        validate_ledger(current, max(instant(manifest["completedAt"]), now() - dt.timedelta(minutes=15)))
        hook(config, "ledger_replay_command", ledger=str(current), service=config["restore_database_service"])
        # Deployment check must verify isolated PG, object custody and Restate together, including
        # journal/receipt safety if PostgreSQL was advanced beyond the matched nightly snapshot.
        hook(config, "recovery_check_command", restore=str(target), service=config["restore_database_service"])
    report = {"verifiedAt": now().isoformat(), "snapshot": manifest["id"], "verificationSeconds": (now() - started).total_seconds(),
              "automaticPromotion": False}
    (target / "RESTORE_VERIFIED.json").write_text(json.dumps(report))
    blocked.unlink()
    emit("agents.restore.verified", snapshot=manifest["id"], automaticPromotion=False)

def prune(config, apply):
    base = root(config)
    cutoff = now() - dt.timedelta(days=35)
    removed = 0
    for path in (base / "snapshots").glob("*.age"):
        if not SNAPSHOT_NAME.fullmatch(path.name):
            continue
        created = dt.datetime.strptime(path.stem, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
        if created <= cutoff:
            if apply:
                path.unlink()
                path.with_suffix(".age.sig").unlink(missing_ok=True)
            removed += 1
    wal_cutoff = now() - dt.timedelta(days=8)
    # A seven-day target can need the preceding nightly base, so retain one daily anchor margin.
    for path in (base / "wal").glob("*.age"):
        if WAL_NAME.fullmatch(path.stem) and dt.datetime.fromtimestamp(path.stat().st_mtime, UTC) <= wal_cutoff:
            if apply:
                path.unlink()
                path.with_suffix(".sha256").unlink(missing_ok=True)
                path.with_suffix(".age.sig").unlink(missing_ok=True)
            removed += 1
    for directory in [base / "snapshots", base / "wal"]:
        for path in directory.glob("*.age.partial"):
            original_name = path.name.removesuffix(".partial")
            known = SNAPSHOT_NAME.fullmatch(original_name) if directory.name == "snapshots" else WAL_NAME.fullmatch(original_name.removesuffix(".age"))
            if known and dt.datetime.fromtimestamp(path.stat().st_mtime, UTC) <= cutoff:
                if apply: path.unlink()
                removed += 1
    emit("agents.backup.expiry", mode="apply" if apply else "dry_run", objects=removed)

def restore_check(config):
    started = now()
    hook(config, "isolated_restore_check_command")
    (root(config) / "restore-check.json").write_text(json.dumps({"completedAt": now().isoformat(), "durationSeconds": (now() - started).total_seconds()}))
    emit("agents.backup.restore_check_completed")

def status(config):
    base = root(config)
    snapshots = [dt.datetime.strptime(p.stem, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
                 for p in (base / "snapshots").glob("*.age") if SNAPSHOT_NAME.fullmatch(p.name) and p.with_suffix(".age.sig").is_file()]
    ledger = base / "current-deletions.age"
    report = base / "restore-check.json"
    healthy = {"snapshotFresh": bool(snapshots) and max(snapshots) >= now() - dt.timedelta(hours=26),
               "ledgerFresh": ledger.is_file() and dt.datetime.fromtimestamp(ledger.stat().st_mtime, UTC) >= now() - dt.timedelta(minutes=15),
               "restoreCheckFresh": report.is_file() and instant(json.loads(report.read_text())["completedAt"]) >= now() - dt.timedelta(days=32)}
    emit("agents.backup.health", **healthy)
    if not all(healthy.values()):
        raise ValueError("BACKUP_HEALTH_FAILED")

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ["backup", "export-ledger", "restore-check", "status"]:
        sub.add_parser(name)
    wal = sub.add_parser("archive-wal"); wal.add_argument("--source", required=True); wal.add_argument("--name", required=True)
    wal = sub.add_parser("restore-wal"); wal.add_argument("--name", required=True); wal.add_argument("--target", required=True)
    stage = sub.add_parser("restore-stage"); stage.add_argument("--snapshot", required=True); stage.add_argument("--target", required=True)
    release = sub.add_parser("restore-release"); release.add_argument("--target", required=True); release.add_argument("--ledger", required=True)
    expiry = sub.add_parser("prune"); expiry.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    config_path = Path(args.config).resolve(strict=True)
    if config_path.stat().st_mode & 0o022 or config_path.stat().st_uid not in {0, os.getuid()}:
        raise ValueError("CONFIGURATION_OWNERSHIP_INVALID")
    config = json.loads(config_path.read_text())
    required = [] if args.command in {"prune", "status", "restore-check"} else ["age"]
    if args.command == "backup": required += ["psql", "pg_basebackup", "pg_verifybackup"]
    if args.command == "restore-stage": required += ["pg_verifybackup"]
    if args.command in {"backup", "archive-wal", "restore-wal", "export-ledger", "restore-stage", "restore-release"}: required += ["openssl"]
    if any(shutil.which(program) is None for program in required):
        raise ValueError("BACKUP_DEPENDENCY_UNAVAILABLE")
    if args.command == "backup": backup(config)
    elif args.command == "archive-wal": archive_wal(config, args.source, args.name)
    elif args.command == "restore-wal": restore_wal(config, args.name, args.target)
    elif args.command == "export-ledger": export_ledger(config)
    elif args.command == "restore-stage": restore_stage(config, args.snapshot, args.target)
    elif args.command == "restore-release": restore_release(config, args.target, args.ledger)
    elif args.command == "prune": prune(config, args.apply)
    elif args.command == "restore-check": restore_check(config)
    elif args.command == "status": status(config)

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # Avoid command arguments, connection strings, content or raw subprocess errors in logs.
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[A-Z_]+", str(error)) else "OPERATION_FAILED"
        emit("agents.backup.failed", errorType=type(error).__name__, code=code)
        sys.exit(1)
