import argparse
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import remote

class RemoteTests(unittest.TestCase):
    def args(self, command, **kw):
        values = dict(command=command, secrets_file=None, operation='review-test', key='same-key',body=None,manifest=None,inventory=None,metrics_report=None,cloudflare_only=False,apply_reviews=False,expected_packages=None,reviewer='tester',include_inventory=False,format='markdown',output=None)
        return argparse.Namespace(**(values | kw))

    def test_all_commands_use_worker_and_no_ledger(self):
        for command in ('start','status','bootstrap','claim','evidence','submit','finalize','report'):
            with self.subTest(command=command), patch.object(remote,'token_from',return_value='secret'),patch.object(remote,'request',return_value=b'report' if command=='report' else {'id':'review-test'}) as call,patch('sys.stdout',new_callable=io.StringIO):
                remote.run(self.args(command))
                self.assertTrue(call.called)
                if command not in ('status','report'):
                    self.assertEqual(call.call_args.kwargs.get('key'),'same-key')

    def test_mutation_transport_retry_preserves_key_and_body(self):
        attempts=[]
        def send(req,timeout):
            attempts.append((req.get_header('Idempotency-key'),req.data))
            if len(attempts)==1: raise remote.urllib.error.URLError('connection')
            return remote.CurlResponse(b'{"ok":true}',{})
        with patch.object(remote,'curl_open',side_effect=send):
            self.assertEqual(remote.request('secret','/review-test/results',{'x':1},'stable'),{'ok':True})
        self.assertEqual(attempts[0],attempts[1])

    def test_auth_error_does_not_retry(self):
        error=remote.urllib.error.HTTPError('https://example',401,'Unauthorized',{},io.BytesIO(b'{"error":"Unauthorized"}'))
        with patch.object(remote,'curl_open',side_effect=error) as call:
            with self.assertRaisesRegex(RuntimeError,'Unauthorized'): remote.request('secret')
        self.assertEqual(call.call_count,1)

    def test_start_defaults_and_frozen_dedup_inventory(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'manifest.json';path.write_text(json.dumps({'packages':[{'package_name':'one'},{'package_name':'two'}]}))
            with patch.object(remote,'token_from',return_value='secret'),patch.object(remote,'request',return_value={}) as call:
                remote.run(self.args('start',manifest=str(path),cloudflare_only=True))
                body=call.call_args.kwargs['payload']
                self.assertFalse(body['apply_reviews']);self.assertEqual(body['expected_packages'],2);self.assertEqual(body['evidence_mode'],'cloudflare_only')

    def test_bootstrap_skips_existing_before_reading_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'manifest.json';path.write_text(json.dumps({'packages':[{'package_name':'noise','review_path':'does-not-exist','source_evidence_path':'does-not-exist'}]}))
            with patch.object(remote,'token_from',return_value='secret'),patch.object(remote,'request',side_effect=[{'package_names':['noise']},{'id':'review-test'}]) as call:
                result=remote.run(self.args('bootstrap',manifest=str(path)))
                self.assertEqual(result['transferred'],0);self.assertEqual(call.call_count,2)

    def test_report_download_only_when_requested(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'report.md'
            with patch.object(remote,'token_from',return_value='secret'),patch.object(remote,'request',return_value=b'report'):
                result=remote.run(self.args('report',output=str(output)))
                self.assertEqual(output.read_bytes(),b'report');self.assertEqual(result['bytes'],6)

if __name__=='__main__': unittest.main()

class OutputTests(unittest.TestCase):
    def test_claim_output_saves_packet_once(self):
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'packet.json'
            packet={'packets':[{'package_name':'one'}],'lease_key':'lease'}
            with patch.object(remote,'run',return_value=packet) as call,patch('sys.stdout',new_callable=io.StringIO) as stdout:
                remote.main(['claim','--operation','review-test','--output',str(output)])
                self.assertEqual(json.loads(output.read_text()),packet)
                self.assertEqual(call.call_count,1)
                self.assertEqual(json.loads(stdout.getvalue())['packages'],1)

class ProvenanceTests(unittest.TestCase):
    def test_provenance_bridge_reads_no_evidence_body(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);review=root/'review.json';review.write_text(json.dumps({'reviewed_by':'original reviewer','decision':{'relationship':'noise'},'review':{'reviewed_at':'2026-09-20T00:00:00Z','decision_origin':'manual_llm_review'}}))
            manifest=root/'manifest.json';manifest.write_text(json.dumps({'packages':[{'package_name':'noise','review_path':str(review),'source_evidence_path':'must-not-read','review_sha256':'a'*64,'evidence_sha256':'b'*64}]}))
            args=RemoteTests().args('bootstrap',manifest=str(manifest),provenance_only=True)
            with patch.object(remote,'token_from',return_value='secret'),patch.object(remote,'request',side_effect=[{'package_names':['noise']},{}]) as call:
                self.assertEqual(remote.run(args)['original_provenance_records'],1)
                body=call.call_args.args[2];self.assertTrue(body['provenance_only']);self.assertNotIn('evidence',body['packages'][0]);self.assertEqual(body['packages'][0]['provenance']['reviewed_at'],'2026-09-20T00:00:00Z')

class StatusTests(unittest.TestCase):
    def test_status_without_id_lists_operations(self):
        args=RemoteTests().args('status',operation=None)
        with patch.object(remote,'token_from',return_value='secret'),patch.object(remote,'request',return_value={'operations':[]}) as call:
            remote.run(args)
            self.assertEqual(len(call.call_args.args),1)
