import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


SCRIPT = Path(__file__).with_name('prepare-d1-backup.py')
SPEC = importlib.util.spec_from_file_location('prepare_d1_backup', SCRIPT)
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


class BackupPreparationTests(unittest.TestCase):
    def test_split_text_preserves_utf8_and_respects_byte_limit(self):
        value = 'a😀終é' * 100
        parts = prepare.split_text(value, 17)
        self.assertEqual(''.join(parts), value)
        self.assertTrue(all(len(part.encode('utf-8')) <= 17 for part in parts))

    def test_generated_data_paths_cannot_point_into_a_git_checkout(self):
        with self.assertRaisesRegex(ValueError, 'outside Git checkouts'):
            prepare.outside_repo(SCRIPT.parent / 'should-not-be-created.json')

    def test_chunk_export_orders_foreign_keys_and_stable_rows(self):
        with tempfile.TemporaryDirectory(prefix='deeplinkx-import-test-', dir='/private/tmp') as root:
            root = Path(root)
            database = root / 'snapshot.sqlite'
            output = root / 'chunks'
            connection = sqlite3.connect(database)
            connection.row_factory = sqlite3.Row
            connection.execute('PRAGMA foreign_keys=ON')
            connection.execute('CREATE TABLE parent (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
            connection.execute('CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id))')
            connection.executemany('INSERT INTO parent VALUES (?,?)', [(2, 'two'), (1, 'one')])
            connection.executemany('INSERT INTO child VALUES (?,?)', [(2, 2), (1, 1)])
            connection.commit()

            manifest = prepare.export_chunks(connection, output, max_rows=1, max_bytes=1024)
            self.assertEqual(list(manifest['tables']), ['parent', 'child'])
            self.assertEqual(manifest['chunk_count'], 4)
            payloads = [json.loads((output / entry['file']).read_text()) for entry in manifest['chunks']]
            self.assertEqual([item['rows'][0][0] for item in payloads if item['table'] == 'parent'], [1, 2])
            self.assertEqual([item['rows'][0][0] for item in payloads if item['table'] == 'child'], [1, 2])
            for entry, payload in zip(manifest['chunks'], payloads):
                self.assertEqual(prepare.sha_bytes(prepare.stable(payload).encode()), entry['sha256'])
            connection.close()

    def test_verifier_flags_artifact_hash_corruption(self):
        with tempfile.TemporaryDirectory(prefix='deeplinkx-verify-test-', dir='/private/tmp') as root:
            database = Path(root) / 'snapshot.sqlite'
            connection = sqlite3.connect(database)
            connection.executescript('''
                CREATE TABLE report_artifacts(id TEXT, content TEXT, content_hash TEXT, content_storage TEXT);
                CREATE TABLE report_artifact_chunks(artifact_id TEXT, chunk_index INTEGER, content TEXT);
                INSERT INTO report_artifacts VALUES ('bad', 'altered', 'not-the-hash', 'inline');
            ''')
            connection.close()
            result = prepare.verify_database(database)
            self.assertEqual(result['integrity_check'], 'ok')
            self.assertEqual(result['artifact_hash_errors'], ['bad'])


if __name__ == '__main__':
    unittest.main()
