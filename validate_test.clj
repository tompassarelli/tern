;; validate_test.clj — tern's WORK-semantics integrity rules, lifted out of
;; the fram kernel into tern.validate: a depends_on edge to a withdrawn
;; (abandoned) thread, and person-ref integrity (lead/driver/proposed_by must
;; point at a node carrying a `display_name`). Plus: tern.validate composes
;; these ON TOP of the engine's generic rules (cycles/dangling), so violations-i
;; surfaces both. (The generic half is covered in fram/tests/kernel_violations_test.clj.)
;;   bb -cp out:$FRAM/out validate_test.clj      (run from the repo root)
(require '[fram.kernel :as k] '[tern.validate :as val])

(defn idx-of [claims] (k/build-index claims))
(defn has? [v sub] (some #(clojure.string/includes? % sub) v))
(defn wv [claims te] (val/work-violations-i (idx-of claims) te))

;; @p is a person (display_name). @w1 lead @p resolves cleanly.
(def ok-claims
  [(k/->Claim "@p" "display_name" "Tom")
   (k/->Claim "@w1" "title" "W1")
   (k/->Claim "@w1" "lead" "@p")])

;; @w2 driver @ghost — @ghost has no display_name => dangling person ref.
(def ghost-claims
  [(k/->Claim "@p" "display_name" "Tom")
   (k/->Claim "@w2" "title" "W2")
   (k/->Claim "@w2" "driver" "@ghost")])

;; @w3 proposed_by @p (ok) + @ghost (dangling) — only @ghost flags.
(def proposed-claims
  [(k/->Claim "@p" "display_name" "Tom")
   (k/->Claim "@w3" "title" "W3")
   (k/->Claim "@w3" "proposed_by" "@p")
   (k/->Claim "@w3" "proposed_by" "@ghost")])

;; @w4 (open) depends_on @dead; @dead is abandoned => points-at-abandoned.
(def abandoned-claims
  [(k/->Claim "@w4" "title" "W4")
   (k/->Claim "@dead" "title" "DEAD")
   (k/->Claim "@dead" "abandoned" "2026-01-01")
   (k/->Claim "@w4" "depends_on" "@dead")])

;; a RESOLVED thread's stale dep is NOT flagged (term? short-circuits).
(def abandoned-terminal
  [(k/->Claim "@w4" "title" "W4")
   (k/->Claim "@w4" "outcome" "shipped")
   (k/->Claim "@dead" "title" "DEAD")
   (k/->Claim "@dead" "abandoned" "2026-01-01")
   (k/->Claim "@w4" "depends_on" "@dead")])

;; composition: full violations-i = engine-generic ++ tern-work.
(def mixed-claims
  [(k/->Claim "@w5" "title" "W5")
   (k/->Claim "@w5" "driver" "@ghost")
   (k/->Claim "@w5" "depends_on" "@missing")])

(def checks
  [["lead -> named person => no person violation"
    (not (has? (wv ok-claims "@w1") "references unknown person"))]
   ["driver -> ghost => 'driver references unknown person @ghost'"
    (has? (wv ghost-claims "@w2") "driver references unknown person @ghost")]
   ["proposed_by -> named clean, ghost flags"
    (and (has? (wv proposed-claims "@w3") "proposed_by references unknown person @ghost")
         (not (has? (wv proposed-claims "@w3") "references unknown person @p")))]
   ["depends_on -> abandoned flagged for an OPEN thread"
    (has? (wv abandoned-claims "@w4") "depends_on points at abandoned @dead")]
   ["depends_on -> abandoned NOT flagged for a RESOLVED thread"
    (not (has? (wv abandoned-terminal "@w4") "points at abandoned"))]
   ["full validate composes generic ++ work"
    (let [vs (val/violations-i (idx-of mixed-claims) "@w5")]
      (and (has? vs "depends_on references missing entity @missing")
           (has? vs "driver references unknown person @ghost")))]])

(let [fails (remove second checks)]
  (doseq [[nm ok] checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\ntern.validate:" (count checks) "/" (count checks) "PASS")
    (do (println "\ntern.validate:" (count fails) "FAILED") (System/exit 1))))
