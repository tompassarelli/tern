;; capture_test.clj — the UUIDv7-handle model on the capture path:
;;   (1) capture mints a UUIDv7 id (an opaque, version-7 uuid — NOT the old
;;       @yyyy-MM-dd-HHmmss timestamp scheme), and
;;   (2) asserts an explicit full-ISO `created_at` claim (now-iso) at birth, while
;;   (3) `resolve-ref` maps a @handle (or @id) ref to the canonical @id, latest
;;       created_at winning ties — the boundary fram never sees a handle through.
;;   bb -cp out:../fram/out capture_test.clj      (run from the repo root)
(require '[fram.kernel :as k] '[lodestar.main :as m] '[clojure.string :as str])

;; --- (1) uuidv7: a real version-7 uuid, not a date --------------------------
(def uuid-re #"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
(def date-id-re #"^\d{4}-\d{2}-\d{2}-\d{6}$")   ; the old fram.rt/now-id shape
(def u1 (m/uuidv7))
(def _gap (Thread/sleep 5))
(def u2 (m/uuidv7))

;; --- (2) created_at present + full-ISO via capture-claims (private) ----------
(def cap (#'m/capture-claims "@t1" "Test thread" "personal" "self" "" "" ""
                             "2026-06-28T07:00:00" "2026-06-28"))
(defn claim-val [claims pred] (:r (first (filter #(= (:p %) pred) claims))))

;; --- (3) resolve-ref: handle -> canonical id (latest created_at wins) --------
(def rc
  [(k/->Claim "@id-old" "title" "Old perf")
   (k/->Claim "@id-old" "handle" "perf")
   (k/->Claim "@id-old" "created_at" "2026-06-01T10:00:00")
   (k/->Claim "@id-new" "title" "New perf")
   (k/->Claim "@id-new" "handle" "perf")
   (k/->Claim "@id-new" "created_at" "2026-06-28T10:00:00")
   (k/->Claim "@solo" "title" "Solo")])
(def ridx (k/build-index rc))

(def checks
  [["uuidv7 is a version-7 uuid"                 (boolean (re-matches uuid-re u1))]
   ["uuidv7 is NOT the old date-id scheme"       (nil? (re-matches date-id-re u1))]
   ["uuidv7 parses as a UUID, version 7"         (= 7 (.version (java.util.UUID/fromString u1)))]
   ["uuidv7 ids are distinct"                    (not= u1 u2)]
   ["uuidv7 is k-sortable (earlier < later)"     (neg? (compare u1 u2))]
   ["capture asserts a created_at claim"         (some? (claim-val cap "created_at"))]
   ["created_at is the full-ISO now-iso value"   (= "2026-06-28T07:00:00" (claim-val cap "created_at"))]
   ["created_at (full-ISO) differs from committed (date)"
    (not= (claim-val cap "created_at") (claim-val cap "committed"))]
   ["resolve @handle -> latest-created canonical id"   (= "@id-new" (m/resolve-ref ridx "@perf"))]
   ["resolve bare handle (no @) also resolves"         (= "@id-new" (m/resolve-ref ridx "perf"))]
   ["resolve real @id is passthrough"                  (= "@id-old" (m/resolve-ref ridx "@id-old"))]
   ["resolve titled-but-handleless id is passthrough"  (= "@solo" (m/resolve-ref ridx "@solo"))]
   ["resolve unknown ref is unchanged"                 (= "@ghost" (m/resolve-ref ridx "@ghost"))]])

(let [fails (remove second checks)]
  (doseq [[nm ok] checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\ncapture:" (count checks) "/" (count checks) "PASS")
    (do (println "\ncapture:" (count fails) "FAILED") (System/exit 1))))
