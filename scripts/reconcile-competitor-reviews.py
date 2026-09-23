#!/usr/bin/env python3
"""Sequential, checkpointed reconciliation of frozen local competitor decisions.

No command applies mutations without --apply. Outputs belong outside Git checkouts.
"""
import argparse
import datetime as dt
import email.utils
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.error
import urllib.request

ORIGIN = 'https://deeplinkx-visibility.parham-dev.workers.dev'
ADMIN = '/api/v1/admin/competitors/'
NAME = re.compile(r'^[a-z][a-z0-9_]{0,99}$')
FIELDS = ('package_name', 'evidence_hash', 'product_commit', 'reviewed_by', 'decision')
METRICS = ('downloads_30d', 'likes', 'points', 'max_points')


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read(path, default=None):
    p = Path(path)
    return json.loads(p.read_text()) if p.exists() else default


def save(path, value):
    p = Path(path); p.parent.mkdir(parents=True, exist_ok=True)
    tmp = None
    try:
        with tempfile.NamedTemporaryFile('w', dir=p.parent, prefix=p.name + '.', delete=False) as stream:
            tmp = stream.name
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(tmp, p)
    finally:
        if tmp:
            Path(tmp).unlink(missing_ok=True)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def outside_repo(path):
    p = Path(path).expanduser().resolve()
    if any((parent / '.git').exists() for parent in (p, *p.parents)):
        raise ValueError('--output must be outside Git checkouts')
    return p


def token_from(secrets_file=None):
    token = (os.environ.get('DEEPLINKX_ADMIN_TOKEN') or os.environ.get('DEEPLINKX_VISIBILITY_ADMIN_TOKEN') or '').strip()
    if token:
        return token
    if secrets_file:
        for line in Path(secrets_file).expanduser().read_text().splitlines():
            match = re.match(r'^\s*(?:export\s+)?(?:DEEPLINKX_ADMIN_TOKEN|DEEPLINKX_VISIBILITY_ADMIN_TOKEN|ADMIN_TOKEN)\s*=\s*(.*?)\s*$', line)
            if match:
                value = match.group(1)
                if value[:1] in ('"', "'") and value[-1:] == value[:1]:
                    return value[1:-1]
                return value.split(' #', 1)[0].strip()
    raise ValueError('DEEPLINKX_ADMIN_TOKEN is required for protected phases')


def retry_seconds(value):
    try:
        return max(0, float(value))
    except (ValueError, TypeError):
        try:
            return max(0, email.utils.parsedate_to_datetime(value).timestamp() - time.time())
        except (ValueError, TypeError):
            return 60


class PhaseStopped(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "Redirect refused", headers, fp)


class Client:
    def __init__(self, out, token=None, opener=None):
        self.out, self.token = Path(out), token
        self.opener = opener or urllib.request.build_opener(NoRedirect()).open

    def request(self, path, payload=None, protected=False, key=None, allow_missing=False):
        # Persist successful response before phase aggregation. Identical retries
        # after a crash reuse this exact checkpoint, including mutation results.
        url = path if path.startswith('https://') else ORIGIN + path
        if not (url.startswith(ORIGIN + '/') or re.fullmatch(r'https://pub\.dev/api/packages/[a-z][a-z0-9_]{0,99}/score', url)):
            raise ValueError('Unsupported request destination')
        if protected and (not self.token or not url.startswith(ORIGIN + '/')):
            raise ValueError('Protected request requires canonical origin and token')
        identity = key or digest({'url': url, 'payload': payload})
        target = self.out / 'responses' / (identity + '.json')
        cached = read(target)
        if cached is not None:
            self.last_captured_at = cached['captured_at']
            return cached['body']
        cooldown = read(self.out / 'http-state.json', {})
        if cooldown.get('resume_after', 0) > time.time():
            raise PhaseStopped('HTTP cooldown active; resume after recorded deadline')
        headers = {'Accept': 'application/json'}
        if payload is not None:
            headers['Idempotency-Key'] = 'review-reconcile-' + identity[:48]
        if protected:
            headers['Authorization'] = 'Bearer ' + self.token
        body = None if payload is None else json.dumps(payload).encode()
        if body is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(url, data=body, headers=headers)
        if url.startswith('https://pub.dev/'):
            last = float(cooldown.get('last_pubdev_request', 0))
            remaining = 2.0 - (time.time() - last)
            if remaining > 0:
                time.sleep(remaining)
            cooldown['last_pubdev_request'] = time.time()
            save(self.out / 'http-state.json', cooldown)
        try:
            with self.opener(req, timeout=60) as response:
                result = json.loads(response.read(4_000_001))
        except urllib.error.HTTPError as exc:
            error_body = exc.read(20000).decode(errors='replace')
            exc.close()
            if exc.code == 404 and allow_missing:
                save(target, {'url': url, 'captured_at': now(), 'body': {}})
                return {}
            quota = bool(re.search(r'D1.*(?:daily|quota|row (?:read|write) limit)', error_body, re.I))
            delay = retry_seconds(exc.headers.get('Retry-After')) if exc.code == 429 else 0
            if quota:
                tomorrow = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)).replace(hour=0, minute=1, second=0, microsecond=0)
                delay = max(delay, tomorrow.timestamp() - time.time())
            state = {'status': exc.code, 'reason': 'D1 quota' if quota else 'HTTP failure', 'resume_after': time.time() + delay, 'at': now()}
            save(self.out / 'http-state.json', state)
            # Never persist/log request headers, tokens, or untrusted error bodies.
            raise PhaseStopped('D1 quota: entire phase stopped' if quota else f'HTTP {exc.code}: phase stopped; checkpoint retained') from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            raise PhaseStopped('Request failed or response uncertain; checkpoint retained') from None
        self.last_captured_at = now()
        save(target, {'url': url, 'captured_at': self.last_captured_at, 'body': result})
        return result


