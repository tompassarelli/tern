;; claim-cli.clj <port> {claim|release|status} <thread> [holder]
;; Atomic work-claiming WITHOUT a lease (thread 019f100f-eefe). The @lease:<thread>
;; work-claim lease is DELETED: driving a thread is GRAPH-INTERNAL, so it collapses onto
;; DECLARED-SINGLE — `driver` is a single-valued cardinality claim, and the engine's own
;; per-(subject,predicate) base-version reject IS the mutual exclusion. Two agents racing
;; to drive the SAME thread both pass the empty-group base (0); the writer serialized first
;; wins, the second's now-stale base is rejected (:conflict). No @lease:, no epoch/ttl — a
;; stuck driver is force-released (release) or reclaimed by derived liveness (thread G).
;; acquire-lease!/lease-cli survive ONLY for EXTERNAL resources (build dir / external API),
;; never a graph-internal subject like @lease:<thread>.
(require '[clojure.edn :as edn] '[clojure.java.io :as io])

;; shared coord substrate (Foundation Part B): send-op lives once in cli/coord.clj.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op tern.coord/send-op)

(defn- driver-of [port thread]
  (:value (send-op port {:op :resolved :te thread :p "driver"})))

(let [[ps verb & args] *command-line-args*
      port (Integer/parseInt ps)]
  (case verb
    "claim"                              ; <thread> <holder> — declared-single driver claim
    (let [[thread holder] args
          me  (str "@" holder)
          cur (driver-of port thread)]
      (cond
        (= cur me)                       ; already mine — idempotent re-drive, no write
        (println (format "CLAIMED %s by %s (already held)" thread holder))

        (some? cur)                      ; driven by someone else — read-check denial
        (do (println (format "DENIED %s — driven by %s" thread cur)) (System/exit 1))

        :else                            ; undriven: assert with the empty-group base (0).
        ;; Concurrent racers both pass base 0; the engine commits the first and rejects the
        ;; second (bv > 0). The OCC reject IS the lock — no lease.
        (let [r (send-op port {:op :assert :te thread :p "driver" :r me :base 0})]
          (if (:reject r)
            (do (println (format "DENIED %s — lost the race (driver=%s)" thread (driver-of port thread)))
                (System/exit 1))
            (println (format "CLAIMED %s by %s" thread holder))))))

    "release"                            ; <thread> <holder> — only the live driver may release
    (let [[thread holder] args
          me  (str "@" holder)
          cur (driver-of port thread)]
      (if (= cur me)
        (let [v (:version (send-op port {:op :version}))]
          (send-op port {:op :retract :te thread :p "driver" :r me :base v})
          (println (format "released %s by %s" thread holder)))
        (println (format "noop %s — not driven by %s (driver=%s)" thread holder (or cur "(none)")))))

    "status"                             ; <thread> — who drives it (coexist-elected single driver)
    (let [[thread] args]
      (println (format "%s driver=%s" thread (or (driver-of port thread) "(none)"))))

    (do (println "usage: claim-cli.clj <port> {claim|release|status} <thread> [holder]") (System/exit 2))))
