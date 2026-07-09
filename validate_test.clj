;; validate_test.clj — north's WORK-semantics integrity rules, lifted out of
;; the fram kernel into north.validate: a depends_on edge to a withdrawn
;; (abandoned) thread, and person-ref integrity (lead/driver/proposed_by must
;; point at a node carrying a `display_name`). Plus: north.validate composes
;; these ON TOP of the engine's generic rules (cycles/dangling), so violations-i
;; surfaces both. (The generic half is covered in fram/tests/kernel_violations_test.clj.)
;;   bb -cp out:$FRAM/out validate_test.clj      (run from the repo root)
(require '[fram.kernel :as k] '[north.validate :as val])

(defn idx-of [facts] (k/build-index facts))
(defn has? [v sub] (some #(clojure.string/includes? % sub) v))
(defn wv [facts te] (val/work-violations-i (idx-of facts) te))

;; @p is a person (display_name). @w1 lead @p resolves cleanly.
(def ok-facts
  [(k/->Fact "@p" "display_name" "Tom")
   (k/->Fact "@w1" "title" "W1")
   (k/->Fact "@w1" "lead" "@p")])

;; @w2 driver @ghost — @ghost has no display_name => dangling person ref.
(def ghost-facts
  [(k/->Fact "@p" "display_name" "Tom")
   (k/->Fact "@w2" "title" "W2")
   (k/->Fact "@w2" "driver" "@ghost")])

;; @w3 proposed_by @p (ok) + @ghost (dangling) — only @ghost flags.
(def proposed-facts
  [(k/->Fact "@p" "display_name" "Tom")
   (k/->Fact "@w3" "title" "W3")
   (k/->Fact "@w3" "proposed_by" "@p")
   (k/->Fact "@w3" "proposed_by" "@ghost")])

;; @w4 (open) depends_on @dead; @dead is abandoned => points-at-abandoned.
(def abandoned-facts
  [(k/->Fact "@w4" "title" "W4")
   (k/->Fact "@dead" "title" "DEAD")
   (k/->Fact "@dead" "abandoned" "2026-01-01")
   (k/->Fact "@w4" "depends_on" "@dead")])

;; a RESOLVED thread's stale dep is NOT flagged (term? short-circuits).
(def abandoned-terminal
  [(k/->Fact "@w4" "title" "W4")
   (k/->Fact "@w4" "outcome" "shipped")
   (k/->Fact "@dead" "title" "DEAD")
   (k/->Fact "@dead" "abandoned" "2026-01-01")
   (k/->Fact "@w4" "depends_on" "@dead")])

;; composition: full violations-i = engine-generic ++ north-work.
(def mixed-facts
  [(k/->Fact "@w5" "title" "W5")
   (k/->Fact "@w5" "driver" "@ghost")
   (k/->Fact "@w5" "depends_on" "@missing")])

(def checks
  [["lead -> named person => no person violation"
    (not (has? (wv ok-facts "@w1") "references unknown person"))]
   ["driver -> ghost => 'driver references unknown person @ghost'"
    (has? (wv ghost-facts "@w2") "driver references unknown person @ghost")]
   ["proposed_by -> named clean, ghost flags"
    (and (has? (wv proposed-facts "@w3") "proposed_by references unknown person @ghost")
         (not (has? (wv proposed-facts "@w3") "references unknown person @p")))]
   ["depends_on -> abandoned flagged for an OPEN thread"
    (has? (wv abandoned-facts "@w4") "depends_on points at abandoned @dead")]
   ["depends_on -> abandoned NOT flagged for a RESOLVED thread"
    (not (has? (wv abandoned-terminal "@w4") "points at abandoned"))]
   ["full validate composes generic ++ work"
    (let [vs (val/violations-i (idx-of mixed-facts) "@w5")]
      (and (has? vs "depends_on references missing entity @missing")
           (has? vs "driver references unknown person @ghost")))]])

(let [fails (remove second checks)]
  (doseq [[nm ok] checks] (println (if ok "  [PASS] " "  [FAIL] ") nm))
  (if (empty? fails)
    (println "\nnorth.validate:" (count checks) "/" (count checks) "PASS")
    (do (println "\nnorth.validate:" (count fails) "FAILED") (System/exit 1))))
