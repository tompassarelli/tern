;; board_active_test.clj — the curated board's ACTIVE-honesty filter (driver-live?).
;; A `driver` fact is never retired, so classify calls every historical pickup
;; "active". board-curated partitions on DERIVED liveness, combining two honest
;; signals in preference order:
;;   (a) AGENT presence lease — @lease:session:<handle> exp still in the future
;;       (the SAME renewable-lease rule concern-cli/coord.clj `online?` uses).
;;   (b) RECENCY fallback — `updated_at` within NORTH_DRIVER_STALE_DAYS (default 14).
;; Asserts: fresh lease => live; expired lease falls through to recency; a human
;; (no lease) rides recency; stale on both axes => parked; no driver => not-active;
;; a garbage updated_at never crashes.
;;   bb -cp out:../fram/out board_active_test.clj      (run from the repo root)
(require '[fram.kernel :as k] '[north.main :as m] '[fram.rt :as rt])

;; A fixed "now" pinned to a real ISO datetime so the runtime date helpers agree.
(def now-str "2026-07-09T12:00:00")
(def now-secs (rt/iso-to-seconds now-str))
(def window (* 14 86400))                 ; NORTH_DRIVER_STALE_DAYS default

(defn lease-val [exp-secs] (str "sess|" (* exp-secs 1000) "|0"))
(def fresh-exp   (+ now-secs 1800))       ; +30m -> live lease
(def expired-exp (- now-secs 1800))       ; -30m -> lapsed lease

(def facts
  [;; @live-lease — agent driver holding a FRESH lease -> live (lease path)
   (k/->Fact "@live-lease" "title" "live via lease") (k/->Fact "@live-lease" "driver" "@ag-live")
   (k/->Fact "@lease:session:ag-live" "lease" (lease-val fresh-exp))
   ;; @lapsed-recent — lease EXPIRED but thread updated today -> live (recency rescue)
   (k/->Fact "@lapsed-recent" "title" "lapsed but recent") (k/->Fact "@lapsed-recent" "driver" "@ag-lapsed")
   (k/->Fact "@lease:session:ag-lapsed" "lease" (lease-val expired-exp))
   (k/->Fact "@lapsed-recent" "updated_at" "2026-07-08")
   ;; @human-recent — human driver, NO lease, updated 3 days ago -> live (recency)
   (k/->Fact "@human-recent" "title" "human recent") (k/->Fact "@human-recent" "driver" "@tom")
   (k/->Fact "@human-recent" "updated_at" "2026-07-06")
   ;; @human-stale — human driver, NO lease, updated in MAY -> parked
   (k/->Fact "@human-stale" "title" "human stale") (k/->Fact "@human-stale" "driver" "@tom")
   (k/->Fact "@human-stale" "updated_at" "2026-05-28")
   ;; @no-signal — driver, no lease, no updated_at -> parked
   (k/->Fact "@no-signal" "title" "no signal") (k/->Fact "@no-signal" "driver" "@ghost")
   ;; @no-driver — no driver fact at all -> not active
   (k/->Fact "@no-driver" "title" "no driver")
   ;; @garbage-ts — driver, no lease, unparseable updated_at -> parked (no crash)
   (k/->Fact "@garbage-ts" "title" "garbage ts") (k/->Fact "@garbage-ts" "driver" "@tom")
   (k/->Fact "@garbage-ts" "updated_at" "not-a-date")
   ;; boundary bracket (now = 2026-07-09T12:00, window 14d => cutoff 2026-06-25T12:00):
   ;; @edge-in updated 2026-06-26 (inside) -> live; @edge-out 2026-06-24 (outside) -> parked
   (k/->Fact "@edge-in" "title" "edge in") (k/->Fact "@edge-in" "driver" "@tom")
   (k/->Fact "@edge-in" "updated_at" "2026-06-26")
   (k/->Fact "@edge-out" "title" "edge out") (k/->Fact "@edge-out" "driver" "@tom")
   (k/->Fact "@edge-out" "updated_at" "2026-06-24")])

(def idx (k/build-index facts))
(defn live? [te] (#'m/driver-live? idx te now-secs window))

(def cases
  [["fresh lease => live"            (live? "@live-lease")     true]
   ["expired lease + recent => live" (live? "@lapsed-recent")  true]
   ["human recent => live"           (live? "@human-recent")   true]
   ["human stale (May) => parked"    (live? "@human-stale")    false]
   ["no lease + no updated_at => parked" (live? "@no-signal")  false]
   ["no driver => not active"        (live? "@no-driver")      false]
   ["garbage updated_at => parked"   (live? "@garbage-ts")     false]
   ["inside 14d window (2026-06-26) => live"  (live? "@edge-in")  true]
   ["outside 14d window (2026-06-24) => parked" (live? "@edge-out") false]])

(def fails (filter (fn [[_ got want]] (not= got want)) cases))
(doseq [[nm got want] cases]
  (println (if (= got want) "  ok  " " FAIL ") nm "=> got" got))
(if (seq fails)
  (do (println "\nboard-active:" (count fails) "FAILED") (System/exit 1))
  (println "\nboard-active: all" (count cases) "passed"))
