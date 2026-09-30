import argparse
from concurrent.futures import ThreadPoolExecutor
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import time
import unittest
from unittest.mock import patch, MagicMock

import review as r


def packet():
    return {"package_name": "draggable_menu", "group": "noise_control", "metadata": {"name": "draggable_menu", "version": "1.0.0", "description": "Custom draggable menus and animations", "topics": ["ui"]}, "documentation": "DraggableMenu.open opens a UI widget.", "documentation_url": "https://pub.dev/packages/draggable_menu/versions/1.0.0", "sources": [], "original": {"relationship": "unknown"}, "metrics": {}, "product_commit": "a" * 40, "evidence_hash": "b" * 64, "source_origin": "cloudflare_registry"}


def record(p):
    return {"package_name": p["package_name"], "evidence_hash": p["evidence_hash"], "product_commit": p["product_commit"], "reviewed_by": "fixture reviewer", "decision": {"relationship": "noise", "capability_category": "UI widget", "rationale": "Provides an embedded draggable menu", "capabilities": [], "providers": [], "actions": [], "migration_status": "unsupported", "expansion": False, "review_status": "reviewed"}, "review": {"fingerprint": r.fingerprint(p), "reviewed_at": "2026-09-20T00:00:00Z", "finding": "Menu opening is not external app launching.", "sources": [{"url": p["documentation_url"], "label": "Purpose"}]}}


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name)
        self.p = packet()
        self.c = {"source_commit": self.p["product_commit"], "capabilities": [{"api": "WhatsApp.open"}]}
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        r.save(self.out / "product-catalog.json", self.c)
        r.save(self.out / "selection.json", [{"package_name": "draggable_menu", "group": "noise_control"}])

    def tearDown(self):
        self.tmp.cleanup()

    def args(self, **kw):
        values = {"output": str(self.out), "package": "draggable_menu", "kind": "documentation",
                  "dashboard_repo": "/repo", "cloudflare_only": False, "reason": "Need API",
                  "ledger": str(self.out / "ledger.json"), "upstream_spacing": 0,
                  "max_packages": 0, "sqlite_db": None}
        values.update(kw)
        return argparse.Namespace(**values)

    def test_usable_cloudflare_document_avoids_all_requests(self):
        with patch.object(r, "http", side_effect=AssertionError("upstream")), patch.object(r, "d1", side_effect=AssertionError("unneeded D1")):
            self.assertEqual(r.fetch_gap(self.args())["pubdev_requests"], 0)

    def test_local_snapshot_collection_never_calls_cloudflare(self):
        snapshot = self.out / "snapshot.sqlite"
        connection = sqlite3.connect(snapshot)
        connection.executescript("""
            CREATE TABLE competitor_registry(package_name TEXT, relationship TEXT, downloads_30d INTEGER,
              evidence_hash TEXT, analysis_json TEXT, refresh_status TEXT);
            CREATE TABLE intelligence_jobs(status TEXT);
            INSERT INTO competitor_registry VALUES('map_launcher','direct',123,'evidence', '{}','complete');
        """)
        connection.close()
        args = self.args(d1=False, sqlite_db=str(snapshot), all=True)
        with patch.object(r, "d1", side_effect=AssertionError("D1 request")), patch.object(r, "http", side_effect=AssertionError("HTTP request")):
            result = r.collect(args)
        self.assertEqual(result["candidate_count"], 1)
        frozen = r.read(self.out / "candidates.json")
        self.assertEqual(frozen["source"], "local_sqlite_snapshot")
        self.assertIsNone(frozen["rows_read"])

    def test_local_snapshot_rejects_mutating_sql(self):
        snapshot = self.out / "readonly.sqlite"
        sqlite3.connect(snapshot).execute("CREATE TABLE t (value TEXT)").connection.close()
        with self.assertRaisesRegex(ValueError, "read-only"):
            r.d1_sqlite(snapshot, "DELETE FROM t")

    def test_truncated_excerpt_checks_full_cloudflare_before_upstream(self):
        self.p["documentation_truncated"] = True
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        row = {"package_name": "draggable_menu", "metadata_json": json.dumps(self.p["metadata"]), "documentation_version": "1.0.0", "documentation_text": "Full stored API documentation"}
        with patch.object(r, "d1", return_value=[{"results": [row]}]) as db, patch.object(r, "http", side_effect=AssertionError("upstream")):
            self.assertEqual(r.fetch_gap(self.args())["pubdev_requests"], 0)
            db.assert_called_once()
        self.assertEqual(r.read(self.out / "evidence/draggable_menu.json")["documentation"], row["documentation_text"])

    def test_matching_local_cache_avoids_refetch_after_partial_checkpoint(self):
        self.p["documentation"] = ""
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        r.save(self.out / "sources/draggable_menu.documentation.json", {"url": self.p["documentation_url"], "body": '<section class="detail-tab-readme"><p>Menu widget</p></section>', "captured_at": r.now()})
        with patch.object(r, "http", side_effect=AssertionError("upstream")), patch.object(r, "d1", side_effect=AssertionError("already cached")):
            self.assertEqual(r.fetch_gap(self.args())["pubdev_requests"], 0)

    def test_historical_cloudflare_metadata_avoids_upstream(self):
        self.p["metadata"] = {}; self.p["documentation"] = ""
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        args = self.args(); args.kind = "metadata"
        old = {"published_version": "1.0.0", "published_description": "A UI menu", "published_topics_json": "[]", "metadata_captured_at": r.now(), "package_url": "https://pub.dev/packages/draggable_menu"}
        with patch.object(r, "d1", side_effect=[[{"results": []}], [{"results": [old]}]]), patch.object(r, "http", side_effect=AssertionError("upstream")):
            self.assertEqual(r.fetch_gap(args)["reused"], "cloudflare historical metadata")

    def test_cloudflare_only_preserves_gap_and_ignores_other_version(self):
        self.p["documentation"] = ""
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        args = self.args(); args.cloudflare_only = True
        wrong = {"source_url": "https://pub.dev/packages/draggable_menu/versions/0.9.0", "body": "old"}
        with patch.object(r, "d1", side_effect=[[{"results": []}], [{"results": [wrong]}]]), patch.object(r, "http", side_effect=AssertionError("upstream")):
            self.assertEqual(r.fetch_gap(args)["gap"], "draggable_menu")

    def test_metric_changes_do_not_reopen_noise(self):
        old = {"scope": r.SCOPE, "fingerprint": r.fingerprint(self.p), "decision": {"relationship": "noise"}, "product_commit": "old"}
        self.p["metrics"] = {"downloads_30d": 999}; self.p["metrics_captured_at"] = r.now()
        self.assertEqual(r.lane(self.p, {"draggable_menu": old})[0], "reuse")
        self.p["metadata"]["description"] += " and launch external apps"
        self.assertNotEqual(r.lane(self.p, {"draggable_menu": old})[0], "reuse")

    def test_product_change_reopens_only_comparison(self):
        old = {"scope": r.SCOPE, "fingerprint": r.fingerprint(self.p), "decision": {"relationship": "direct"}, "product_commit": "old"}
        self.assertEqual(r.lane(self.p, {"draggable_menu": old})[0], "comparison_only")

    def test_unchanged_unknown_waits_without_semantic_repetition(self):
        old = {"scope": r.SCOPE, "fingerprint": r.fingerprint(self.p), "decision": {"relationship": "unknown"}, "product_commit": self.p["product_commit"]}
        self.assertEqual(r.lane(self.p, {"draggable_menu": old})[0], "wait_for_evidence")

    def test_prepare_checkpoint_does_not_refetch(self):
        args = self.args(catalog=str(self.out / "product-catalog.json"), product_repo=None, registry_file=None, d1=False)
        with patch.object(r, "http", side_effect=AssertionError("refetch")), patch.object(r, "d1", side_effect=AssertionError("refetch")):
            result = r.prepare(args)
        self.assertEqual(result["packets"], 1)

    def test_hydrate_skips_existing_review_records(self):
        self.p["documentation"] = ""
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        r.save(self.out / "reviews/draggable_menu.json", record(self.p))
        args = self.args(); args.kind = "documentation"
        with patch.object(r, "local_resource", side_effect=AssertionError("reviewed package should not be hydrated")), patch.object(r, "PubDevSession", side_effect=AssertionError("reviewed package should not create a session")):
            result = r.hydrate(args)
        self.assertEqual(result["targets"], 0)
        self.assertEqual(result["remaining"], 0)

    def test_resource_lock_rechecks_checkpoint_and_fetches_once(self):
        self.p["documentation"] = ""
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        calls = 0
        calls_lock = threading.Lock()

        def upstream(*_args, **_kwargs):
            nonlocal calls
            with calls_lock:
                calls += 1
            time.sleep(0.05)
            return '<section class="detail-tab-readme"><p>Menu widget</p></section>'

        def fetch():
            return r.locked_upstream_resource(
                self.out,
                "draggable_menu",
                "documentation",
                "1.0.0",
                "Need exact README",
                spacing=0,
            )

        with patch.object(r, "_http_unlocked", side_effect=upstream):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = [future.result() for future in [pool.submit(fetch), pool.submit(fetch)]]
        self.assertEqual(calls, 1)
        self.assertEqual(sorted(fetched for _, fetched in results), [False, True])
        self.assertTrue((self.out / "sources/draggable_menu.documentation.json").exists())

    def test_hydrate_rejects_overlapping_run_for_same_snapshot_and_kind(self):
        entered = threading.Event()
        release = threading.Event()
        calls = 0

        def held_run(_args, _out):
            nonlocal calls
            calls += 1
            entered.set()
            self.assertTrue(release.wait(2))
            return {"targets": 0}

        args = self.args()
        with patch.object(r, "_hydrate", side_effect=held_run):
            with ThreadPoolExecutor(max_workers=1) as pool:
                first = pool.submit(r.hydrate, args)
                self.assertTrue(entered.wait(1))
                with self.assertRaisesRegex(RuntimeError, "already running"):
                    r.hydrate(args)
                release.set()
                self.assertEqual(first.result(), {"targets": 0})
        self.assertEqual(calls, 1)

    def test_mixed_package_escapes_noise_screen(self):
        self.p["metadata"]["description"] = "Authentication helpers and outbound URL schemes for Telegram"
        self.assertEqual(r.lane(self.p, {})[0], "review")

    def test_selection_is_deterministic_unique_and_missing_last(self):
        rows = []
        for rel in ["direct", "unknown", "adjacent", "noise"]:
            for i in range(12):
                rows.append({"package_name": f"{rel}_{i:02d}", "relationship": rel, "downloads_30d": None if i == 0 else i})
        data = {"candidates": rows, "pending": [{"package_name": f"pending_{i}"} for i in range(5)]}
        selected = r.selection(data)
        self.assertEqual(selected, r.selection({**data, "candidates": list(reversed(rows))}))
        self.assertEqual(len({p['package_name'] for p in selected}), 40)
        self.assertEqual(selected[0]["package_name"], "direct_11")

    def test_full_selection_has_no_limit_and_excludes_ledger_names(self):
        candidates = [{"package_name": f"reviewed_{i:03d}", "relationship": "unknown", "evidence_hash": "a" * 64} for i in range(60)]
        pending = [{"package_name": f"pending_{i:03d}"} for i in range(75)]
        selected = r.selection({"candidates": candidates, "pending": pending}, all_packages=True, exclude={"reviewed_000", "pending_000"})
        self.assertEqual(len(selected), 133)
        self.assertNotIn("reviewed_000", {p["package_name"] for p in selected})
        self.assertEqual(selected, sorted(selected, key=lambda p: p["package_name"]))

    def test_screened_noise_is_valid_draft_and_not_persisted_to_ledger(self):
        self.p["metadata"]["description"] = "A Flutter state management and animation package"
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        made = r.screen(self.args())
        self.assertEqual(made["created"], {"screen_noise": 1})
        rec = r.read(self.out / "reviews/draggable_menu.json")
        errors, ready = r.validate_record(rec, self.p, self.c)
        self.assertFalse(errors)
        self.assertFalse(ready)
        self.assertEqual(r.update_ledger(self.args())["saved"], 0)

    def test_cross_snapshot_exact_version_cache_is_reused(self):
        self.p["documentation"] = ""
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        sibling = self.out.parent / "previous-review" / "sources"
        sibling.mkdir(parents=True, exist_ok=True)
        r.save(sibling / "draggable_menu.documentation.json", {"url": self.p["documentation_url"], "body": '<section class="detail-tab-readme"><p>Menu widget</p></section>', "captured_at": r.now()})
        try:
            with patch.object(r, "http", side_effect=AssertionError("upstream")), patch.object(r, "d1", side_effect=AssertionError("cache should win")):
                self.assertEqual(r.fetch_gap(self.args())["pubdev_requests"], 0)
        finally:
            for child in sibling.iterdir(): child.unlink()
            sibling.rmdir(); sibling.parent.rmdir()

    def test_stale_hash_is_draft_and_semantic_change_invalid(self):
        rec = record(self.p)
        errors, ready = r.validate_record(rec, self.p, self.c)
        self.assertFalse(errors); self.assertTrue(ready)
        rec["evidence_hash"] = ""
        self.assertFalse(r.validate_record(rec, self.p, self.c)[1])
        self.p["documentation"] += " New outbound capability"
        self.assertIn("evidence fingerprint changed; re-review", r.validate_record(rec, self.p, self.c)[0])

    def test_unknown_api_rejected_and_malformed_capability_handled(self):
        rec = record(self.p)
        rec["decision"]["capabilities"] = [{"provider": "WhatsApp", "action": "open", "evidence": "Opens app", "source_url": "https://pub.dev", "deeplinkx_apis": ["Invented.launch"], "migration": "partial", "caveats": []}]
        self.assertTrue(r.validate_record(rec, self.p, self.c)[0])
        rec["decision"]["capabilities"] = ["invalid"]
        self.assertIn("capability must be an object", r.validate_record(rec, self.p, self.c)[0])

    def test_ledger_replay_preserves_review_provenance(self):
        r.save(self.out / "reviews/draggable_menu.json", record(self.p))
        self.assertEqual(r.update_ledger(self.args())["saved"], 1)
        (self.out / "reviews/draggable_menu.json").unlink()
        self.assertEqual(r.reuse(self.args())["reused_without_llm"], 1)
        rec = r.read(self.out / "reviews/draggable_menu.json")
        self.assertEqual(rec["review"]["reviewed_at"], "2026-09-20T00:00:00Z")
        self.assertEqual(rec["review"]["decision_origin"], "reuse")

    def test_cloudflare_prior_review_reused(self):
        rec = record(self.p)
        self.p["cloudflare_review"] = {**rec, "reviewed_at": "2026-09-20T00:00:00Z"}
        self.assertEqual(r.lane(self.p, {})[0], "reuse_cloudflare")

    def test_noise_control_is_not_automatically_replayed(self):
        r.save(self.out / "reviews/draggable_menu.json", record(self.p))
        r.update_ledger(self.args())
        (self.out / "reviews/draggable_menu.json").unlink()
        summary = r.packet_batches(self.out, str(self.out / "ledger.json"), controls=1)
        self.assertEqual(summary["lanes"], {"noise_control_review": 1})
        self.assertEqual(r.reuse(self.args())["reused_without_llm"], 0)

    def confirmed_ledger(self):
        r.save(self.out / "reviews/draggable_menu.json", record(self.p))
        r.update_ledger(self.args())
        (self.out / "reviews/draggable_menu.json").unlink()
        return r.read(self.out / "ledger.json")

    def test_confirmed_noise_missing_evidence_skips_all_enrichment(self):
        ledger = self.confirmed_ledger()
        self.p["metadata"] = {}; self.p["documentation"] = ""
        self.p["metrics"] = {"downloads_30d": 123}
        self.p["product_commit"] = "changed"; self.p["classifier_version"] = "changed"
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        self.assertEqual(r.lane(self.p, ledger)[0], "reuse")
        args = self.args(); args.kind = "metadata"
        with patch.object(r, "local_resource", side_effect=AssertionError("cache enrichment")), patch.object(r, "d1", side_effect=AssertionError("database")), patch.object(r, "http", side_effect=AssertionError("HTTP")), patch.object(r, "PubDevSession", side_effect=AssertionError("session")):
            self.assertEqual(r.hydrate(args)["targets"], 0)
            self.assertEqual(r.fetch_gap(args)["pubdev_requests"], 0)
        result = r.packet_batches(self.out, args.ledger)
        self.assertEqual(result["packets"], 0)
        self.assertIn("draggable_menu", r.read(self.out / "reuse-summary.json"))

    def test_noise_observed_behavior_version_scope_and_override_reopen(self):
        ledger = self.confirmed_ledger()
        changed = copy.deepcopy(self.p); changed["metadata"]["version"] = "2.0.0"
        self.assertTrue(r.noise_reusable(changed, ledger))
        for key, value in [("description", "Launch external apps")]:
            changed = copy.deepcopy(self.p); changed["metadata"][key] = value
            self.assertFalse(r.noise_reusable(changed, ledger))
        changed = copy.deepcopy(self.p); changed["documentation"] += ". Launch external WhatsApp app"
        self.assertFalse(r.noise_reusable(changed, ledger))
        self.assertFalse(r.noise_reusable(self.p, ledger, override=True))
        ledger["draggable_menu"]["scope"] = "other"
        self.assertFalse(r.noise_reusable(self.p, ledger))

    def test_prepare_uses_policy_before_fetching_missing_evidence(self):
        self.confirmed_ledger()
        (self.out / "evidence/draggable_menu.json").unlink()
        args = self.args(catalog=str(self.out / "product-catalog.json"), product_repo=None, registry_file=None, d1=True)
        with patch.object(r, "d1", side_effect=AssertionError("database")), patch.object(r, "http", side_effect=AssertionError("HTTP")):
            self.assertEqual(r.prepare(args)["packets"], 0)
        self.assertIn("draggable_menu", r.read(self.out / "reuse-summary.json"))

    def test_provisional_noise_is_not_policy_exclusion(self):
        ledger = self.confirmed_ledger()
        ledger["draggable_menu"]["decision"]["review_status"] = "screened"
        self.assertFalse(r.noise_reusable(self.p, ledger))

    def test_noise_only_pilot_can_be_empty(self):
        rows = [{"package_name": "noise_one", "relationship": "noise"}]
        self.assertEqual(r.selection({"candidates": rows, "pending": []}), [])
        self.assertEqual(r.selection({"candidates": [], "pending": []}, all_packages=True), [])

    def test_mapping_policy_reopens_relevant_decisions_only(self):
        ledger = self.confirmed_ledger()
        old = ledger["draggable_menu"]
        old["semantic_mapping_policy_version"] = "old"
        self.assertEqual(r.lane(self.p, ledger)[0], "reuse")
        old["decision"]["relationship"] = "direct"
        self.assertEqual(r.lane(self.p, ledger)[0], "comparison_only")
        old["semantic_mapping_policy_version"] = r.SEMANTIC_MAPPING_POLICY_VERSION
        self.assertEqual(r.lane(self.p, ledger)[0], "reuse")

    def test_crash_after_response_save_before_aggregate_does_not_refetch(self):
        self.p["metadata"] = {}; self.p["documentation"] = ""
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        args = self.args(); args.kind = "metadata"
        response = json.dumps({"name": "draggable_menu", "latest": {"version": "1.0.0", "pubspec": {"description": "UI menu"}}})
        with patch.object(r.PubDevSession, "_get_unlocked", return_value=response) as request, patch.object(r, "apply_resource", side_effect=KeyboardInterrupt("crash before aggregate")):
            with self.assertRaises(KeyboardInterrupt):
                r.hydrate(args)
            self.assertEqual(request.call_count, 1)
        self.assertTrue((self.out / "sources/draggable_menu.metadata.json").exists())
        self.assertFalse((self.out / "hydrate-metadata-state.json").exists())
        with patch.object(r.PubDevSession, "_get_unlocked", side_effect=AssertionError("duplicate upstream request")):
            result = r.hydrate(args)
        self.assertEqual(result["local_reuse"], 1)
        self.assertEqual(result["fetched"], 0)
        self.assertEqual(r.read(self.out / "hydrate-metadata-state.json")["completed"], ["draggable_menu"])

    def test_collection_excludes_noise_before_d1_resource_queries(self):
        self.confirmed_ledger()
        args = self.args(d1=True, all=True, controls=0, reopen_noise=False)
        rows = [{"results": [{"registered": 1}], "meta": {"rows_read": 1}}, {"results": [], "meta": {"rows_read": 0}}, {"results": [], "meta": {"rows_read": 0}}]
        with patch.object(r, "d1", return_value=rows) as db:
            self.assertEqual(r.collect(args)["candidate_count"], 0)
        self.assertIn("package_name NOT IN ('draggable_menu')", db.call_args.args[1])
        self.assertIn("draggable_menu", r.read(self.out / "reuse-summary.json"))

    def test_policy_lookup_uses_already_observed_local_version_change(self):
        ledger = self.confirmed_ledger()
        self.p["metadata"]["version"] = "2.0.0"
        r.save(self.out / "evidence/draggable_menu.json", self.p)
        self.assertEqual(len(r.policy_filter(self.out, [{"package_name": "draggable_menu"}], ledger)), 0)

    def test_retry_after_and_checkpoint_on_429(self):
        self.assertEqual(r.retry_seconds("120"), 120)
        self.assertGreaterEqual(r.retry_seconds("Sun, 20 Sep 2026 12:00:00 GMT", lambda: 0), 100)
        err = r.urllib.error.HTTPError("https://pub.dev/x", 429, "limited", {"Retry-After": "120"}, None)
        with patch.object(r.urllib.request, "urlopen", side_effect=err):
            with self.assertRaises(RuntimeError):
                r.http("https://pub.dev/x", self.out, "missing", upstream=True)
        err.close()
        self.assertGreater(r.read(self.out / "http-state.json")["resume_after"], r.time.time() + 100)

    def test_sql_injection_and_repo_output_rejected(self):
        with self.assertRaises(ValueError): r.names_sql(["a'; DELETE FROM runs"])
        (self.out / ".git").mkdir()
        with self.assertRaises(ValueError): r.outside_repo(self.out / "data")

    def test_readme_parser_excludes_sidebar_and_scripts(self):
        html = '<section class="detail-tab-readme"><p>Open Telegram</p><script>ignore</script></section><aside>Shares lockfile</aside>'
        self.assertEqual(r.clean_readme(html), "Open Telegram")
        with self.assertRaises(ValueError): r.clean_readme("not a README")

    def test_snippet_bound(self):
        self.assertLessEqual(len(r.snippets("open\n" * 10000)), 4000)


if __name__ == "__main__": unittest.main()
