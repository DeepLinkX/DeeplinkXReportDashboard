#!/usr/bin/env python3
"""Thin Cloudflare review-operation client. No local ledger or pub.dev requests."""
import argparse
import datetime as dt
import hashlib
import gzip
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid

ORIGIN = 'https://deeplinkx-visibility.parham-dev.workers.dev'
ROOT = '/api/v1/admin/competitors/review-operations'

class CurlResponse:
    def __init__(self, body, headers):
        self.body, self.headers = body, headers
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, limit=-1): return self.body if limit < 0 else self.body[:limit]


def curl_open(req, timeout=60):
    """Use the system HTTP client for Cloudflare, whose WAF rejects urllib's UA."""
    config = [f'url = {json.dumps(req.full_url)}', f'request = {json.dumps(req.get_method())}',
        f'max-time = {int(timeout)}', 'max-redirs = 0', 'silent', 'show-error']
    for name, value in req.header_items():
        config.append(f'header = {json.dumps(name + ": " + value)}')
    if req.data is not None:
        config.append('data-binary = "@-"')
        rate=os.environ.get('DEEPLINKX_UPLOAD_RATE','')
        if len(req.data)>1024 and rate.isdigit() and int(rate)>0:config.append(f'limit-rate = {int(rate)}')
    config_path = None
    try:
        with tempfile.NamedTemporaryFile('w', encoding='utf-8', prefix='deeplinkx-curl-', suffix='.conf', delete=False) as stream:
            config_path = Path(stream.name)
            os.chmod(config_path, 0o600)
            stream.write('\n'.join(config) + '\n')
        completed = subprocess.run(['curl', '--http1.1', '--config', str(config_path), '--dump-header', '-',
            '--write-out', '\n__DEEPLINKX_HTTP_STATUS__:%{http_code}'], input=req.data,
            capture_output=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise urllib.error.URLError('Cloudflare request failed') from None
    finally:
        if config_path is not None:
            config_path.unlink(missing_ok=True)
    marker = b'\n__DEEPLINKX_HTTP_STATUS__:'
    marker_at = completed.stdout.rfind(marker)
    if completed.returncode or marker_at < 0:
        raise urllib.error.URLError('Cloudflare request failed')
    try:
        status = int(completed.stdout[marker_at + len(marker):].strip())
    except ValueError:
        raise urllib.error.URLError('Cloudflare returned an invalid status') from None
    response = completed.stdout[:marker_at]
    header, separator, body = response.partition(b'\r\n\r\n')
    if not separator:
        header, separator, body = response.partition(b'\n\n')
    if not separator:
        raise urllib.error.URLError('Cloudflare returned an invalid response')
    headers = {}
    for line in header.decode('iso-8859-1').splitlines()[1:]:
        if ':' in line:
            name, value = line.split(':', 1)
            headers[name.strip().lower()] = value.strip()
    if len(body) > 50_000_000:
        raise urllib.error.URLError('Cloudflare response exceeded the 50 MB limit')
    if status >= 400:
        raise urllib.error.HTTPError(req.full_url, status, 'Cloudflare request failed', headers, io.BytesIO(body))
    return CurlResponse(body, headers)


def token_from(path):
    value = os.environ.get('DEEPLINKX_ADMIN_TOKEN', '')
    if value:
        return value.strip()
    if path:
        for line in Path(path).read_text().splitlines():
            match = re.match(r'^\s*(?:export\s+)?(?:ADMIN_TOKEN|DEEPLINKX_ADMIN_TOKEN)\s*=\s*(.*?)\s*$', line)
            if match:
                value = match.group(1).strip()
                return value[1:-1] if value[:1] in ('"', "'") and value[-1:] == value[:1] else value
    raise ValueError('Set DEEPLINKX_ADMIN_TOKEN or supply --secrets-file; never paste credentials into prompts.')


def request(token, suffix='', payload=None, key=None):
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
        headers['Idempotency-Key'] = key or uuid.uuid4().hex
    body=None if payload is None else json.dumps(payload).encode()
    if body is not None and len(body)>1024:
        body=gzip.compress(body,mtime=0);headers['Content-Encoding']='gzip'
    req = urllib.request.Request(ORIGIN + ROOT + suffix, data=body, headers=headers)
    # Transport is foreground and secrets go through a mode-0600 temporary config.
    # Mutations are retried only with identical idempotency keys.
    for attempt in range(3):
        try:
            with curl_open(req, timeout=60) as response:
                content = response.read()
            return content if '/report' in suffix else json.loads(content)
        except urllib.error.HTTPError as error:
            text = error.read(5000).decode(errors='replace')
            error.close()
            try:
                reason = json.loads(text).get('error', f'HTTP {error.code}')
            except ValueError:
                reason = f'HTTP {error.code}'
            raise RuntimeError(reason) from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if attempt == 2:
                raise RuntimeError('Transport failed; retry the same operation and idempotency key.') from None


def payload_from(args):
    if args.body:
        return json.load(sys.stdin) if args.body == '-' else json.loads(Path(args.body).read_text())
    return {}


def legacy_records(manifest_path, metrics_report=None, excluded=None, metrics_only=False):
    manifest = json.loads(Path(manifest_path).read_text())
    metrics = {}
    if metrics_report:
        for line in Path(metrics_report).read_text().splitlines():
            match = re.match(r'^\| \[([a-z][a-z0-9_]*)\]\(https://pub.dev/packages/[^)]+\) \| ([^|]+)\| ([^|]+)\| ([^|]+)\| (.*)\|$', line)
            if not match:
                continue
            name, downloads, likes, points, source = match.groups()
            dates = re.findall(r'20\d{2}-\d{2}-\d{2}T[0-9:.+-]+Z?', source)
            def numeric(value):
                value = value.strip()
                return int(value) if value.isdigit() else None
            pp = points.strip().split('/')
            values = {'downloads_30d': numeric(downloads), 'likes': numeric(likes), 'points': numeric(pp[0]), 'max_points': numeric(pp[1]) if len(pp) == 2 else None}
            if dates and any(v is not None for v in values.values()):
                metrics[name] = (values, dates[-1])
    for member in manifest['packages']:
        if excluded and member['package_name'] in excluded:
            continue
        if metrics_only:
            if member['package_name'] in metrics:
                values,date=metrics[member['package_name']]
                yield {'package_name':member['package_name'],'metrics':values,'metrics_observed_at':date,'metrics_origin':'legacy_report'}
            continue
        review = json.loads(Path(member['review_path']).read_text())
        evidence = json.loads(Path(member['source_evidence_path']).read_text())
        details = review.get('review', {})
        decision = review['decision']
        provenance = {'origin': details.get('decision_origin', 'previous_review'), 'reviewed_at': details.get('reviewed_at'), 'reviewed_by': review.get('reviewed_by'), 'finding': details.get('finding'), 'sources': details.get('sources', []), 'limitations': details.get('limitations', []), 'examined': decision.get('review_status') == 'reviewed', 'audit_status': member.get('audit_status'), 'original_relationship': evidence.get('original',{}).get('relationship',decision['relationship']), 'source_evidence_sha256': member.get('evidence_sha256'), 'source_review_sha256': member.get('review_sha256')}
        record = {'package_name': member['package_name'], 'decision': decision, 'provenance': provenance, 'envelope': {k: review[k] for k in ('package_name','evidence_hash','product_commit','reviewed_by','decision')}}
        metadata = evidence.get('metadata')
        documentation = evidence.get('documentation', '')
        if isinstance(metadata, dict) and metadata.get('version'):
            observed = evidence.get('documentation_captured_at') or evidence.get('metadata_captured_at') or evidence.get('captured_at') or details.get('reviewed_at')
            if observed:
                source = evidence.get('documentation_url') or f"https://pub.dev/packages/{member['package_name']}/versions/{metadata['version']}"
                record['evidence'] = {'package_name': member['package_name'], 'expected_evidence_hash': evidence.get('evidence_hash') or None, 'product_commit': manifest['product_commit'], 'metadata': metadata, 'documentation': documentation, 'observed_at': observed, 'sources': [{'url': source, 'sha256': hashlib.sha256(documentation.encode()).hexdigest(), 'observed_at': observed, 'reason': 'Previously collected, substantively reviewed frozen evidence'}]}
        if member['package_name'] in metrics and decision['relationship'] != 'noise':
            values, date = metrics[member['package_name']]
            record.update(metrics=values, metrics_observed_at=date, metrics_origin='legacy_report')
        yield record


def run(args):
    token = token_from(args.secrets_file)
    if args.command == 'start':
        if not args.key:
            raise ValueError('--key is required for an idempotent operation start')
        body = payload_from(args)
        if args.manifest:
            manifest=json.loads(Path(args.manifest).read_text())
            body['package_names']=[p['package_name'] for p in manifest['packages']]
            body.setdefault('expected_packages',len(body['package_names']))
        body.setdefault('evidence_mode', 'cloudflare_only' if args.cloudflare_only else 'cloudflare_first')
        body.setdefault('apply_reviews', args.apply_reviews)
        if args.expected_packages:
            body['expected_packages'] = args.expected_packages
        return request(token, payload=body, key=args.key)
    if not args.operation:
        if args.command=='status':return request(token)
        raise ValueError('--operation is required')
    suffix = '/' + args.operation
    if args.command == 'status':
        return request(token, suffix)
    if args.command == 'report':
        content = request(token, suffix + '/report?format=' + args.format)
        if args.output:
            Path(args.output).write_bytes(content)
            return {'saved': str(Path(args.output).resolve()), 'bytes': len(content)}
        sys.stdout.write(content.decode())
        return None
    if args.command == 'bootstrap' and args.manifest:
        if getattr(args,'provenance_only',False):
            missing=set(request(token,suffix+'?provenance_missing=1')['package_names'])
            manifest=json.loads(Path(args.manifest).read_text());batch=[];restored=0
            for member in manifest['packages']:
                if member['package_name'] not in missing:continue
                review=json.loads(Path(member['review_path']).read_text());details=review.get('review',{})
                provenance={'origin':details.get('decision_origin','previous_review'),'reviewed_at':details.get('reviewed_at'),'reviewed_by':review.get('reviewed_by'),'source_review_sha256':member.get('review_sha256'),'source_evidence_sha256':member.get('evidence_sha256'),'original_relationship':review['decision']['relationship']}
                batch.append({'package_name':member['package_name'],'provenance':provenance})
                if len(batch)==getattr(args,'batch_size',10):
                    body={'packages':batch,'provenance_only':True}
                    request(token,suffix+'/bootstrap',body,key='provenance-'+hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest())
                    restored+=len(batch);batch=[]
                    if restored%100==0:print(json.dumps({'provenance_restored':restored,'missing_at_start':len(missing)}),file=sys.stderr)
            if batch:
                body={'packages':batch,'provenance_only':True}
                request(token,suffix+'/bootstrap',body,key='provenance-'+hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest());restored+=len(batch)
            return {'original_provenance_records':restored}
        batch = []
        transferred = 0
        product = json.loads(Path(args.inventory).read_text()) if args.inventory else None
        existing=set(request(token,suffix+'?membership=1')['package_names'])
        for record in legacy_records(args.manifest, args.metrics_report, existing):
            batch.append(record)
            if len(batch) == 10:
                body = {'packages': batch}
                if product and transferred == 0:
                    body['inventory'] = {'product_commit': product.get('source_commit') or product.get('product_commit'), 'verified_shared_apis': product.get('verified_shared_apis', [])}
                request(token, suffix + '/bootstrap', body, key='bootstrap-' + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest())
                transferred += len(batch)
                batch = []
        if batch:
            request(token, suffix + '/bootstrap', {'packages': batch}, key='bootstrap-' + hashlib.sha256(json.dumps(batch, sort_keys=True).encode()).hexdigest())
            transferred += len(batch)
        metric_records=0
        if args.metrics_report:
            missing=set(request(token,suffix+'?metrics_missing=1')['package_names'])
            batch=[]
            for record in legacy_records(args.manifest,args.metrics_report,metrics_only=True):
                if record['package_name'] not in missing:continue
                batch.append(record)
                if len(batch)==10:
                    body={'packages':batch,'metrics_only':True}
                    request(token,suffix+'/bootstrap',body,key='legacy-metrics-'+hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest())
                    metric_records+=len(batch);batch=[]
            if batch:
                body={'packages':batch,'metrics_only':True}
                request(token,suffix+'/bootstrap',body,key='legacy-metrics-'+hashlib.sha256(json.dumps(body,sort_keys=True).encode()).hexdigest())
                metric_records+=len(batch)
        return {'transferred': transferred,'legacy_metric_records':metric_records, 'status': request(token, suffix)}
    body = payload_from(args)
    if args.command == 'claim':
        body.setdefault('reviewer', args.reviewer)
        body.setdefault('include_inventory', args.include_inventory)
    action = {'submit': 'results'}.get(args.command, args.command)
    return request(token, suffix + '/' + action, body, key=args.key)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['start','status','bootstrap','claim','evidence','submit','finalize','report'])
    parser.add_argument('--operation')
    parser.add_argument('--secrets-file')
    parser.add_argument('--key')
    parser.add_argument('--body', help='JSON file, or - for stdin')
    parser.add_argument('--cloudflare-only', action='store_true')
    parser.add_argument('--apply-reviews', action='store_true')
    parser.add_argument('--expected-packages', type=int)
    parser.add_argument('--reviewer', default='reviewer')
    parser.add_argument('--include-inventory', action='store_true')
    parser.add_argument('--manifest')
    parser.add_argument('--inventory')
    parser.add_argument('--metrics-report')
    parser.add_argument('--batch-size',type=int,choices=range(1,11),default=10,help='Bounded provenance upload size; reduce on constrained connections')
    parser.add_argument('--provenance-only',action='store_true',help='One-time restoration of missing original reviewer/date/origin; no evidence bodies')
    parser.add_argument('--format', choices=['markdown','json','csv'], default='markdown')
    parser.add_argument('--output')
    args = parser.parse_args(argv)
    try:
        result = run(args)
        if result is not None:
            if args.output and args.command != 'report':
                Path(args.output).write_text(json.dumps(result,ensure_ascii=False),encoding='utf-8')
                result={'saved':str(Path(args.output).resolve()),'packages':len(result.get('packets',[]))}
            print(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    except (ValueError, RuntimeError, OSError) as error:
        parser.exit(1, str(error) + '\n')

if __name__ == '__main__':
    main()
