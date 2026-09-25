#!/usr/bin/env python3
"""Prepare a verified, locally migrated D1 snapshot and deterministic import chunks.

All database and generated data files must stay outside this repository.
Only the standard library is required.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile


def sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def stable(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def outside_repo(path):
    target = Path(path).expanduser().resolve()
    if any((parent / '.git').exists() for parent in (target, *target.parents)):
        raise ValueError('Backup databases, manifests, and import chunks must be outside Git checkouts')
    return target


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=path.parent,
                                         prefix=path.name + '.', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


def split_text(value, max_bytes):
    output, current, byte_count = [], [], 0
    for character in value:
        size = len(character.encode('utf-8'))
        if byte_count + size > max_bytes and current:
            output.append(''.join(current))
            current, byte_count = [], 0
        current.append(character)
        byte_count += size
    if current or not output:
        output.append(''.join(current))
    return output


def prepare_database(backup, database, migrations_dir, transform_limit):
    backup, database = Path(backup).resolve(), outside_repo(database)
    if not backup.is_file():
        raise ValueError(f'Backup not found: {backup}')
    if database.exists():
        raise ValueError(f'Refusing to replace existing local database: {database}')
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('PRAGMA foreign_keys=OFF')
        with backup.open(encoding='utf-8') as stream:
            connection.executescript(stream.read())
        applied = {row[0] for row in connection.execute('SELECT name FROM d1_migrations')}
        migration_records = []
        for migration in sorted(Path(migrations_dir).glob('*.sql')):
            name = migration.name
            if name in applied:
                continue
            body = migration.read_text(encoding='utf-8')
            connection.executescript(body)
            connection.execute('INSERT INTO d1_migrations(name) VALUES (?)', (name,))
            connection.commit()
            migration_records.append({'name': name, 'sha256': sha_bytes(body.encode())})

        connection.execute('PRAGMA foreign_keys=ON')
        rows = connection.execute(
            'SELECT id, content, content_hash FROM report_artifacts WHERE length(CAST(content AS BLOB)) > ? ORDER BY id',
            (transform_limit,),
        ).fetchall()
        transformed = []
        for row in rows:
            content = row['content']
            content_bytes = content.encode('utf-8')
            if sha_bytes(content_bytes) != row['content_hash']:
                raise ValueError(f"Artifact hash mismatch before migration: {row['id']}")
            chunks = split_text(content, 256_000)
            with connection:
                connection.execute('DELETE FROM report_artifact_chunks WHERE artifact_id=?', (row['id'],))
                connection.executemany(
                    'INSERT INTO report_artifact_chunks(artifact_id,chunk_index,content) VALUES(?,?,?)',
                    ((row['id'], index, part) for index, part in enumerate(chunks)),
                )
                connection.execute(
                    "UPDATE report_artifacts SET content='',content_storage='chunked' WHERE id=?",
                    (row['id'],),
                )
            restored = ''.join(item[0] for item in connection.execute(
                'SELECT content FROM report_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index',
                (row['id'],),
            ))
            if restored != content or sha_bytes(restored.encode('utf-8')) != row['content_hash']:
                raise ValueError(f"Artifact reconstruction mismatch: {row['id']}")
            transformed.append({'id': row['id'], 'original_bytes': len(content_bytes),
                                'chunks': len(chunks), 'sha256': row['content_hash']})

        check = connection.execute('PRAGMA integrity_check').fetchone()[0]
        if check != 'ok':
            raise ValueError(f'Local SQLite integrity check failed: {check}')
        fk_errors = connection.execute('PRAGMA foreign_key_check').fetchall()
        if fk_errors:
            raise ValueError(f'Local database has {len(fk_errors)} foreign-key violations')
        return connection, {'backup_sha256': file_sha(backup), 'migrations_added': migration_records,
                            'chunked_artifacts': transformed, 'integrity_check': check}
    except BaseException:
        connection.close()
        database.unlink(missing_ok=True)
        raise


def serialize(value):
    if isinstance(value, bytes):
        return {'$blob_base64': base64.b64encode(value).decode('ascii')}
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def ordered_tables(connection):
    tables = [row[0] for row in connection.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
        "AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%' AND name!='backup_import_receipts' ORDER BY name"
    )]
    table_set = set(tables)
    dependencies = {table: set() for table in tables}
    for table in tables:
        for row in connection.execute(f'PRAGMA foreign_key_list("{table}")'):
            if row[2] in table_set and row[2] != table:
                dependencies[table].add(row[2])
    ordered, remaining = [], set(tables)
    while remaining:
        ready = sorted(table for table in remaining if not (dependencies[table] & remaining))
        if not ready:
            raise ValueError('Foreign-key cycle prevents deterministic table ordering')
        ordered.extend(ready)
        remaining.difference_update(ready)
    return ordered


def export_chunks(connection, output, max_rows, max_bytes):
    output = outside_repo(output)
    if output.exists() and any(output.iterdir()):
        raise ValueError(f'Refusing non-empty chunk output directory: {output}')
    output.mkdir(parents=True, exist_ok=True)
    chunk_dir = output / 'chunks'
    chunk_dir.mkdir()
    table_counts = {}
    chunks_manifest = []
    sequence = 0
    for table in ordered_tables(connection):
        info = connection.execute(f'PRAGMA table_info("{table}")').fetchall()
        columns = [row['name'] for row in info]
        primary = [row['name'] for row in sorted((r for r in info if r['pk']), key=lambda r: r['pk'])]
        order = ','.join('"' + name.replace('"', '""') + '"' for name in (primary or ['rowid']))
        quoted_columns = ','.join('"' + name.replace('"', '""') + '"' for name in columns)
        rows = connection.execute(f'SELECT {quoted_columns} FROM "{table}" ORDER BY {order}')
        payload_rows, payload_size, count = [], 0, 0

        def flush():
            nonlocal payload_rows, payload_size, sequence
            if not payload_rows:
                return
            payload = {'table': table, 'columns': columns, 'rows': payload_rows}
            canonical = stable(payload).encode('utf-8')
            sha = sha_bytes(canonical)
            name = f'{sequence:06d}-{table}.json'
            target = chunk_dir / name
            with target.open('wb') as stream:
                stream.write(canonical)
                stream.flush()
                os.fsync(stream.fileno())
            chunks_manifest.append({'chunk_id': name[:-5], 'file': f'chunks/{name}',
                                    'table': table, 'rows': len(payload_rows),
                                    'bytes': len(canonical), 'sha256': sha})
            sequence += 1
            payload_rows, payload_size = [], 0

        for row in rows:
            encoded = [serialize(value) for value in row]
            row_size = len(stable(encoded).encode('utf-8'))
            if payload_rows and (len(payload_rows) >= max_rows or payload_size + row_size > max_bytes):
                flush()
            if row_size > max_bytes:
                raise ValueError(f'One row exceeds import chunk limit in {table}; apply an explicit chunk migration')
            payload_rows.append(encoded)
            payload_size += row_size
            count += 1
        flush()
        table_counts[table] = count
    return {'created_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'tables': table_counts,
            'chunk_count': len(chunks_manifest), 'chunks': chunks_manifest}


def verify_database(database):
    connection = sqlite3.connect(f'file:{Path(database).resolve()}?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    try:
        integrity = connection.execute('PRAGMA integrity_check').fetchone()[0]
        fk = connection.execute('PRAGMA foreign_key_check').fetchall()
        broken = []
        for row in connection.execute("SELECT id,content,content_hash,content_storage FROM report_artifacts"):
            if row['content_storage'] == 'chunked':
                content = ''.join(part[0] for part in connection.execute(
                    'SELECT content FROM report_artifact_chunks WHERE artifact_id=? ORDER BY chunk_index', (row['id'],)))
            else:
                content = row['content']
            if sha_bytes(content.encode('utf-8')) != row['content_hash']:
                broken.append(row['id'])
        return {'integrity_check': integrity, 'foreign_key_errors': len(fk), 'artifact_hash_errors': broken}
    finally:
        connection.close()


def import_chunks(args):
    import email.utils
    import time
    import urllib.error
    import urllib.request

    manifest_path = Path(args.manifest).expanduser().resolve()
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    output = manifest_path.parent
    progress_path = outside_repo(args.progress or output / 'import-progress.json')
    state = json.loads(progress_path.read_text(encoding='utf-8')) if progress_path.exists() else {
        'completed': {}, 'rows_read': 0, 'rows_written': 0, 'started_at': dt.datetime.now(dt.timezone.utc).isoformat(),
    }
    token = os.environ.get('DEEPLINKX_IMPORT_TOKEN', '').strip()
    if not token and args.token_file:
        for line in Path(args.token_file).expanduser().read_text().splitlines():
            if line.startswith('DEEPLINKX_IMPORT_TOKEN='):
                token = line.partition('=')[2].strip().strip('"\'')
                break
    if not token:
        raise ValueError('DEEPLINKX_IMPORT_TOKEN is required')
    if args.max_new_rows_written < 1:
        raise ValueError('--max-new-rows-written must be positive')
    endpoint = args.url.rstrip('/') + '/chunks'
    used_today = int(state.get('today_rows_written', 0)) if state.get('budget_date') == dt.datetime.now(dt.timezone.utc).date().isoformat() else 0
    today = dt.datetime.now(dt.timezone.utc).date().isoformat()
    newly_completed = 0
    for chunk in manifest['chunks']:
        if chunk['chunk_id'] in state['completed']:
            continue
        if used_today >= args.max_new_rows_written:
            state.update(budget_date=today, today_rows_written=used_today, status='daily_import_budget_reached')
            save_json(progress_path, state)
            break
        payload_path = output / chunk['file']
        payload = json.loads(payload_path.read_text(encoding='utf-8'))
        if payload['table'] != chunk['table'] or len(payload['rows']) != chunk['rows'] or sha_bytes(stable(payload).encode()) != chunk['sha256']:
            raise ValueError(f"Frozen import chunk failed local verification: {chunk['chunk_id']}")
        body = {**payload, 'chunk_id': chunk['chunk_id'], 'source_sha256': chunk['sha256']}
        request = urllib.request.Request(endpoint, data=json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode(),
                                         headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                                                  'Accept': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                result = json.loads(response.read(1024 * 1024))
        except urllib.error.HTTPError as error:
            response_body = error.read(4096).decode(errors='replace')
            if error.code == 429 and 'daily_quota_exhausted' in response_body:
                retry_after = error.headers.get('Retry-After', '60')
                try:
                    resume = dt.datetime.now(dt.timezone.utc).timestamp() + max(60, float(retry_after))
                except ValueError:
                    try:
                        resume = email.utils.parsedate_to_datetime(retry_after).timestamp()
                    except (ValueError, TypeError):
                        resume = dt.datetime.now(dt.timezone.utc).timestamp() + 60
                state.update(status='quota_deferred', resume_after=dt.datetime.fromtimestamp(resume, dt.timezone.utc).isoformat(),
                             budget_date=today, today_rows_written=used_today)
                save_json(progress_path, state)
                print(json.dumps({'status': state['status'], 'completed_chunks': len(state['completed']),
                                  'resume_after': state['resume_after']}))
                return 75
            raise RuntimeError(f'Importer HTTP {error.code}; checkpoint retained: {response_body[:300]}') from None
        except (urllib.error.URLError, TimeoutError):
            state.update(status='request_uncertain', last_chunk=chunk['chunk_id'])
            save_json(progress_path, state)
            raise RuntimeError('Importer response uncertain; rerun to check its idempotent receipt') from None
        if result.get('chunk_id') != chunk['chunk_id'] or result.get('status') not in ('imported', 'already_imported'):
            raise RuntimeError(f"Unexpected importer result for {chunk['chunk_id']}")
        state['completed'][chunk['chunk_id']] = {'rows': chunk['rows'], 'source_sha256': chunk['sha256'],
                                                 'status': result['status'], 'completed_at': dt.datetime.now(dt.timezone.utc).isoformat()}
        state['rows_read'] = int(state.get('rows_read', 0)) + int(result.get('rows_read', 0))
        state['rows_written'] = int(state.get('rows_written', 0)) + int(result.get('rows_written', 0))
        if result['status'] == 'imported':
            used_today += int(result.get('rows_written', 0))
        state.update(status='running', budget_date=today, today_rows_written=used_today)
        save_json(progress_path, state)
        newly_completed += 1
        if args.limit and newly_completed >= args.limit:
            break
    done = len(state['completed']) == len(manifest['chunks'])
    state['status'] = 'complete' if done else state.get('status', 'running')
    save_json(progress_path, state)
    print(json.dumps({'status': state['status'], 'new_chunks': newly_completed,
                      'completed_chunks': len(state['completed']), 'total_chunks': len(manifest['chunks']),
                      'rows_read': state['rows_read'], 'rows_written': state['rows_written'],
                      'today_rows_written': used_today, 'progress': str(progress_path)}))
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    prepare = sub.add_parser('prepare')
    prepare.add_argument('--backup', required=True)
    prepare.add_argument('--database', required=True)
    prepare.add_argument('--manifest', required=True)
    prepare.add_argument('--migrations-dir', default='migrations')
    prepare.add_argument('--chunk-threshold-bytes', type=int, default=1_500_000)
    chunks = sub.add_parser('chunks')
    chunks.add_argument('--database', required=True)
    chunks.add_argument('--output', required=True)
    chunks.add_argument('--max-rows', type=int, default=40)
    chunks.add_argument('--max-bytes', type=int, default=1_500_000)
    verify = sub.add_parser('verify')
    verify.add_argument('--database', required=True)
    importer = sub.add_parser('import')
    importer.add_argument('--manifest', required=True)
    importer.add_argument('--url', required=True)
    importer.add_argument('--token-file')
    importer.add_argument('--progress')
    importer.add_argument('--limit', type=int, default=0, help='Import at most this many new chunks in this invocation')
    importer.add_argument('--max-new-rows-written', type=int, default=20_000,
                          help='Daily import budget, leaving account quota for the live Worker')
    args = parser.parse_args()
    if args.command == 'prepare':
        connection, manifest = prepare_database(args.backup, args.database, args.migrations_dir, args.chunk_threshold_bytes)
        try:
            manifest_path = outside_repo(args.manifest)
            manifest['database_path'] = str(Path(args.database).resolve())
            manifest['database_sha256'] = file_sha(args.database)
            save_json(manifest_path, manifest)
            print(json.dumps({'database': str(Path(args.database).resolve()), 'manifest': str(manifest_path),
                              'migrations_added': len(manifest['migrations_added']),
                              'chunked_artifacts': len(manifest['chunked_artifacts'])}))
        finally:
            connection.close()
    elif args.command == 'chunks':
        connection = sqlite3.connect(f'file:{Path(args.database).resolve()}?mode=ro', uri=True)
        connection.row_factory = sqlite3.Row
        try:
            manifest = export_chunks(connection, args.output, args.max_rows, args.max_bytes)
            save_json(Path(args.output) / 'import-manifest.json', manifest)
            print(json.dumps({'chunks': manifest['chunk_count'], 'tables': len(manifest['tables']),
                              'manifest': str(Path(args.output) / 'import-manifest.json')}))
        finally:
            connection.close()
    elif args.command == 'import':
        raise SystemExit(import_chunks(args))
    else:
        print(json.dumps(verify_database(args.database)))


if __name__ == '__main__':
    main()