def load_manifest(path):
    path = Path(path).expanduser().resolve()
    manifest = read(path)
    if not isinstance(manifest, dict) or not isinstance(manifest.get('packages'), list):
        raise ValueError('Manifest must contain a packages array')
    seen = set(); entries = []
    for item in manifest['packages']:
        name = item.get('package_name', '')
        if not NAME.fullmatch(name) or name in seen:
            raise ValueError('Manifest contains invalid or duplicate package names')
        seen.add(name)
        def artifact(field, inline):
            if inline in item:
                return item[inline]
            value = item.get(field)
            if not value:
                return {}
            p = Path(value).expanduser()
            return read(p if p.is_absolute() else path.parent / p, {})
        entries.append({**item, 'record': artifact('review_path', 'record'), 'evidence': artifact('source_evidence_path', 'evidence')})
    return manifest, entries


def draft(out, name, reason):
    state = read(Path(out) / 'drafts.json', {})
    state[name] = {'reason': reason, 'at': now()}
    save(Path(out) / 'drafts.json', state)


def preview(entries, client, out):
    state = read(Path(out) / 'preview.json', {})
    for start in range(0, len(entries), 10):
        names = [e['package_name'] for e in entries[start:start + 10] if e['package_name'] not in state]
        if not names:
            continue
        response = client.request(ADMIN + 'policy/preview', {'packages': names}, protected=True)
        for package in response['packages']:
            state[package['package_name']] = {**package, 'catalog_product_commit': response.get('product_commit'), 'previewed_at': now()}
        save(Path(out) / 'preview.json', state)
    return state


def evidence_payload(entry, current, product_commit):
    evidence = entry['evidence']; metadata = evidence.get('metadata') or {}
    name = entry['package_name']; version = metadata.get('version')
    if not version:
        return None, 'Missing frozen metadata version'
    remote = current.get('metadata') or {}
    documentation = evidence.get('documentation') or ''
    if remote.get('version') and remote['version'] != version:
        return None, 'Cloudflare has a different version; retain draft'
    remote_doc_hash = current.get('documentation_sha256')
    if remote_doc_hash and remote_doc_hash not in (sha(''), sha(documentation)):
        return None, 'Cloudflare documentation differs; preserve existing same-version evidence and retain draft'
    observed = evidence.get('captured_at') or evidence.get('documentation_captured_at') or evidence.get('metadata_captured_at')
    if not observed:
        return None, 'Missing frozen evidence observation timestamp'
    sources = []
    for source in evidence.get('sources', []):
        if source.get('url', '').startswith('https://') and (source.get('sha256') or source.get('hash')):
            sources.append({'url': source['url'], 'sha256': source.get('sha256') or source['hash'], 'observed_at': source.get('observed_at') or source.get('captured_at') or observed, 'reason': source.get('reason') or 'Retained frozen review evidence'})
    if not sources:
        url = evidence.get('documentation_url') or f'https://pub.dev/packages/{name}/versions/{version}'
        sources = [{'url': url, 'sha256': sha(documentation) if documentation else digest(metadata), 'observed_at': observed, 'reason': 'Frozen normalized documentation' if documentation else 'Frozen normalized package metadata'}]
    normalized = {k: metadata.get(k) for k in ('name', 'version', 'published', 'description', 'topics', 'repository')}
    normalized.update(name=name, description=metadata.get('description') or '', topics=metadata.get('topics') or [], repository=metadata.get('repository') or None)
    return {'package_name': name, 'expected_evidence_hash': current.get('evidence_hash'), 'product_commit': product_commit, 'metadata': normalized, 'documentation': documentation, 'observed_at': observed, 'sources': sources[:20]}, None


