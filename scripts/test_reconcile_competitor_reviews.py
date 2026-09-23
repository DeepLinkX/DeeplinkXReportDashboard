import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('reconcile', Path(__file__).with_name('reconcile-competitor-reviews.py'))
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)


class Response:
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, *_): return json.dumps(self.value).encode()


def entry(relationship='direct'):
    return {'package_name': 'example', 'record': {'package_name': 'example', 'product_commit': 'a' * 40, 'reviewed_by': 'fixture', 'evidence_hash': '', 'decision': {'relationship': relationship, 'review_status': 'reviewed', 'migration_status': 'supported'}}, 'evidence': {'metadata': {'name': 'example', 'version': '1.0.0', 'description': 'Open app'}, 'documentation': 'Launch an app', 'captured_at': '2026-09-20T12:00:00Z'}}


class ReconcileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.out = Path(self.tmp.name)
    def tearDown(self): self.tmp.cleanup()

    def test_secret_environment_and_file_never_persisted(self):
        path = self.out / '.dev.vars'; path.write_text('ADMIN_TOKEN="file-secret"\n')
        with patch.dict(os.environ, {'DEEPLINKX_ADMIN_TOKEN': 'env-secret'}):
            self.assertEqual(r.token_from(path), 'env-secret')
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(r.token_from(path), 'file-secret')
        def opener(req, **_):
            self.assertEqual(req.get_header('Authorization'), 'Bearer env-secret')
            self.assertTrue(req.get_header('Idempotency-key').startswith('review-reconcile-'))
            return Response({'packages': []})
        client = r.Client(self.out, 'env-secret', opener)
        client.request(r.ADMIN + 'policy/preview', {'packages': ['example']}, protected=True)
        for file in (self.out / 'responses').glob('*.json'):
            self.assertNotIn('env-secret', file.read_text())
            self.assertNotIn('Authorization', file.read_text())

    def test_429_deadline_and_no_network_resume_before_retry_after(self):
        count = 0
        def opener(*_, **__):
            nonlocal count; count += 1
            raise urllib.error.HTTPError(r.ORIGIN, 429, 'rate limit', {'Retry-After': '120'}, io.BytesIO(b'secret-in-body'))
        client = r.Client(self.out, 'token', opener)
        with self.assertRaises(r.PhaseStopped): client.request('/api/v1/competitors/example')
        with self.assertRaises(r.PhaseStopped): client.request('/api/v1/competitors/another')
        self.assertEqual(count, 1)
        state = (self.out / 'http-state.json').read_text()
        self.assertNotIn('secret-in-body', state)
        self.assertGreater(r.read(self.out / 'http-state.json')['resume_after'], r.time.time() + 110)

    def test_d1_quota_stops_entire_phase(self):
        calls = []
        def opener(req, **_):
            calls.append(req.full_url)
            raise urllib.error.HTTPError(req.full_url, 503, 'quota', {}, io.BytesIO(b'D1 free tier daily row read limit reached'))
        client = r.Client(self.out, 'token', opener)
        entries = [{'package_name': 'package_' + str(i)} for i in range(12)]
        with self.assertRaisesRegex(r.PhaseStopped, 'entire phase'): r.preview(entries, client, self.out)
        self.assertEqual(len(calls), 1)

    def test_response_persistence_before_aggregate_prevents_repeated_request(self):
        calls = []
        def opener(req, **_):
            calls.append(req.full_url)
            return Response({'packages': [{'package_name': 'example'}]})
        client = r.Client(self.out, 'token', opener)
        original = r.save
        def crash(path, value):
            if Path(path).name == 'preview.json': raise KeyboardInterrupt()
            original(path, value)
        with patch.object(r, 'save', side_effect=crash):
            with self.assertRaises(KeyboardInterrupt): r.preview([entry()], client, self.out)
        r.preview([entry()], client, self.out)
        self.assertEqual(len(calls), 1)

    def test_noise_never_captures_metrics_and_unknown_is_bounded(self):
        client = r.Client(self.out, opener=lambda *_: self.fail('noise request'))
        self.assertEqual(r.capture_metrics([entry('noise')], client, self.out), {})
        unknown = [{**entry('unknown'), 'package_name': 'p_' + str(i), 'metrics_selected': True} for i in range(120)]
        self.assertEqual(len(r.metric_pool(unknown)), 100)
        self.assertEqual(r.metric_pool([entry('unknown')]), [])

    def test_cloudflare_metrics_reused_without_score_fetch(self):
        calls = []
        def opener(req, **_):
            calls.append(req.full_url)
            return Response({'package': {'downloads_30d': 1, 'likes': 2, 'points': 160, 'max_points': 160, 'metrics_captured_at': '2026-09-20'}})
        client = r.Client(self.out, opener=opener)
        r.capture_metrics([entry()], client, self.out)
        r.capture_metrics([entry()], client, self.out)
        self.assertEqual(len(calls), 1)
        self.assertEqual(r.report([entry()], self.out)['metrics_complete'], 1)

    def test_conflicting_same_version_cloudflare_document_stays_draft(self):
        current = {'metadata': {'version': '1.0.0'}, 'documentation_sha256': r.sha('Newer CF documentation'), 'evidence_hash': 'b' * 64, 'catalog_product_commit': 'a' * 40}
        r.save(self.out / 'preview.json', {'example': current})
        client = r.Client(self.out, 'token', lambda *_: self.fail('must not overwrite'))
        self.assertEqual(r.sync([entry()], {'product_commit': 'a' * 40}, client, self.out, True), {})
        self.assertIn('Cloudflare documentation differs', r.read(self.out / 'drafts.json')['example']['reason'])
        self.assertEqual(r.import_reviews([entry()], client, self.out, True), {})

    def test_import_unknown_stays_draft_and_apply_required(self):
        r.save(self.out / 'sync-applied.json', {'example': {'status': 'synced', 'evidence_hash': 'b' * 64, 'product_commit': 'a' * 40}})
        client = r.Client(self.out, 'token', lambda *_: self.fail('preview must not import'))
        ready = r.import_reviews([entry()], client, self.out)
        self.assertEqual(set(ready['example']), set(r.FIELDS))
        self.assertFalse((self.out / 'imported.json').exists())
        self.assertEqual(r.import_reviews([entry('unknown')], client, self.out, True), {})

    def test_sync_import_success_and_resume_are_idempotent(self):
        calls = []
        def opener(req, **_):
            calls.append(req.full_url)
            if req.full_url.endswith('policy/preview'):
                return Response({'product_commit': 'a' * 40, 'packages': [{'package_name': 'example', 'evidence_hash': None, 'metadata': None, 'documentation_sha256': r.sha('')}]})
            if req.full_url.endswith('evidence/sync'):
                payload = json.loads(req.data)
                self.assertFalse(payload['dry_run'])
                self.assertIsNone(payload['packages'][0]['expected_evidence_hash'])
                return Response({'results': [{'package_name': 'example', 'status': 'synced', 'evidence_hash': 'b' * 64, 'product_commit': 'a' * 40}]})
            self.assertEqual(set(json.loads(req.data)), set(r.FIELDS))
            return Response({'status': 'reviewed'})
        client = r.Client(self.out, 'token', opener)
        r.sync([entry()], {'product_commit': 'a' * 40}, client, self.out, True)
        r.import_reviews([entry()], client, self.out, True)
        r.sync([entry()], {'product_commit': 'a' * 40}, client, self.out, True)
        r.import_reviews([entry()], client, self.out, True)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(r.read(self.out / 'imported.json')), 1)

    def test_metrics_missing_cloudflare_uses_score_without_auth(self):
        calls = []
        def opener(req, **_):
            calls.append(req.full_url)
            self.assertIsNone(req.get_header('Authorization'))
            if 'pub.dev' not in req.full_url:
                raise urllib.error.HTTPError(req.full_url, 404, 'missing', {}, io.BytesIO(b'{}'))
            return Response({'downloadCount30Days': 9, 'likeCount': 4, 'grantedPoints': 160, 'maxPoints': 160})
        client = r.Client(self.out, 'private-token', opener)
        metrics = r.capture_metrics([entry()], client, self.out)
        self.assertEqual(metrics['example']['metrics']['downloads_30d'], 9)
        self.assertEqual(metrics['example']['missing'], [])
        self.assertEqual(len(calls), 2)


    def test_confirmed_noise_is_never_in_metric_pool_or_requested(self):
        seen = []
        class Recording:
            def request(self, path, **kwargs):
                seen.append(path)
                return {'package': {'downloads_30d': 10, 'likes': 1, 'points': 100, 'max_points': 100}}
        noise = entry('noise')
        r.capture_metrics([noise], Recording(), self.out)
        self.assertEqual(seen, [])
        self.assertIsNone(r.read(self.out / 'metrics.json'))

    def test_local_matching_metrics_fill_cloudflare_gaps(self):
        seen = []
        class Recording:
            def request(self, path, **kwargs):
                seen.append(path)
                return {'package': {'downloads_30d': None, 'likes': None, 'points': 100, 'max_points': 100, 'metrics_captured_at': '2026-09-20T00:00:00Z'}}
        item = entry()
        item['metrics'] = {'downloads_30d': 42, 'likes': 7}
        item['metrics_observed_at'] = '2026-09-19T00:00:00Z'
        result = r.capture_metrics([item], Recording(), self.out)['example']
        self.assertEqual(seen, ['/api/v1/competitors/example'])
        self.assertEqual(result['metrics']['downloads_30d'], 42)
        self.assertEqual(result['local_reuse']['observed_at'], '2026-09-19T00:00:00Z')

    def test_cloudflare_only_leaves_gaps_without_pubdev(self):
        seen = []
        class Recording:
            def request(self, path, **kwargs):
                seen.append(path)
                return {'package': {}}
        result = r.capture_metrics([entry()], Recording(), self.out, cloudflare_only=True)['example']
        self.assertEqual(seen, ['/api/v1/competitors/example'])
        self.assertEqual(result['missing'], list(r.METRICS))
        self.assertFalse(result.get('supplement'))

    def test_manifest_pointers_and_repo_output_rejection(self):
        item = entry()
        r.save(self.out / 'record.json', item['record']); r.save(self.out / 'evidence.json', item['evidence'])
        r.save(self.out / 'manifest.json', {'packages': [{'package_name': 'example', 'review_path': 'record.json', 'source_evidence_path': 'evidence.json'}]})
        _, entries = r.load_manifest(self.out / 'manifest.json')
        self.assertEqual(entries[0]['record'], item['record'])
        (self.out / '.git').mkdir()
        with self.assertRaises(ValueError): r.outside_repo(self.out / 'generated')


if __name__ == '__main__': unittest.main()
