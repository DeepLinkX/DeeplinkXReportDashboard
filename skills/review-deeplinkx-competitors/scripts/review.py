#!/usr/bin/env python3
"""Checkpointed, read-only Cloudflare evidence collection and local competitor review.

No production writes or model calls. Python 3.10+ standard library only.
"""
import sys
if len(sys.argv) > 1 and sys.argv[1] == 'remote':
    from remote import main as remote_main
    remote_main(sys.argv[2:])
    raise SystemExit(0)

import argparse
import collections
import fcntl
import datetime as dt
import email.utils
import hashlib
import html
import http.client as http_client
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

ORIGIN = "https://deeplinkx-visibility.parham-dev.workers.dev"
SCOPE = "external-app-actions-v1"
SEMANTIC_MAPPING_POLICY_VERSION = "external-app-mapping-v2"
NAME = re.compile(r"^[a-z][a-z0-9_]{0,99}$")
REL = {"direct", "adjacent", "noise", "unknown"}
MIG = {"supported", "partial", "unsupported", "needs_review"}
MAX_BYTES = 2_000_000


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def read(p, default=None):
    return json.loads(Path(p).read_text()) if Path(p).exists() else default


def save(p, value):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp_name = None
    try:
        with tempfile.NamedTemporaryFile("w", dir=p.parent, prefix=p.name + ".", suffix=".tmp", delete=False) as tmp:
            tmp.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
            tmp_name = tmp.name
        os.replace(tmp_name, p)
    finally:
        if tmp_name:
            Path(tmp_name).unlink(missing_ok=True)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def names_sql(names):
    if not names or any(not NAME.fullmatch(n) for n in names):
        raise ValueError("Invalid package selection")
    return ",".join("'" + n + "'" for n in sorted(set(names)))


def chunks(values, size=200):
    for i in range(0, len(values), size):
        yield values[i:i + size]


def outside_repo(path):
    p = Path(path).expanduser().resolve()
    if any((a / ".git").exists() for a in [p, *p.parents]):
        raise ValueError("Generated evidence and reviews must be outside a Git checkout")
    return p


def d1(repo, sql, database="deeplinkx-visibility"):
    # Only internal SELECT templates reach this function, never package content.
    if any(not s.strip().upper().startswith("SELECT ") for s in sql.split(";") if s.strip()):
        raise ValueError("Only SELECT statements are permitted")
    env = {**os.environ, "WRANGLER_LOG_PATH": str(Path(os.environ.get("TMPDIR", "/tmp")) / "deeplinkx-review-wrangler.log")}
    r = subprocess.run(["npx", "--no-install", "wrangler", "d1", "execute", database, "--remote", "--json", "--command", sql], cwd=repo, capture_output=True, text=True, env=env, timeout=120)
    if r.returncode:
        raise RuntimeError("D1 read failed; retain the gap and retry later. " + r.stderr[-500:])
    data = json.loads(r.stdout)
    if any(not x.get("success") for x in data):
        raise RuntimeError("D1 returned a failed query")
    return data


def d1_sqlite(database, sql):
    """Run the helper's fixed SELECT templates against a frozen local snapshot."""
    path = Path(database).expanduser().resolve()
    if not path.is_file():
        raise ValueError("--sqlite-db must name an existing frozen SQLite snapshot")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    try:
        output = []
        for statement in (part.strip() for part in sql.split(";") if part.strip()):
            if not statement.upper().startswith("SELECT "):
                raise ValueError("Local snapshot access is read-only")
            cursor = connection.execute(statement)
            output.append({"results": [dict(row) for row in cursor.fetchall()], "meta": {"rows_read": None}})
        return output
    finally:
        connection.close()


def log(out, event):
    p = Path(out) / "requests.jsonl"
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("a") as f:
        f.write(json.dumps({"at": now(), **event}) + "\n")


def retry_seconds(value, clock=time.time):
    try:
        return max(0, float(value))
    except (ValueError, TypeError):
        try:
            return max(0, email.utils.parsedate_to_datetime(value).timestamp() - clock())
        except (ValueError, TypeError):
            return 60


def _http_unlocked(url, out, reason="", upstream=False, cloudflare_only=False, upstream_spacing=2):
    u = urllib.parse.urlparse(url)
    if u.scheme != "https" or u.netloc not in {urllib.parse.urlparse(ORIGIN).netloc, "pub.dev"}:
        raise ValueError("Only the canonical dashboard and pub.dev HTTPS resources are supported")
    if upstream and (cloudflare_only or not reason.strip()):
        raise ValueError("Upstream disabled or missing a specific evidence-gap reason")
    state = Path(out) / "http-state.json"
    gate = read(state, {})
    delay = gate.get("resume_after", 0) - time.time()
    if delay > 60:
        raise RuntimeError(f"Checkpointed cooldown; resume after {gate['resume_after']}")
    if delay > 0:
        time.sleep(delay)
    if upstream:
        spacing = gate.get("last_upstream", 0) + max(0, upstream_spacing) - time.time()
        if spacing > 0:
            time.sleep(spacing)
    request = urllib.request.Request(url, headers={"User-Agent": "deeplinkx-competitor-review/1.0", "Accept": "application/json,text/html"})
    try:
        with urllib.request.urlopen(request, timeout=35) as r:
            final = urllib.parse.urlparse(r.url)
            if final.scheme != "https" or final.netloc != u.netloc:
                raise ValueError("Unexpected cross-origin redirect")
            body = r.read(MAX_BYTES + 1)
            if len(body) > MAX_BYTES:
                raise ValueError("Evidence resource exceeds 2 MB; use a targeted source")
            log(out, {"url": url, "origin": "pub.dev" if upstream else "cloudflare", "reason": reason, "status": r.status, "bytes": len(body)})
            save(state, {"last_upstream": time.time() if upstream else gate.get("last_upstream", 0)})
            return body.decode("utf-8")
    except urllib.error.HTTPError as e:
        log(out, {"url": url, "origin": "pub.dev" if upstream else "cloudflare", "reason": reason, "status": e.code})
        if e.code == 429 or e.code >= 500:
            save(state, {"last_upstream": time.time(), "resume_after": time.time() + max(60, retry_seconds(e.headers.get("Retry-After")))})
        raise RuntimeError(f"HTTP {e.code}; checkpoint retained, no hidden retry loop") from None


def http(url, out, reason="", upstream=False, cloudflare_only=False, upstream_spacing=2):
    if not upstream:
        return _http_unlocked(url, out, reason, upstream, cloudflare_only, upstream_spacing)
    lock_path = Path(out) / "upstream.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _http_unlocked(url, out, reason, upstream, cloudflare_only, upstream_spacing)


class PubDevSession:
    """Sequential pub.dev client that reuses one TLS connection."""
    def __init__(self, out, spacing=0.25):
        self.out = Path(out)
        self.spacing = max(0, spacing)
        self.connection = None

    def close(self):
        if self.connection:
            self.connection.close()
            self.connection = None

    def get(self, url, reason):
        lock_path = self.out / "upstream.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            return self._get_unlocked(url, reason)

    def _get_unlocked(self, url, reason):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.netloc != "pub.dev" or not reason.strip():
            raise ValueError("Pooled requests require a justified canonical pub.dev HTTPS URL")
        state_path = self.out / "http-state.json"
        gate = read(state_path, {})
        delay = gate.get("resume_after", 0) - time.time()
        if delay > 60:
            raise RuntimeError(f"Checkpointed cooldown; resume after {gate['resume_after']}")
        if delay > 0:
            time.sleep(delay)
        spacing = gate.get("last_upstream", 0) + self.spacing - time.time()
        if spacing > 0:
            time.sleep(spacing)
        path = parsed.path + (("?" + parsed.query) if parsed.query else "")
        for attempt in range(2):
            try:
                if not self.connection:
                    self.connection = http_client.HTTPSConnection("pub.dev", timeout=35)
                self.connection.request("GET", path, headers={"User-Agent": "deeplinkx-competitor-review/1.1", "Accept": "application/json,text/html", "Connection": "keep-alive"})
                response = self.connection.getresponse()
                body = response.read(MAX_BYTES + 1)
                status = response.status
                headers = response.headers
                break
            except (OSError, http_client.HTTPException):
                self.close()
                if attempt:
                    raise RuntimeError("pub.dev connection failed; checkpoint retained") from None
        log(self.out, {"url": url, "origin": "pub.dev", "reason": reason, "status": status, "bytes": len(body)})
        save(state_path, {"last_upstream": time.time()})
        if len(body) > MAX_BYTES:
            raise ValueError("Evidence resource exceeds 2 MB; use a targeted source")
        if status != 200:
            if status == 429 or status >= 500:
                save(state_path, {"last_upstream": time.time(), "resume_after": time.time() + max(60, retry_seconds(headers.get("Retry-After")))})
            raise RuntimeError(f"HTTP {status}; checkpoint retained, no hidden retry loop")
        return body.decode("utf-8")