def sync(entries, manifest, client, out, apply=False):
    previews = preview(entries, client, out)
    filename = 'sync-applied.json' if apply else 'sync-preview.json'
    state = read(Path(out) / filename, {})
    pending = []
    for entry in entries:
        name = entry['package_name']
        if name in state:
            continue
        current = previews[name]
        commit = manifest.get('product_commit') or entry['record'].get('product_commit')
        if current.get('catalog_product_commit') != commit:
            draft(out, name, 'Product commit differs from deployed catalog'); continue
        payload, reason = evidence_payload(entry, current, commit)
        if reason:
            draft(out, name, reason); continue
        pending.append(payload)
    for start in range(0, len(pending), 10):
        response = client.request(ADMIN + 'evidence/sync', {'packages': pending[start:start + 10], 'dry_run': not apply}, protected=True)
        for result in response['results']:
            name = result['package_name']; state[name] = result
            if result['status'] == 'conflict':
                draft(out, name, result.get('reason', 'Evidence conflict'))
        save(Path(out) / filename, state)
    return state


def import_reviews(entries, client, out, apply=False):
    synced = read(Path(out) / 'sync-applied.json', {})
    drafts = read(Path(out) / 'drafts.json', {})
    imported = read(Path(out) / 'imported.json', {})
    ready = {}
    for entry in entries:
        name = entry['package_name']; record = entry['record']; decision = record.get('decision', {})
        if name in imported:
            continue
        if name in drafts:
            continue
        if decision.get('relationship') == 'unknown' or decision.get('review_status') != 'reviewed' or decision.get('migration_status') == 'needs_review':
            draft(out, name, 'Unresolved decision remains draft'); continue
        binding = synced.get(name, {})
        if binding.get('status') not in ('synced', 'unchanged'):
            draft(out, name, 'No successfully synchronized evidence binding'); continue
        if record.get('product_commit') != binding.get('product_commit'):
            draft(out, name, 'Decision product commit differs from synchronized binding'); continue
        payload = {key: record.get(key) for key in FIELDS}
        payload.update(package_name=name, evidence_hash=binding['evidence_hash'], product_commit=binding['product_commit'])
        ready[name] = payload
        if apply:
            response = client.request(ADMIN + 'review/import', payload, protected=True)
            imported[name] = {'at': now(), 'evidence_hash': payload['evidence_hash'], 'product_commit': payload['product_commit'], 'result': response}
            save(Path(out) / 'imported.json', imported)
    save(Path(out) / 'import-ready.json', ready)
    return imported if apply else ready


def metric_pool(entries):
    relevant, unknown = [], []
    for entry in entries:
        decision = entry['record'].get('decision', {})
        relationship = decision.get('relationship', entry.get('relationship'))
        if relationship in ('direct', 'adjacent'):
            relevant.append(entry)
        elif relationship == 'unknown' and entry.get('metrics_selected', False):
            unknown.append(entry)
    return sorted(relevant, key=lambda e: e['package_name']) + sorted(unknown, key=lambda e: e['package_name'])[:100]


def capture_metrics(entries, client, out, cloudflare_only=False):
    state = read(Path(out) / 'metrics.json', {})
    for entry in metric_pool(entries):
        name = entry['package_name']
        if name in state:
            continue
        detail = client.request('/api/v1/competitors/' + name, allow_missing=True)
        package = detail.get('package', {})
        values = {k: package.get(k) for k in METRICS}
        observation = {'package_name': name, 'metrics': values, 'observed_at': package.get('metrics_captured_at'), 'captured_at': now(), 'source': ORIGIN + '/api/v1/competitors/' + name}
        missing = [k for k, value in values.items() if value is None]
        local = entry.get('metrics') or entry.get('evidence', {}).get('metrics') or entry.get('record', {}).get('metrics') or {}
        local_observed = entry.get('metrics_observed_at') or entry.get('evidence', {}).get('metrics_captured_at') or entry.get('record', {}).get('metrics_captured_at')
        local_used = {}
        for key in list(missing):
            value = local.get(key)
            if value is not None:
                values[key] = value; missing.remove(key); local_used[key] = value
        if local_used:
            observation['local_reuse'] = {'metrics': local_used, 'observed_at': local_observed, 'source': 'matching frozen review snapshot'}
        if missing and not cloudflare_only:
            reason = 'Cloudflare and matching local snapshot had no value for: ' + ', '.join(missing)
            observation['upstream_reason'] = reason
            source = f'https://pub.dev/api/packages/{name}/score'
            score = client.request(source)
            mapped = {'downloads_30d': score.get('downloadCount30Days'), 'likes': score.get('likeCount'), 'points': score.get('grantedPoints'), 'max_points': score.get('maxPoints')}
            observation['supplement'] = {'source': source, 'observed_at': client.last_captured_at, 'metrics': {k: mapped[k] for k in missing}}
            for k in missing:
                values[k] = mapped[k]
        observation['missing'] = [k for k, value in values.items() if value is None]
        state[name] = observation
        save(Path(out) / 'metrics.json', state)
    return state


