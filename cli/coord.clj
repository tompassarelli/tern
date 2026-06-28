;; coord.clj — the ONE shared coordination substrate for the lodestar *-cli.clj
;; scripts (Foundation thread 019f100f Part B). Every CLI spoke the :7977 daemon
;; wire (:assert / :version / :retract / :resolved / :query) through a VERBATIM
;; copy of these helpers — 10 copies of send-op, 5 of assert!, 2 of retract!, and
;; ~11 single/multi resolved variants. One drift in any copy and the fleet's
;; coordination silently diverges. This is the single definition they all load.
;;
;; WRITE VERBS — cardinality-typed (move-C). The one global-version CAS ritual that
;; every assert! cargo-culted (read GLOBAL :version, pass it as the per-claim base,
;; retry) is GONE. It is replaced by three verbs whose choice is the predicate's
;; cardinality, NOT a base dance:
;;   append!  MULTI            one op, NO base, NO retry  — rival/disjoint writes
;;                             coexist (engine appends; identical is idempotent).
;;   put!     SINGLE  LWW      one op, NO base            — engine supersedes a
;;                             declared-single pred (last writer wins).
;;   swap!    SINGLE  CAS      base + retry  — the ONLY base+retry verb; opt-IN
;;                             conflict-detection for a genuine read-modify-write.
;; append!/put! pass NO :base, so the (now base-OPTIONAL) engine never staleness-
;; rejects them; only swap! threads a base. assert! survives as a thin alias to swap!
;; (byte-for-byte the old CAS behavior) for any un-migrated straggler.
;;
;; DUAL MODE (the schema-validate.clj precedent): load-file'd by a sibling CLI as a
;; library, OR run directly as a connectivity smoke. The main-guard keeps the CLI
;; dormant when another script loads us:
;;   bb cli/coord.clj <port>            -> prints the daemon's :version (a ping)
;; Load it sibling-relative so cwd never matters:
;;   (load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
;; then call lodestar.coord/send-op (or rebind the local names you use).
(ns lodestar.coord
  (:require [clojure.edn :as edn] [clojure.java.io :as io]))

;; The canonical coordinator port. The CLIs take <port> as argv[0]; PORT is the
;; default/canonical reference (Part C's pred-cli + future callers read it).
(def PORT (or (System/getenv "LODESTAR_PORT") "7977"))

;; one request/response over the daemon socket: write one EDN op + newline, read
;; one EDN reply line. The atom every other helper is built from.
(defn send-op [port op]
  (with-open [s (java.net.Socket. "127.0.0.1" (int port))]
    (let [w (.getOutputStream s) r (io/reader (.getInputStream s))]
      (.write w (.getBytes (str (pr-str op) "\n"))) (.flush w)
      (edn/read-string (.readLine r)))))

;; the daemon's current global version (only swap!/retract! read it now — the base).
(defn cur-ver [port] (:version (send-op port {:op :version})))

;; append! — MULTI cardinality: one wire op, NO base, NO retry. The engine appends
;; (rival/disjoint values coexist; an identical (te,p,r) is idempotent). The safe
;; coexist default. (str r) coerces defensively (callers already pass strings).
(defn append! [port te p r]
  (send-op port {:op :assert :te te :p p :r (str r)}))

;; put! — SINGLE last-writer-wins: one wire op, NO base. For a pred the engine has
;; declared single this SUPERSEDES the prior live value (LWW). Wire-identical to
;; append!; the cardinality CLAIM (engine-side) — not this verb — decides append-vs-
;; supersede, so the verb names the call site's INTENT. A no-base write is never
;; staleness-rejected (base-optional engine), which IS the LWW contract.
(defn put! [port te p r]
  (send-op port {:op :assert :te te :p p :r (str r)}))

;; swap! — SINGLE compare-and-swap: the ONLY base+retry verb. Reads the base, writes
;; under it, retries on :reject (a concurrent write moved the base). Reserve for a
;; genuine read-modify-write race; near-zero production callers after move-C. 4 tries.
(defn swap! [port te p r]
  (loop [tries 4]
    (let [res (send-op port {:op :assert :te te :p p :r (str r) :base (cur-ver port)})]
      (if (and (:reject res) (pos? tries)) (recur (dec tries)) res))))

;; thin migration alias — old assert! WAS the swap! CAS ritual; keep it pointing
;; there so any un-migrated caller is byte-for-byte unchanged.
(def assert! swap!)

(defn retract! [port te p r]
  (loop [tries 4]
    (let [res (send-op port {:op :retract :te te :p p :r (str r) :base (cur-ver port)})]
      (if (and (:reject res) (pos? tries)) (recur (dec tries)) res))))

;; single live value of (te,p)  (the resolved/one/rf variants collapse here).
(defn resolved [port te p] (:value (send-op port {:op :resolved :te te :p p})))
;; all live values of (te,p) — multi-valued  (the many/rmany variants).
(defn many     [port te p] (:values (send-op port {:op :resolved :te te :p p})))

;; ============================================================================
;; INCREMENTAL AGGREGATE — the completion DUAL of mutual exclusion.
;;
;; Roadmap tier F (quorum) + G (budget), decision 6: "EVERYTHING COUNTABLE IS A
;; FOLD OVER AN APPEND-ONLY LOG, NEVER A MUTATED CELL." Where mutual exclusion
;; REJECTS the second writer, completion ACCEPTS every writer and DERIVES the
;; answer by folding the log at READ time — so the completion half of
;; coordination needs no write-time convergence at all.
;;
;; ONE primitive, two reducers — the proof that quorum and budget are the same
;; shape seen through different folds:
;;   quorum = count-distinct(worker) >= K   — lodestar-map's K-of-N barrier
;;   budget = Σ(charge)              <  cap  — the swarm gate's spend ceiling
;; Both fold a monotone reducer over the rows a Datalog BODY binds against the
;; scan engine. Both are commutative and idempotent (set semantics collapse a
;; double-reported worker; Σ rides write-once @charge/@run subjects), so retry,
;; double-report, and racing writers all converge with ZERO coordination. Each
;; fold is a pure, recomputable function of the log prefix — never a cached cell
;; that can silently diverge from its own source (the two-budgets bug, killed at
;; the root). The total order earliest-cid that makes other derivations agree is
;; not even needed here: + and set-union are order-independent.

;; A REDUCER is {:init :step :final}: fold :step from :init over the rows, finalize.
;; The two production reducers — the only two coordination has ever needed:
(def distinct-reducer
  "Quorum reducer: union each row's first binding into a SET (a key seen twice
   counts once). Returns the set itself — callers count it or diff it for the
   missing members."
  {:init #{} :step (fn [s row] (conj s (first row))) :final identity})

(def sum-reducer
  "Budget reducer: Σ the numeric SECOND projection of each row (non-numeric -> 0).
   Rows MUST carry a distinct key in the FIRST position (the @run/@charge subject):
   the engine's derived head is a SET of tuples, so a value-only projection would
   collapse two equal-valued addends (two equal-cost runs) and UNDER-count. The key
   keeps equal values distinct — the exact dual of count-distinct, which WANTS the
   collapse. This asymmetry is why Σ projects [key val] and count-distinct [key]."
  {:init 0 :step (fn [n row] (+ n (or (parse-double (str (second row))) 0))) :final identity})

;; The rows a Datalog BODY binds, projected onto PROJECT (the head vars). One
;; scan-engine query; a 1- or 2-literal body routes to the join engine (q/run).
(defn agg-rows [port project body]
  (:ok (send-op port {:op :query
                      :query {:find "agg"
                              :rules [{:head {:rel "agg" :args (mapv (fn [v] {:var v}) project)}
                                       :body body}]}})))

;; THE primitive. Quorum and budget are THIS fn with a different reducer — that
;; identity is the whole point. Pure read; recomputable from the log.
(defn aggregate [port project body {:keys [init step final]}]
  (final (reduce step init (agg-rows port project body))))

;; --- named folds (each reducer, applied) ------------------------------------
(defn distinct-of
  "The SET of distinct PROJECT values BODY binds (count-distinct, set form)."
  [port project body] (aggregate port project body distinct-reducer))
(defn count-distinct
  "K-of-N quorum's left side: how many DISTINCT keys BODY binds."
  [port project body] (count (distinct-of port project body)))
(defn sum-of
  "Σ of a numeric projection over BODY. PROJECT must be [key-var val-var]: the key
   (the @run/@charge subject) keeps equal values distinct so they are not deduped
   away; the val is summed. The budget/spend fold."
  [port project body] (aggregate port project body sum-reducer))

;; --- gates (a gate is just a threshold predicate over a fold) ---------------
(defn quorum-met?
  "True once ≥ K distinct keys have appeared — the barrier has FIRED. Monotone:
   never un-fires while completion predicates are irretractable (see roadmap F↔H)."
  [port k project body] (>= (count-distinct port project body) k))

(defn -main [& args]
  (let [port (Integer/parseInt (or (first args) PORT))]
    (prn (send-op port {:op :version}))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
