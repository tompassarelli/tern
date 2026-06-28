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

(defn -main [& args]
  (let [port (Integer/parseInt (or (first args) PORT))]
    (prn (send-op port {:op :version}))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