def observed_behavior(packet):
    metadata = packet.get("metadata") or {}
    result = {k: metadata[k] for k in ("version", "description", "topics", "repository") if metadata.get(k) not in (None, "", [])}
    version = packet.get("published_version")
    if version:
        result.setdefault("version", version)
    if packet.get("documentation") and not packet.get("documentation_truncated"):
        result["documentation"] = digest(" ".join(packet["documentation"].split()))
    sources = {x["url"]: x["hash"] for x in packet.get("sources", []) if x.get("kind") != "metrics" and x.get("url") and x.get("hash")}
    if sources:
        result["additional_sources"] = sources
    return result


def confirmed_noise(previous):
    return bool(previous and previous.get("scope") == SCOPE and previous.get("decision", {}).get("relationship") == "noise" and previous.get("decision", {}).get("review_status") == "reviewed" and previous.get("decision_origin") not in {"screen_noise", "screened", "evidence_gap"})


def noise_reusable(packet, ledger, override=False):
    previous = ledger.get(packet["package_name"])
    if override or packet.get("force_review") or not confirmed_noise(previous):
        return False
    # Compare only observations already available. A thin/missing snapshot does
    # not invalidate a prior review or justify fetching evidence to check it.
    prior = previous.get("behavior_evidence", {})
    if not prior and previous.get("evidence_path"):
        prior = observed_behavior(read(previous["evidence_path"], {}))
    # Only already-observed, concrete external-app claims may reopen exclusion.
    # Version numbers, scores, source hashes and timestamps do not prove behavior.
    old = read(previous.get("evidence_path"), {}) if previous.get("evidence_path") else {}
    before = str(prior.get("description", "")) + " " + str(old.get("documentation", ""))
    after = str(packet.get("metadata", {}).get("description", "")) + " " + str(packet.get("documentation", ""))
    pattern = re.compile(r"\b(?:launch|open|share|send|construct|build|check)\b[^.!?\n]{0,100}\b(?:external\s+apps?|whatsapp|telegram|tiktok|installed\s+apps?|app\s+store|play\s+store|url\s+schemes?)\b", re.I)
    for sentence in re.split(r"[.!?\n]", after):
        if pattern.search(sentence) and sentence.strip() not in before and not re.search(r"lockfile|info\.plist|inspiration|share\s+(?:this\s+)?(?:repository|project)", sentence, re.I):
            return False
    return True


def policy_filter(out, rows, ledger, override=False):
    summary = read(Path(out) / "reuse-summary.json", {})
    active = []
    for row in rows:
        local = read(Path(out) / "evidence" / (row["package_name"] + ".json"), {})
        observed = {**local, **row}
        if noise_reusable(observed, ledger, override):
            old = ledger[row["package_name"]]
            summary[row["package_name"]] = {"lane": "reuse", "reason": "Confirmed noise; no observed material behavior or scope change", "reviewed_at": old.get("reviewed_at"), "finding": old.get("finding"), "decision": old["decision"]}
        else:
            summary.pop(row["package_name"], None)
            active.append(row)
    save(Path(out) / "reuse-summary.json", summary)
    return active


def collect(args):
    out = outside_repo(args.output)
    target = out / "candidates.json"
    if target.exists():
        return {"reused": str(target)}
    ledger = read(args.ledger, {}) if args.ledger else {}
    excluded = [name for name, old in ledger.items() if noise_reusable(read(out / "evidence" / (name + ".json"), {"package_name": name}), ledger, getattr(args, "reopen_noise", False) or getattr(args, "controls", 0) > 0)]
    policy_filter(out, [{"package_name": name} for name in excluded], ledger)
    exclusion = "package_name NOT IN (" + names_sql(excluded) + ")" if excluded else "1=1"
    if args.d1 or args.sqlite_db:
        if args.all:
            pool = "SELECT package_name,relationship,downloads_30d,evidence_hash,json_extract(analysis_json,'$.review_status') AS review_status,json_extract(analysis_json,'$.expansion') AS expansion FROM competitor_registry WHERE " + exclusion + " ORDER BY package_name"
        else:
            pool = "SELECT package_name,relationship,downloads_30d,evidence_hash,json_extract(analysis_json,'$.review_status') AS review_status,json_extract(analysis_json,'$.expansion') AS expansion FROM competitor_registry WHERE " + exclusion + " AND evidence_hash!='' ORDER BY downloads_30d IS NULL,downloads_30d DESC,package_name LIMIT 250"
        sql = "SELECT COUNT(*) AS registered,SUM(evidence_hash!='') AS classified,SUM(relationship='unknown') AS unknown,SUM(refresh_status='partial') AS partial FROM competitor_registry; SELECT status,COUNT(*) AS count FROM intelligence_jobs GROUP BY status; " + pool + ";"
        rows = d1(args.dashboard_repo, sql) if args.d1 else d1_sqlite(args.sqlite_db, sql)
        pool_rows = rows[2]["results"]
        if args.all:
            candidates = [p for p in pool_rows if p.get("evidence_hash")]
            pending = [p for p in pool_rows if not p.get("evidence_hash")]
        else:
            candidates = pool_rows
            pending_query = "SELECT package_name FROM competitor_registry WHERE " + exclusion + " AND evidence_hash='' ORDER BY package_name LIMIT 20"
            pending = (d1(args.dashboard_repo, pending_query) if args.d1 else d1_sqlite(args.sqlite_db, pending_query))[0]["results"]
        source = "cloudflare_d1" if args.d1 else "local_sqlite_snapshot"
        rows_read = sum(x["meta"]["rows_read"] for x in rows) if args.d1 else None
        data = {"captured_at": now(), "coverage": rows[0]["results"][0], "jobs": rows[1]["results"], "candidates": candidates, "pending": pending, "source": source, "mode": "all" if args.all else "pilot", "rows_read": rows_read}
        log(out, {"origin": source, "operation": ("full registry" if args.all else "bounded") + " candidate collection", "rows_read": rows_read, "packages_returned": len(candidates) + len(pending)})
    else:
        pools = {}
        data = {"captured_at": now(), "source": "cloudflare_public_api", "pending": []}
        queries = ["view=direct&sort=downloads", "view=unresolved&sort=downloads", "view=unresolved&sort=published", "view=adjacent&sort=downloads", "view=expansion&sort=downloads"]
        if getattr(args, "reopen_noise", False) or getattr(args, "controls", 0) > 0:
            queries.append("view=noise&sort=downloads")
        for query in queries:
            r = json.loads(http(ORIGIN + "/api/v1/competitors?" + query + "&order=desc&limit=100", out))
            data["coverage"] = r["coverage"]
            for p in r["competitors"]:
                pools[p["package_name"]] = p
        data["candidates"] = [p for p in pools.values() if p.get("evidence_hash")]
        data["pending"] = [p for p in pools.values() if not p.get("evidence_hash")]
    data["candidates"] = policy_filter(out, data["candidates"], ledger, getattr(args, "reopen_noise", False) or getattr(args, "controls", 0) > 0)
    data["pending"] = policy_filter(out, data["pending"], ledger, getattr(args, "reopen_noise", False) or getattr(args, "controls", 0) > 0)
    save(target, data)
    return {"candidate_count": len(data["candidates"]), "coverage": data["coverage"], "path": str(target)}