def report(entries, out):
    out = Path(out); metrics = read(out / 'metrics.json', {})
    pool = metric_pool(entries); eligible = {e['package_name'] for e in pool}
    covered = {n: m for n, m in metrics.items() if n in eligible}
    summary = {'packages': len(entries), 'metrics_eligible': len(eligible), 'metrics_observed': len(covered), 'metrics_complete': sum(not m.get('missing') for m in covered.values()), 'metrics_missing_packages': len(eligible - covered.keys()), 'drafts': len(read(out / 'drafts.json', {})), 'synced': len(read(out / 'sync-applied.json', {})), 'imported': len(read(out / 'imported.json', {})), 'metrics_field_coverage': {k: sum(m['metrics'].get(k) is not None for m in covered.values()) for k in METRICS}}
    save(out / 'summary.json', summary)
    lines = ['# Competitor review reconciliation', '', 'Frozen evidence and local metrics observations; counts do not represent users, traffic, or market share.', '', '```json', json.dumps(summary, indent=2), '```', '', '| Package | Downloads 30d | Likes | Points | Source / observation |', '|---|---:|---:|---:|---|']
    for name, value in sorted(covered.items()):
        m = value['metrics']; supplement = value.get('supplement')
        source = f"[Cloudflare]({value['source']}) {value.get('observed_at') or 'timestamp unavailable'}"
        if supplement:
            source += f"; [pub.dev score]({supplement['source']}) {supplement['observed_at']}"
        lines.append(f"| [{name}](https://pub.dev/packages/{name}) | {m.get('downloads_30d')} | {m.get('likes')} | {m.get('points')}/{m.get('max_points')} | {source} |")
    lines += ['', '## Drafts', '']
    for name, value in sorted(read(out / 'drafts.json', {}).items()):
        lines.append(f"- [{name}](https://pub.dev/packages/{name}): {value['reason']}")
    (out / 'reconciliation-report.md').write_text('\n'.join(lines) + '\n')
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', nargs='?', default='preview', choices=['preview', 'sync', 'import', 'metrics', 'report'])
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--secrets-file')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--limit', type=int, help='Process only the first N packages in deterministic manifest order')
    parser.add_argument('--packages', nargs='*', help='Restrict to these exact package names')
    parser.add_argument('--cloudflare-only', action='store_true', help='Do not request pub.dev score when metrics are absent from Cloudflare/local evidence')
    args = parser.parse_args(); out = outside_repo(args.output)
    manifest, entries = load_manifest(args.manifest)
    binding = {'manifest_sha256': sha(Path(args.manifest).expanduser().read_text()), 'resolved_evidence_sha256': digest(entries)}
    if args.packages is not None:
        selected = set(args.packages)
        unknown = selected - {e['package_name'] for e in entries}
        if unknown: raise ValueError('Requested package is absent from manifest: ' + ', '.join(sorted(unknown)))
        entries = [e for e in entries if e['package_name'] in selected]
    if args.limit is not None:
        if args.limit < 1: raise ValueError('--limit must be positive')
        entries = entries[:args.limit]
    out.mkdir(parents=True, exist_ok=True)
    lock = (out / 'phase.lock').open('a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        raise ValueError('Another phase is running for this output directory') from None
    previous = read(out / 'manifest-binding.json')
    if previous and previous != binding:
        raise ValueError('Manifest or referenced evidence changed; use a new output directory')
    save(out / 'manifest-binding.json', binding)
    token = token_from(args.secrets_file) if args.command in ('preview', 'sync', 'import') else None
    client = Client(out, token)
    if args.command == 'preview': result = preview(entries, client, out)
    elif args.command == 'sync': result = sync(entries, manifest, client, out, args.apply)
    elif args.command == 'import': result = import_reviews(entries, client, out, args.apply)
    elif args.command == 'metrics': result = capture_metrics(entries, client, out, args.cloudflare_only)
    else: result = report(entries, out)
    lock.close()
    print(json.dumps({'command': args.command, 'records': len(result), 'output': str(out)}))


if __name__ == '__main__':
    try:
        main()
    except (PhaseStopped, ValueError) as error:
        print(str(error), file=__import__('sys').stderr)
        raise SystemExit(1)