def selection(data, all_packages=False, exclude=None):
    exclude = set(exclude or [])
    if all_packages:
        combined = {p["package_name"]: p for p in [*data["candidates"], *data["pending"]]}
        chosen = []
        for name in sorted(combined):
            if name in exclude:
                continue
            p = combined[name]
            if p.get("evidence_hash"):
                group = "registry_" + (p.get("relationship") or "unknown")
            else:
                group = "awaiting_enrichment"
            chosen.append({"package_name": name, "group": group})
        return chosen
    rows = sorted([p for p in data["candidates"] if p["package_name"] not in exclude], key=lambda p: (p.get("downloads_30d") is None, -(p.get("downloads_30d") or 0), p["package_name"]))
    seen, selected, shortages = set(), [], []
    predicates = [("direct", 10, lambda p: p["relationship"] == "direct"), ("unresolved", 10, lambda p: p["relationship"] == "unknown" or p.get("review_status") == "needs_review"), ("adjacent_expansion", 10, lambda p: p["relationship"] == "adjacent" or p.get("expansion"))]
    for group, count, pred in predicates:
        choices = [p for p in rows if p["package_name"] not in seen and pred(p)][:count]
        for p in choices:
            selected.append({"package_name": p["package_name"], "group": group})
            seen.add(p["package_name"])
        shortages += [group] * (count - len(choices))
    for p in sorted([p for p in data["pending"] if p["package_name"] not in exclude], key=lambda p: p["package_name"])[:5]:
        if p["package_name"] not in seen:
            selected.append({"package_name": p["package_name"], "group": "awaiting_enrichment"})
            seen.add(p["package_name"])
    # Substitute from the next available group, preserving the selection explanation.
    available = [p for p in rows if p["package_name"] not in seen and p["relationship"] != "noise"]
    for p in available[:40 - len(selected)]:
        selected.append({"package_name": p["package_name"], "group": "substitution", "substitution": "Insufficient " + (shortages.pop(0) if shortages else "pending") + " candidates; selected another relevant candidate"})
    return selected


def row_packet(row, group, catalog):
    metadata = json.loads(row.get("metadata_json") or "{}")
    score = json.loads(row.get("score_json") or "{}")
    analysis = json.loads(row.get("analysis_json") or "{}")
    name = row["package_name"]
    version = metadata.get("version")
    documentation = row.get("documentation_text") or ""
    if row.get("documentation_version") != version:
        documentation = ""
    return {"package_name": name, "group": group, "metadata": metadata, "metrics": score, "original": analysis,
            "evidence_hash": row.get("evidence_hash", ""), "product_commit": row.get("product_commit") or catalog["source_commit"],
            "classifier_version": row.get("classifier_version"), "documentation": documentation,
            "documentation_url": f"https://pub.dev/packages/{name}/versions/{version}" if version else None,
            "metadata_captured_at": row.get("metadata_captured_at"), "metrics_captured_at": row.get("metrics_captured_at"),
            "documentation_captured_at": row.get("documentation_captured_at"), "source_origin": "cloudflare_registry",
            "errors": {k: row.get(k) for k in ["metadata_error", "metrics_error", "documentation_error"]}, "sources": [], "discoveries": []}


def fingerprint(packet):
    m = packet.get("metadata", {})
    return digest({"scope": SCOPE, "metadata": {k: m.get(k) for k in ["name", "version", "description", "topics", "repository"]}, "documentation": " ".join(packet.get("documentation", "").split()), "additional_sources": [{"url": s["url"], "hash": s.get("hash")} for s in packet.get("sources", []) if s.get("kind") != "metrics"]})


def lane(packet, ledger):
    if packet.get("force_review"):
        return "review", "Explicit review override"
    if noise_reusable(packet, ledger):
        return "reuse", "Confirmed noise; no observed material behavior or scope change"
    if confirmed_noise(ledger.get(packet["package_name"])):
        return "review", "Already observed behavior or version change reopens confirmed noise"
    if packet.get("cloudflare_review") and not packet.get("binding_invalidated"):
        review = packet["cloudflare_review"]
        if review.get("evidence_hash") == packet.get("evidence_hash") and review.get("product_commit") == packet.get("product_commit") and review.get("decision", {}).get("relationship") != "unknown":
            if review["decision"]["relationship"] != "noise" and review.get("semantic_mapping_policy_version") != SEMANTIC_MAPPING_POLICY_VERSION:
                return "comparison_only", "Stored review needs current semantic mapping policy"
            return "reuse_cloudflare", "Existing review matches database evidence and product commit"
    prev = ledger.get(packet["package_name"])
    if prev and prev.get("scope") == SCOPE and prev.get("fingerprint") == fingerprint(packet):
        if prev["decision"]["relationship"] == "unknown":
            return "wait_for_evidence", "Prior review remains unresolved; do not repeat unchanged semantic work"
        if prev["decision"]["relationship"] != "noise" and prev.get("semantic_mapping_policy_version") != SEMANTIC_MAPPING_POLICY_VERSION:
            return "comparison_only", "Semantic mapping policy changed; revisit relevant mappings"
        if prev["decision"]["relationship"] == "noise" or prev.get("product_commit") == packet.get("product_commit"):
            return "reuse", "Unchanged reviewed evidence"
        return "comparison_only", "Product changed; recheck affected migration claims"
    noise_reason = screen_noise_reason(packet)
    if noise_reason:
        return "screen_noise", noise_reason
    if not packet.get("metadata"):
        return "evidence_gap", "No usable Cloudflare metadata"
    return "review", "New, changed, mixed, or unresolved evidence"


def screen_noise_reason(packet):
    metadata = packet.get("metadata", {})
    text = " ".join([metadata.get("description", ""), " ".join(metadata.get("topics", []))]).lower()
    relevant = re.search(r"(?:deep\s?links?|url schemes?|external apps?|launch(?:es|ing)?\b|open(?:s|ing)? (?:another |external )?app|share(?:s|ing)?\b|intent\b|app store|play store|store redirect|whatsapp|telegram|instagram|facebook|twitter|linkedin|youtube|spotify|waze|uber|mailto|sms\b|phone call|directions|navigation)", text)
    unrelated = re.search(r"(?:draggable menus?|icon (?:pack|set)|map snapshots?|map previews?|embedded map|maps? widgets?|place picker|splash screen generator|authentication|login via|state management|database|object relational mapper|serialization|code generator|lint rules?|testing utilities|mocking|chart(?:s|ing)?\b|fonts?\b|themes?\b|animations?\b|image picker|camera plugin|bluetooth|sensors?\b|audio player|video player|http client|logging package|analytics sdk|geocoding api|places api|route service|payment gateway api)", text)
    if unrelated and not relevant:
        return "Affirmative unrelated-purpose signal: " + unrelated.group(0) + "; provisional script screening, not a manual decision"
    return None


def snippets(text, limit=4000):
    lines = text.splitlines()
    # Preserve the opening purpose and contiguous context near executable behavior.
    selected = set(range(min(8, len(lines))))
    for i, line in enumerate(lines):
        if re.search(r"(?:launch|share|send|open|intent|directions|profile|phone|Uri|URL|handle|receive|parse|fallback|installed)", line, re.I):
            selected.update(range(max(0, i - 1), min(len(lines), i + 3)))
    output = []
    length = 0
    for i in sorted(selected):
        part = f"L{i + 1}: {lines[i]}"
        if length + len(part) + 1 > limit:
            break
        output.append(part)
        length += len(part) + 1
    return "\n".join(output)


def prepare(args):
    out = outside_repo(args.output)
    selected = read(out / "selection.json")
    catalog = read(args.catalog)
    product = {"source_commit": catalog["source_commit"], "catalog_version": catalog.get("catalog_version", catalog.get("version")), "capabilities": catalog["capabilities"]}
    previous = read(out / "product-catalog.json", {})
    if previous.get("source_commit") == product["source_commit"]:
        product["verified_shared_apis"] = previous.get("verified_shared_apis", [])
    if args.product_repo:
        commit = catalog["source_commit"]
        source = "lib/src/core/deeplink_x.dart"
        def committed(path):
            return subprocess.check_output(["git", "-C", args.product_repo, "show", commit + ":" + path], text=True)
        body = committed(source)
        if "export 'src/src.dart'" not in committed("lib/deeplink_x.dart") or "core/core.dart" not in committed("lib/src/src.dart") or "deeplink_x.dart" not in committed("lib/src/core/core.dart"):
            raise ValueError("Shared API export chain changed; verify public visibility before mapping it")
        product["verified_shared_apis"] = [{"api": "DeeplinkX." + name, "source": source, "source_sha256": hashlib.sha256(body.encode()).hexdigest(), "verified_commit": commit} for name in ["launchApp", "launchAction", "isAppInstalled"] if re.search(r"Future<[^>]+>\s+" + name + r"\s*\(", body)]
        save(out / "sources" / "product-shared-api.json", {"commit": commit, "source": source, "body": body})
    save(out / "product-catalog.json", product)
    ledger = read(args.ledger, {}) if args.ledger else {}
    active = policy_filter(out, [read(out / "evidence" / (p["package_name"] + ".json"), p) for p in selected], ledger, getattr(args, "reopen_noise", False) or getattr(args, "controls", 0) > 0)
    active_names = {p["package_name"] for p in active}
    selected = [p for p in selected if p["package_name"] in active_names]
    save(out / "selection.json", selected)
    pending = [p for p in selected if not (out / "evidence" / (p["package_name"] + ".json")).exists()]
    if args.registry_file:
        rows = read(args.registry_file)[0]["results"]
    elif (args.d1 or args.sqlite_db) and pending:
        rows, reviews = [], []
        for group in chunks([p["package_name"] for p in pending]):
            selected_names = names_sql(group)
            sql = "SELECT * FROM competitor_registry WHERE package_name IN (" + selected_names + "); SELECT * FROM competitor_reviews WHERE package_name IN (" + selected_names + ")"
            result = d1(args.dashboard_repo, sql) if args.d1 else d1_sqlite(args.sqlite_db, sql)
            rows.extend(result[0]["results"])
            reviews.extend(result[1]["results"])
        save(out / "cloudflare-reviews.json", reviews)
        log(out, {"origin": "local_sqlite_snapshot" if args.sqlite_db else "cloudflare_d1", "operation": "selected full registry evidence", "packages": len(rows), "chunks": (len(pending) + 199) // 200, "rows_read": None if args.sqlite_db else "reported by Wrangler"})
    else:
        rows = []
    by_name = {p["package_name"]: p for p in rows}
    for item in pending:
        n = item["package_name"]
        if n in by_name:
            packet = row_packet(by_name[n], item["group"], catalog)
        else:
            if args.sqlite_db:
                packet = {"package_name": n, "group": item["group"], "metadata": {"name": n}, "metrics": {},
                          "original": {"relationship": "unknown", "rationale": "No package row in the frozen snapshot."},
                          "evidence_hash": "", "product_commit": catalog["source_commit"], "documentation": "",
                          "documentation_url": None, "source_origin": "local_sqlite_snapshot", "sources": [],
                          "evidence_gap": "Package evidence is absent from the frozen snapshot."}
                packet["captured_at"] = now()
                save(out / "evidence" / (n + ".json"), packet)
                continue
            detail = json.loads(http(ORIGIN + "/api/v1/competitors/" + n, out))
            p = detail["package"]
            packet = {"package_name": n, "group": item["group"], "metadata": {"name": n, "version": p.get("published_version"), "published": p.get("published_at"), "description": p.get("description"), "topics": p.get("topics", [])}, "metrics": {k: p.get(k) for k in ["downloads_30d", "likes", "points", "max_points", "platforms"]}, "original": {k: p.get(k) for k in ["relationship", "review_status", "capabilities", "rationale", "migration_status", "expansion"]}, "evidence_hash": p.get("evidence_hash", ""), "product_commit": p.get("product_commit") or catalog["source_commit"], "documentation": detail.get("documentation_excerpt", ""), "documentation_url": f"https://pub.dev/packages/{n}/versions/{p.get('published_version')}", "documentation_truncated": len(detail.get("documentation_excerpt", "")) >= 6000, "source_origin": "cloudflare_public_api", "sources": [], "discoveries": detail.get("discoveries", [])[:3], **{k: p.get(k) for k in ["metadata_captured_at", "metrics_captured_at", "documentation_captured_at"]}}
        packet["captured_at"] = now()
        if getattr(args, "reopen_noise", False):
            packet["force_review"] = True
        for review in read(out / "cloudflare-reviews.json", []):
            if review["package_name"] == n and review["evidence_hash"] == packet["evidence_hash"] and review["product_commit"] == packet["product_commit"]:
                packet["cloudflare_review"] = {**review, "decision": json.loads(review["decision_json"])}
        save(out / "evidence" / (n + ".json"), packet)
    if getattr(args, "reopen_noise", False):
        for item in selected:
            path = out / "evidence" / (item["package_name"] + ".json")
            packet = read(path)
            packet["force_review"] = True
            save(path, packet)
    return packet_batches(out, args.ledger, getattr(args, "controls", 0))


def packet_batches(out, ledger_path, controls=0):
    ledger = read(ledger_path, {}) if ledger_path else {}
    selected = read(out / "selection.json")
    catalog = read(out / "product-catalog.json")
    packets = []
    reusable_noise = [s["package_name"] for s in selected if ledger.get(s["package_name"], {}).get("decision", {}).get("relationship") == "noise"]
    control_names = sorted(reusable_noise, key=lambda n: digest([out.name, n]))[:max(0, controls)]
    save(out / "control-selection.json", control_names)
    for s in selected:
        p = read(out / "evidence" / (s["package_name"] + ".json"))
        l, reason = lane(p, ledger)
        if p["package_name"] in control_names and l == "reuse":
            l, reason = "noise_control_review", "Deterministic spot check of a reusable noise decision"
        p["fingerprint"] = fingerprint(p)
        save(out / "evidence" / (p["package_name"] + ".json"), p)
        if noise_reusable(p, ledger) and p["package_name"] not in control_names:
            policy_filter(out, [p], ledger)
            continue
        packets.append({"package_name": p["package_name"], "lane": l, "lane_reason": reason, "metadata": p["metadata"], "original": p["original"], "fingerprint": p["fingerprint"], "documentation": "" if l.startswith("reuse") or l == "wait_for_evidence" else snippets(p.get("documentation", "")), "documentation_url": p.get("documentation_url"), "documentation_total_chars": len(p.get("documentation", "")), "sources": [{k: x.get(k) for k in ["url", "kind", "hash", "origin"]} for x in p.get("sources", [])]})
    for stale in (out / "packets").glob("batch-*.json"):
        stale.unlink()
    width = max(2, len(str((len(packets) + 4) // 5)))
    for i in range(0, len(packets), 5):
        save(out / "packets" / f"batch-{i // 5 + 1:0{width}d}.json", {"scope": SCOPE, "product_commit": catalog["source_commit"], "product_inventory": "../product-catalog.json", "packages": packets[i:i + 5]})
    return {"packets": len(packets), "batches": (len(packets) + 4) // 5, "lanes": dict(collections.Counter(p["lane"] for p in packets)), "documentation_chars": sum(len(p["documentation"]) for p in packets)}


def local_resource(out, package, kind, version=None):
    filename = package + "." + kind + ".json"
    candidates = [out / "sources" / filename]
    candidates.extend(sorted((p / "sources" / filename for p in out.parent.iterdir() if p.is_dir() and p != out), reverse=True))
    expected = f"https://pub.dev/api/packages/{package}" if kind == "metadata" else f"https://pub.dev/packages/{package}/versions/{version}"
    for path in candidates:
        cached = read(path)
        if cached and cached.get("url") == expected and cached.get("body"):
            return cached
    return None


def apply_resource(out, packet, kind, cached, reason):
    if kind == "metadata":
        obj = json.loads(cached["body"])
        if obj.get("name") != packet["package_name"] or not obj.get("latest", {}).get("version"):
            raise ValueError("Cached metadata identity is invalid")
        latest, spec = obj["latest"], obj["latest"]["pubspec"]
        packet["metadata"] = {"name": packet["package_name"], "version": latest["version"], "published": latest.get("published"), "description": spec.get("description", ""), "topics": spec.get("topics", []), "repository": spec.get("repository")}
        packet["metadata_captured_at"] = cached["captured_at"]
        packet["documentation_url"] = f"https://pub.dev/packages/{packet['package_name']}/versions/{latest['version']}"
        packet["binding_invalidated"] = True
    else:
        version = packet.get("metadata", {}).get("version")
        if not cached.get("url", "").endswith("/versions/" + str(version)):
            raise ValueError("Cached documentation version does not match metadata")
        packet["documentation"] = clean_readme(cached["body"])
        packet["documentation_truncated"] = False
        packet["documentation_captured_at"] = cached["captured_at"]
    source = {"url": cached["url"], "kind": kind, "origin": "matching_local_cache", "hash": hashlib.sha256(cached["body"].encode()).hexdigest(), "captured_at": cached["captured_at"], "reason": reason}
    if not any(s.get("url") == source["url"] and s.get("hash") == source["hash"] for s in packet["sources"]):
        packet["sources"].append(source)
    packet["fingerprint"] = fingerprint(packet)
    return packet


def locked_upstream_resource(out, package, kind, version, reason, spacing=0.25, session=None):
    """Recheck the exact resource under the request lock, then fetch once if absent."""
    expected = f"https://pub.dev/api/packages/{package}" if kind == "metadata" else f"https://pub.dev/packages/{package}/versions/{version}"
    lock_path = Path(out) / "upstream.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cached = local_resource(Path(out), package, kind, version)
        if cached and cached.get("url") == expected:
            return cached, False
        body = session._get_unlocked(expected, reason) if session else _http_unlocked(expected, out, reason, upstream=True, upstream_spacing=spacing)
        cached = {"url": expected, "body": body, "captured_at": now()}
        # Save before releasing the lock so a queued process observes the
        # checkpoint instead of repeating the successful request.
        save(Path(out) / "sources" / (package + "." + kind + ".json"), cached)
        return cached, True


def hydrate(args):
    out = outside_repo(args.output)
    if args.kind not in {"metadata", "documentation"}:
        raise ValueError("hydrate requires --kind metadata or documentation")
    run_lock_path = out / ("hydrate-" + args.kind + ".run.lock")
    run_lock_path.parent.mkdir(parents=True, exist_ok=True)
    with run_lock_path.open("a") as run_lock:
        try:
            fcntl.flock(run_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError(
                f"hydrate {args.kind} is already running for this snapshot; keep the existing foreground process attached and do not start another resume"
            ) from None
        return _hydrate(args, out)


def _hydrate(args, out):
    selected = read(out / "selection.json")
    ledger = read(args.ledger, {}) if args.ledger else {}
    state_path = out / ("hydrate-" + args.kind + "-state.json")
    state = read(state_path, {"completed": [], "failed": {}})
    completed = set(state.get("completed", []))
    targets = []
    for item in selected:
        name = item["package_name"]
        if (out / "reviews" / (name + ".json")).exists():
            continue
        packet = read(out / "evidence" / (name + ".json"))
        if noise_reusable(packet, ledger, getattr(args, "reopen_noise", False)):
            continue
        if name in completed:
            continue
        if args.kind == "metadata":
            needed = not packet.get("metadata", {}).get("version")
        else:
            which, _ = lane(packet, ledger)
            needed = which in {"review", "comparison_only"} and not packet.get("documentation") and packet.get("metadata", {}).get("version")
        if needed:
            targets.append((name, packet))
    if args.max_packages:
        targets = targets[:args.max_packages]
    fetched = reused = failed = 0
    session = PubDevSession(out, args.upstream_spacing) if targets and not args.cloudflare_only else None
    for name, packet in targets:
        cached = local_resource(out, name, args.kind, packet.get("metadata", {}).get("version"))
        try:
            if cached:
                packet = apply_resource(out, packet, args.kind, cached, "Reuse exact-version local evidence before upstream access")
                reused += 1
            else:
                if args.cloudflare_only:
                    state.setdefault("failed", {})[name] = "cloudflare_only evidence gap"
                    failed += 1
                    save(state_path, state)
                    continue
                cached, did_fetch = locked_upstream_resource(
                    out,
                    name,
                    args.kind,
                    packet.get("metadata", {}).get("version"),
                    "Full-registry review evidence missing from Cloudflare and local cache",
                    args.upstream_spacing,
                    session,
                )
                packet = apply_resource(out, packet, args.kind, cached, "Full-registry review evidence missing from Cloudflare and local cache")
                fetched += int(did_fetch)
                reused += int(not did_fetch)
            save(out / "evidence" / (name + ".json"), packet)
            state.setdefault("completed", []).append(name)
            state.get("failed", {}).pop(name, None)
            completed.add(name)
        except (RuntimeError, ValueError, json.JSONDecodeError) as exc:
            state.setdefault("failed", {})[name] = str(exc)
            failed += 1
            save(state_path, state)
            if "HTTP 429" in str(exc) or "HTTP 5" in str(exc) or "cooldown" in str(exc):
                raise
        save(state_path, state)
    if session:
        session.close()
    remaining = 0
    for item in selected:
        if (out / "reviews" / (item["package_name"] + ".json")).exists():
            continue
        packet = read(out / "evidence" / (item["package_name"] + ".json"))
        if noise_reusable(packet, ledger, getattr(args, "reopen_noise", False)):
            continue
        if args.kind == "metadata" and not packet.get("metadata", {}).get("version"):
            remaining += 1
        elif args.kind == "documentation" and lane(packet, ledger)[0] in {"review", "comparison_only"} and not packet.get("documentation"):
            remaining += 1
    return {"kind": args.kind, "targets": len(targets), "fetched": fetched, "local_reuse": reused, "failed": failed, "remaining": remaining}


def screen(args):
    out = outside_repo(args.output)
    ledger = read(args.ledger, {}) if args.ledger else {}
    created = collections.Counter()
    stamp = now()
    for item in read(out / "selection.json"):
        name = item["package_name"]
        dest = out / "reviews" / (name + ".json")
        if dest.exists():
            continue
        packet = read(out / "evidence" / (name + ".json"))
        which, reason = lane(packet, ledger)
        if which not in {"screen_noise", "evidence_gap"}:
            continue
        source_url = packet.get("documentation_url") or f"https://pub.dev/packages/{name}"
        if which == "screen_noise":
            description = packet.get("metadata", {}).get("description", "").strip()
            finding = reason + ". Package metadata describes: " + description
            decision = {"relationship": "noise", "capability_category": "script-screened unrelated functionality", "rationale": finding, "capabilities": [], "providers": [], "actions": [], "migration_status": "unsupported", "expansion": False, "review_status": "screened"}
            origin = "script_screen"
        else:
            finding = "No usable package metadata was available after Cloudflare-first collection; relationship remains unresolved."
            decision = {"relationship": "unknown", "capability_category": "missing package evidence", "rationale": finding, "capabilities": [], "providers": [], "actions": [], "migration_status": "needs_review", "expansion": False, "review_status": "evidence_gap"}
            origin = "evidence_gap"
        record = {"package_name": name, "evidence_hash": packet.get("evidence_hash", ""), "product_commit": packet["product_commit"], "reviewed_by": "review-deeplinkx-competitors deterministic triage", "decision": decision, "review": {"reviewed_at": stamp, "fingerprint": fingerprint(packet), "decision_origin": origin, "finding": finding, "limitations": ["Provisional deterministic triage; no semantic model review. Reopen on relevant evidence or scope changes."], "sources": [{"url": source_url, "label": "Package evidence available to deterministic triage"}]}}
        save(dest, record)
        created[which] += 1
    return {"created": dict(created), "total": sum(created.values())}


def clean_readme(body):
    start = re.search(r'<(?:section|div)[^>]*class="[^"]*(?:detail-tab-readme|markdown-body)[^"]*"[^>]*>', body, re.I)
    if not start:
        raise ValueError("README container missing; preserve failure, do not treat whole page as evidence")
    section = body[start.end():].split("</section>", 1)[0]
    section = re.sub(r"<(script|style)\b[^>]*>[\s\S]*?</\1>", "", section, flags=re.I)
    section = re.sub(r"</(?:p|li|h[1-6]|pre|div)>", "\n", section, flags=re.I)
    return re.sub(r"[ \t]+", " ", html.unescape(re.sub(r"<[^>]+>", " ", section))).strip()


def fetch_gap(args):
    out = outside_repo(args.output)
    if not NAME.fullmatch(args.package):
        raise ValueError("Invalid package name")
    pth = out / "evidence" / (args.package + ".json")
    p = read(pth)
    if not p:
        raise ValueError("Prepare Cloudflare evidence first")
    ledger = read(args.ledger, {}) if args.ledger else {}
    if noise_reusable(p, ledger, getattr(args, "reopen_noise", False)):
        return {"reused": "confirmed noise policy", "pubdev_requests": 0}
    key = args.kind
    if key == "metadata" and p.get("metadata", {}).get("version"):
        return {"reused": "cloudflare metadata", "pubdev_requests": 0}
    if key == "documentation" and p.get("documentation") and not p.get("documentation_truncated"):
        return {"reused": "stored documentation", "pubdev_requests": 0}
    cached = local_resource(out, args.package, key, p.get("metadata", {}).get("version"))
    expected = f"https://pub.dev/api/packages/{args.package}" if key == "metadata" else f"https://pub.dev/packages/{args.package}/versions/{p.get('metadata', {}).get('version')}"
    if cached and cached.get("url") == expected:
        if key == "documentation":
            p["documentation"] = clean_readme(cached["body"])
            p["documentation_truncated"] = False
            p["documentation_captured_at"] = cached["captured_at"]
        else:
            obj = json.loads(cached["body"])
            if obj.get("name") != args.package or not obj.get("latest", {}).get("version"):
                raise ValueError("Cached metadata identity is invalid")
            latest, spec = obj["latest"], obj["latest"]["pubspec"]
            p["metadata"] = {"name": args.package, "version": latest["version"], "published": latest.get("published"), "description": spec.get("description", ""), "topics": spec.get("topics", []), "repository": spec.get("repository")}
            p["metadata_captured_at"] = cached["captured_at"]
            p["binding_invalidated"] = True
        source_record = {"url": cached["url"], "kind": key, "origin": "matching_local_cache", "hash": hashlib.sha256(cached["body"].encode()).hexdigest(), "captured_at": cached["captured_at"], "reason": args.reason}
        if not any(s.get("url") == source_record["url"] and s.get("hash") == source_record["hash"] for s in p["sources"]):
            p["sources"].append(source_record)
        p["fingerprint"] = fingerprint(p)
        save(pth, p)
        return {"reused": "matching local resource cache", "pubdev_requests": 0}
    # A truncation/gap is checked against full D1 and retained raw data before upstream.
    if not args.dashboard_repo:
        raise ValueError("Provide --dashboard-repo for stored-evidence lookup before upstream fallback")
    n = names_sql([args.package])
    row = d1(args.dashboard_repo, "SELECT * FROM competitor_registry WHERE package_name IN (" + n + ")")[0]["results"]
    if row:
        restored = row_packet(row[0], p["group"], read(out / "product-catalog.json"))
        same_version = restored["metadata"].get("version") == p["metadata"].get("version")
        if key == "metadata" and restored["metadata"].get("version"):
            p["metadata"] = restored["metadata"]
            p["metadata_captured_at"] = restored["metadata_captured_at"]
            p["binding_invalidated"] = True
            save(pth, p)
            return {"reused": "newly available cloudflare metadata", "pubdev_requests": 0}
        if key == "documentation" and same_version and restored.get("documentation"):
            p["documentation"] = restored["documentation"]
            p["documentation_truncated"] = False
            save(pth, p)
            return {"reused": "full cloudflare README", "pubdev_requests": 0}
    purpose = "competitor-" + ("readme" if key == "documentation" else "metadata") + ":" + args.package
    if key == "metadata":
        historical = d1(args.dashboard_repo, "SELECT published_version,published_description,published_topics_json,metadata_captured_at,package_url FROM competitor_classifications WHERE package_name IN (" + n + ") AND published_description IS NOT NULL AND published_version IS NOT NULL ORDER BY metadata_captured_at DESC LIMIT 1")[0]["results"]
        if historical:
            old = historical[0]
            p["metadata"] = {"name": args.package, "version": old["published_version"], "description": old["published_description"], "topics": json.loads(old["published_topics_json"] or "[]")}
            p["metadata_captured_at"] = old["metadata_captured_at"]
            p["documentation_url"] = f"https://pub.dev/packages/{args.package}/versions/{old['published_version']}"
            p["binding_invalidated"] = True
            p["sources"].append({"url": old["package_url"], "kind": "metadata", "origin": "cloudflare_historical", "hash": digest(p["metadata"]), "captured_at": old["metadata_captured_at"], "reason": "Historical snapshot metadata is sufficient for purpose review; current-version status is not claimed."})
            save(pth, p)
            return {"reused": "cloudflare historical metadata", "pubdev_requests": 0}
    raw = d1(args.dashboard_repo, "SELECT source_url,body,body_hash,captured_at FROM raw_http_bodies WHERE purpose='" + purpose + "' AND status_code=200 ORDER BY captured_at DESC LIMIT 1")[0]["results"]
    version = p.get("metadata", {}).get("version")
    usable = bool(raw and (key == "metadata" or raw[0]["source_url"].endswith("/versions/" + str(version))))
    if usable:
        body, source, url, stamp = raw[0]["body"], "cloudflare_raw", raw[0]["source_url"], raw[0]["captured_at"]
    else:
        if args.cloudflare_only:
            log(out, {"origin": "gap", "package": args.package, "kind": key, "reason": args.reason, "cloudflare_checked": True})
            return {"gap": args.package, "kind": key, "pubdev_requests": 0}
        if key == "documentation" and not version:
            raise ValueError("Resolve metadata/version before requesting versioned documentation")
        cached, did_fetch = locked_upstream_resource(out, args.package, key, version, args.reason, spacing=2)
        body, url, stamp = cached["body"], cached["url"], cached["captured_at"]
        source = "pub.dev" if did_fetch else "matching_local_cache"
    if key == "metadata":
        obj = json.loads(body)
        if obj.get("name") != args.package or not obj.get("latest", {}).get("version"):
            raise ValueError("Invalid package metadata")
        spec, latest = obj["latest"]["pubspec"], obj["latest"]
        p["metadata"] = {"name": args.package, "version": latest["version"], "published": latest.get("published"), "description": spec.get("description", ""), "topics": spec.get("topics", []), "repository": spec.get("repository")}
        p["metadata_captured_at"] = stamp
        p["binding_invalidated"] = True
        p["documentation_url"] = f"https://pub.dev/packages/{args.package}/versions/{latest['version']}"
    else:
        p["documentation"] = clean_readme(body)
        p["documentation_truncated"] = False
        p["documentation_captured_at"] = stamp
    p["sources"].append({"url": url, "kind": key, "origin": source, "hash": hashlib.sha256(body.encode()).hexdigest(), "captured_at": stamp, "reason": args.reason})
    save(out / "sources" / (args.package + "." + key + ".json"), {"url": url, "body": body, "origin": source, "captured_at": stamp})
    p["fingerprint"] = fingerprint(p)
    save(pth, p)
    return {"package": args.package, "kind": key, "source": source}


def validate_record(record, packet, catalog):
    errors = []
    d = record.get("decision", {})
    if d.get("relationship") not in REL or d.get("migration_status") not in MIG:
        errors.append("invalid relationship/migration")
    for k in ["capability_category", "rationale"]:
        if not isinstance(d.get(k), str) or not d[k].strip():
            errors.append("missing " + k)
    if not isinstance(d.get("expansion"), bool):
        errors.append("expansion must be boolean")
    if not isinstance(record.get("reviewed_by"), str) or not 0 < len(record["reviewed_by"]) <= 120:
        errors.append("missing/invalid reviewer")
    if not record.get("review", {}).get("finding") or not record.get("review", {}).get("sources"):
        errors.append("missing review finding/sources")
    sources = record.get("review", {}).get("sources", [])
    if not isinstance(sources, list) or any(not isinstance(s, dict) or not str(s.get("url", "")).startswith("https://") for s in sources):
        errors.append("invalid review source links")
    if record.get("review", {}).get("fingerprint") != fingerprint(packet):
        errors.append("evidence fingerprint changed; re-review")
    if record.get("package_name") != packet["package_name"]:
        errors.append("package mismatch")
    if record.get("product_commit") != catalog["source_commit"] or record.get("product_commit") != packet["product_commit"]:
        errors.append("product mismatch")
    apis = {c["api"] for c in catalog["capabilities"] + catalog.get("verified_shared_apis", [])}
    caps = d.get("capabilities")
    if not isinstance(caps, list) or len(caps) > 50:
        errors.append("invalid capabilities")
        caps = []
    for c in caps:
        if not isinstance(c, dict):
            errors.append("capability must be an object")
            continue
        if not all(isinstance(c.get(k), str) and c[k].strip() for k in ["provider", "action", "evidence", "source_url"]):
            errors.append("capability missing evidence")
        if not c.get("source_url", "").startswith("https://") or c.get("migration") not in MIG:
            errors.append("invalid capability source/migration")
        if not isinstance(c.get("caveats"), list) or not isinstance(c.get("deeplinkx_apis"), list) or any(a not in apis for a in c.get("deeplinkx_apis", [])):
            errors.append("unknown product API or invalid caveats")
    for field, key in [("providers", "provider"), ("actions", "action")]:
        if not isinstance(d.get(field), list) or sorted(set(d.get(field, []))) != sorted({c.get(key, "") for c in caps if isinstance(c, dict)}):
            errors.append(field + " must match capability claims")
    if d.get("relationship") == "direct" and not any(isinstance(c, dict) and c.get("deeplinkx_apis") for c in caps):
        errors.append("direct classification lacks mapped API")
    bound = bool(re.fullmatch(r"[0-9a-f]{64}", record.get("evidence_hash", ""))) and record.get("evidence_hash") == packet.get("evidence_hash")
    if packet.get("binding_invalidated"):
        bound = False
    manual = d.get("review_status") == "reviewed" and record.get("review", {}).get("decision_origin") not in {"script_screen", "evidence_gap"}
    ready = not errors and bound and d.get("relationship") != "unknown" and manual
    return errors, ready


def validate(args):
    out = outside_repo(args.output)
    catalog = read(out / "product-catalog.json")
    result = {"valid": 0, "ready": 0, "draft": 0, "errors": {}, "scope": "frozen snapshot; live hash recheck required before any future import"}
    for s in read(out / "selection.json"):
        n = s["package_name"]
        packet = read(out / "evidence" / (n + ".json"))
        record = read(out / "reviews" / (n + ".json"), {})
        errors, ready = validate_record(record, packet, catalog)
        if errors:
            result["errors"][n] = errors
        else:
            result["valid"] += 1
            result["ready" if ready else "draft"] += 1
        # Regenerate both lanes, avoiding an obsolete ready file after evidence changes.
        for folder in ["ready", "drafts"]:
            (out / folder / (n + ".json")).unlink(missing_ok=True)
        payload = {k: record.get(k) for k in ["package_name", "evidence_hash", "product_commit", "reviewed_by", "decision"]}
        if record:
            save(out / ("ready" if ready else "drafts") / (n + ".json"), payload)
    save(out / "validation.json", result)
    return result


def update_ledger(args):
    out = outside_repo(args.output)
    target = outside_repo(args.ledger)
    ledger = read(target, {})
    catalog = read(out / "product-catalog.json")
    count = 0
    for s in read(out / "selection.json"):
        n = s["package_name"]
        r = read(out / "reviews" / (n + ".json"), {})
        p = read(out / "evidence" / (n + ".json"))
        errors, _ = validate_record(r, p, catalog)
        if errors:
            continue
        if r["decision"].get("review_status") != "reviewed":
            continue
        ledger[n] = {"scope": SCOPE, "fingerprint": fingerprint(p), "product_commit": r["product_commit"], "decision": r["decision"], "decision_origin": r["review"].get("decision_origin", "manual_llm_review"), "reviewed_at": r["review"]["reviewed_at"], "reviewed_by": r["reviewed_by"], "review_policy": "wait_for_evidence" if r["decision"]["relationship"] == "unknown" else "skip_unchanged", "noise_reason": "unrelated_functionality" if r["decision"]["relationship"] == "noise" else None, "sources": r["review"]["sources"], "finding": r["review"]["finding"]}
        ledger[n]["evidence_path"] = str(out / "evidence" / (n + ".json"))
        ledger[n]["behavior_evidence"] = observed_behavior(p)
        ledger[n]["semantic_mapping_policy_version"] = SEMANTIC_MAPPING_POLICY_VERSION if r["decision"]["relationship"] != "noise" else None
        count += 1
    save(target, ledger)
    return {"saved": count, "ledger_total": len(ledger)}


def reuse(args):
    out = outside_repo(args.output)
    ledger = read(args.ledger, {}) if args.ledger else {}
    count = 0
    controls = set(read(out / "control-selection.json", []))
    for s in read(out / "selection.json"):
        n = s["package_name"]
        p = read(out / "evidence" / (n + ".json"))
        which, _ = lane(p, ledger)
        if not which.startswith("reuse") or n in controls:
            continue
        old = p["cloudflare_review"] if which == "reuse_cloudflare" else ledger[n]
        sources = old.get("sources") or [{"url": p.get("documentation_url") or f"https://pub.dev/packages/{n}", "label": "Evidence supporting prior Cloudflare review"}]
        r = {"package_name": n, "evidence_hash": p["evidence_hash"], "product_commit": p["product_commit"], "reviewed_by": old["reviewed_by"], "decision": old["decision"], "review": {"reviewed_at": old["reviewed_at"], "decision_origin": which, "fingerprint": fingerprint(p), "finding": old.get("finding", old["decision"]["rationale"]), "sources": sources, "limitations": ["Reused prior semantic review; current identifiers must be checked before a future import."]}}
        dest = out / "reviews" / (n + ".json")
        # Never overwrite a new manually authored finding.
        if not dest.exists():
            save(dest, r)
            count += 1
    return {"reused_without_llm": count}


def cell(v):
    return str(v if v is not None else "unavailable").replace("|", "\\|").replace("\n", " ")


def render(args):
    out = outside_repo(args.output)
    valid = read(out / "validation.json", {})
    selected, catalog = read(out / "selection.json"), read(out / "product-catalog.json")
    if valid.get("valid") != len(selected) or valid.get("errors"):
        raise ValueError("Validate every selected record before rendering the complete report")
    intro = (out / "report-notes.md").read_text() if (out / "report-notes.md").exists() else ""
    lines = [f"# DeeplinkX competitor review — {len(selected)} packages", "", f"Rendered: {now()}", f"Product commit: `{catalog['source_commit']}`. Review scope: `{SCOPE}`.", "", intro, "", "## Inspected packages", "", "Metrics are recorded observations, not live refreshes. Missing values are unavailable, not zero. Report tables do not imply device testing. Screened and evidence-gap records are provisional drafts, not manual reviews.", "", "| Package | Version / published | Downloads (30d) | Likes | Points | Before → reviewed | Metrics observed |", "|---|---|---:|---:|---|---|---|"]
    counts = collections.Counter()
    for s in selected:
        n = s["package_name"]; p = read(out / "evidence" / (n + ".json")); r = read(out / "reviews" / (n + ".json")); m = p["metadata"]; score = p["metrics"]; counts[r["decision"]["relationship"]] += 1
        points = f"{score.get('points')}/{score.get('max_points')}" if score.get("points") is not None else None
        lines.append("| " + " | ".join([f"[{n}](https://pub.dev/packages/{n})", cell(str(m.get("version", "unavailable")) + " / " + str(m.get("published", "unavailable"))), cell(score.get("downloads_30d")), cell(score.get("likes")), cell(points), cell(p.get("original", {}).get("relationship", "unknown") + " → " + r["decision"]["relationship"]), cell(p.get("metrics_captured_at"))]) + " |")
    lines += ["", f"Reviewed totals: {dict(counts)}. Snapshot-bound import files: {valid['ready']}; drafts: {valid['draft']}. None imported.", "", "## Individual findings", ""]
    for s in selected:
        n = s["package_name"]; p = read(out / "evidence" / (n + ".json")); r = read(out / "reviews" / (n + ".json")); d = r["decision"]; v = r["review"]
        origins = sorted({p['source_origin'], *(s['origin'] for s in p.get('sources', []))})
        lines += [f"### {n}", "", f"Selection: {s['group']}. " + s.get("substitution", ""), f"**{d['relationship']}** · migration: **{d['migration_status']}** · expansion: **{str(d['expansion']).lower()}** · origin: **{v.get('decision_origin','manual LLM review')}**.", "", v["finding"], *(["", d["rationale"]] if d["rationale"] != v["finding"] else []), "", f"Evidence provenance: {', '.join(origins)}; metadata observed {p.get('metadata_captured_at')}; documentation observed {p.get('documentation_captured_at')}." ]
        for c in d["capabilities"]:
            lines += ["", f"- **{c['provider']} / {c['action']}**: {c['evidence']} [Source]({c['source_url']}). DeeplinkX: {', '.join(c['deeplinkx_apis']) or 'no established matching public API'}; migration: {c['migration']}. " + " ".join(c["caveats"])]
        if v.get("limitations"):
            lines += ["", "Limitations: " + " ".join(v["limitations"])]
        lines += ["", "Recorded platform tags: " + (", ".join(p.get("metrics", {}).get("platforms", [])) or "unavailable") + ". These tags do not establish action-specific behavior."]
        lines += ["", "Sources: " + ", ".join(f"[{x.get('label','Evidence')}]({x['url']})" for x in v["sources"]), ""]
        if d["relationship"] == "noise":
            lines += ["Reuse: `unrelated_functionality`; `skip_unchanged`. Reopen on relevant evidence or scope changes.", ""]
    reused_noise = read(out / "reuse-summary.json", {})
    lines += ["", "## Confirmed noise reused without collection or review", "", f"{len(reused_noise)} packages skipped under the saved review policy; these are not newly inspected packages."]
    for name, entry in sorted(reused_noise.items()):
        lines.append(f"- {name}: {entry.get('finding') or entry['reason']} (original review: {entry.get('reviewed_at')})")
    for filename in ["improvements.md", "opportunities.md", "usage.md"]:
        if (out / filename).exists():
            lines += ["", (out / filename).read_text()]
    (out / "review-report.md").write_text("\n".join(lines) + "\n")
    return {"report": str(out / "review-report.md"), "packages": len(selected), "counts": dict(counts)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["collect", "select", "prepare", "hydrate", "fetch-gap", "packets", "screen", "validate", "ledger", "reuse", "render"])
    parser.add_argument("--output", required=True)
    parser.add_argument("--dashboard-repo")
    parser.add_argument("--catalog")
    parser.add_argument("--product-repo")
    parser.add_argument("--ledger")
    parser.add_argument("--d1", action="store_true")
    parser.add_argument("--sqlite-db", help="Read a frozen local SQLite evidence snapshot without Cloudflare requests")
    parser.add_argument("--registry-file")
    parser.add_argument("--cloudflare-only", action="store_true")
    parser.add_argument("--package")
    parser.add_argument("--kind", choices=["metadata", "documentation"])
    parser.add_argument("--reason", default="")
    parser.add_argument("--controls", type=int, default=0, help="Explicit opt-in noise spot checks; routine runs use zero")
    parser.add_argument("--reopen-noise", action="store_true", help="Explicitly override confirmed-noise reuse")
    parser.add_argument("--all", action="store_true", help="Collect and select every registry package instead of the 40-package pilot")
    parser.add_argument("--exclude-reviewed", action="store_true", help="In --all selection, exclude packages already present in the supplied ledger")
    parser.add_argument("--upstream-spacing", type=float, default=0.25, help="Minimum seconds between sequential pub.dev requests in hydrate")
    parser.add_argument("--max-packages", type=int, default=0, help="Checkpoint after at most this many hydrate targets; zero means all")
    args = parser.parse_args()
    if args.d1 and args.sqlite_db:
        parser.error("Choose either --d1 or --sqlite-db")
    out = outside_repo(args.output)
    if args.command == "select":
        if (out / "selection.json").exists():
            result = {"reused": "frozen selection"}
        else:
            excluded = read(args.ledger, {}).keys() if args.exclude_reviewed and args.ledger else []
            data = read(out / "candidates.json")
            ledger = read(args.ledger, {}) if args.ledger else {}
            for key in ("candidates", "pending"):
                data[key] = policy_filter(out, data[key], ledger, args.reopen_noise or args.controls > 0)
            chosen = selection(data, args.all, excluded); save(out / "selection.json", chosen); result = {"selected": len(chosen), "excluded_reviewed": len(set(excluded)), "substitutions": [x for x in chosen if x.get("substitution")]}
    elif args.command == "packets":
        result = packet_batches(out, args.ledger, args.controls)
    else:
        result = {"collect": collect, "prepare": prepare, "hydrate": hydrate, "fetch-gap": fetch_gap, "screen": screen, "validate": validate, "ledger": update_ledger, "reuse": reuse, "render": render}[args.command](args)
    print(json.dumps(result, ensure_ascii=False))
    if isinstance(result, dict) and result.get("errors"):
        raise SystemExit(1)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, KeyError) as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        raise SystemExit(1)
