;; concern-cli.clj — CONCERN-level coordination for parallel agents. NOT locks.
;;
;; An agent declares a CONCERN: a feature it is building + the footprint it touches.
;; Concerns COEXIST — declaring never blocks anyone. Overlap is DERIVED from shared
;; footprint and surfaced, so agents shape around each other and against what is
;; LIKELY TO LAND (before it is in main). This is the claim graph paying off:
;; coordination = shared awareness, not a lock manager. N agents, one repo, fine.
;;
;; usage (port = lodestar board, 7977):
;;   declare <agent> <repo> "<intent>" <file,file,...>   mint a concern (+ shows overlaps)
;;   overlap <concern-id>                                 who else touches my footprint
;;   shape   <concern-id>                                 likely-to-land work in my area — build against it
;;   ls [<repo>]                                          active concerns
;;   status  <concern-id> <exploring|building|likely-to-land|landed>
;;   done    <concern-id>                                 mark landed
(require '[clojure.edn :as edn] '[clojure.java.io :as io] '[clojure.string :as str]
         '[clojure.set :as set])

;; shared coord substrate: the cardinality-typed write verbs (move-C) live once in
;; cli/coord.clj. append! = MULTI coexist; put! = SINGLE last-writer-wins.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op  lodestar.coord/send-op)
(def append!  lodestar.coord/append!)
(def put!     lodestar.coord/put!)
(def retract! lodestar.coord/retract!)
(def resolved lodestar.coord/resolved)

;; one-column datalog query: bind ?e in `body`, return the column
(defn q-col [port body]
  (->> (:ok (send-op port {:op :query
                           :query {:find "e"
                                   :rules [{:head {:rel "e" :args [{:var "e"}]} :body body}]}}))
       (map first)))

;; LWW for a semantically-single but engine-MULTI predicate (status): the engine
;; would APPEND a bare write, so supersede EXPLICITLY — clear every current value,
;; then put! the new one. (Once status is folded into the engine's cardinality CLAIM
;; — thread B — a bare put! supersedes natively and this retract loop drops out.)
(defn set-single! [port c p v]
  (doseq [old (q-col port [{:rel "triple" :args [c p {:var "e"}]}])]
    (retract! port c p old))
  (put! port c p v))

(defn all-concerns [port]
  (distinct (q-col port [{:rel "triple" :args [{:var "e"} "kind" "concern"]}])))

(defn touches-of [port c]
  (set (q-col port [{:rel "triple" :args [c "touches" {:var "e"}]}])))

(defn meta-of [port c]
  {:id c
   :agent (resolved port c "agent")
   :repo (resolved port c "repo")
   :intent (resolved port c "intent")
   :status (or (resolved port c "status") "?")
   :touches (touches-of port c)})

(defn fmt [m]
  (format "  %-12s %-14s %-10s {%s}\n     ↳ %s  (%s)"
          (or (:agent m) "?") (or (:status m) "?") (or (:repo m) "?")
          (str/join " " (sort (:touches m))) (or (:intent m) "") (:id m)))

(defn surface [port c statuses none-msg]
  (let [mine (:touches (meta-of port c))
        hits (->> (all-concerns port)
                  (remove #(= % c))
                  (map #(meta-of port %))
                  (remove #(= (:status %) "landed"))
                  (filter #(seq (set/intersection mine (:touches %))))
                  (filter #(or (nil? statuses) (statuses (:status %)))))]
    (if (empty? hits)
      (println (str "  (none) — " none-msg " {" (str/join " " (sort mine)) "}"))
      (doseq [m hits]
        (println (fmt m))
        (println (str "       SHARES: " (str/join " " (sort (set/intersection mine (:touches m))))))))))

(let [[ps verb & args] *command-line-args*
      port (Integer/parseInt ps)]
  (case verb
    "declare"
    (let [[agent repo intent files] args
          fs (->> (str/split (or files "") #",") (map str/trim) (remove str/blank?))
          id (str "concern-" (System/currentTimeMillis) "-" (subs (str (java.util.UUID/randomUUID)) 0 4))]
      (put! port id "title"  (str "[" repo "] " intent))   ; single
      (put! port id "kind"   "concern")                    ; single
      (put! port id "agent"  (str "@" agent))              ; single
      (put! port id "driver" (str "@" agent))              ; single (engine) — board visibility: active work
      (put! port id "repo"   repo)                         ; single
      (put! port id "intent" intent)                       ; single
      (set-single! port id "status" "building")
      (doseq [f fs] (append! port id "touches" f))         ; multi
      (println (str "✓ concern " id))
      (println (str "  @" agent "  building  [" repo "]  touches {" (str/join " " fs) "}"))
      (println "\nOverlapping concerns — coordinate, you are NOT blocked:")
      (surface port id nil "no other concern touches your footprint")
      (println (str "\n  next: `concern shape " id "` to build against likely-to-land work;"
                    "  `concern status " id " likely-to-land` as you near merge.")))

    "overlap"
    (let [[c] args]
      (println (str "Concerns overlapping " c " (any status):"))
      (surface port c nil "nothing else touches your footprint"))

    "shape"
    (let [[c] args]
      (println "LIKELY-TO-LAND work in your footprint — shape your feature against these:")
      (surface port c #{"likely-to-land"} "no likely-to-land work touches your footprint yet"))

    "ls"
    (let [[repo] args
          ms (->> (all-concerns port) (map #(meta-of port %))
                  (remove #(= (:status %) "landed"))
                  (filter #(or (nil? repo) (= (:repo %) repo)))
                  (sort-by :repo))]
      (println (str "ACTIVE CONCERNS" (when repo (str " in " repo)) " — " (count ms)))
      (doseq [m ms] (println (fmt m))))

    "status"
    (let [[c st] args]
      (set-single! port c "status" st)
      (println (str "✓ " c " status=" st)))

    "done"
    (let [[c] args]
      (set-single! port c "status" "landed")
      (println (str "✓ " c " landed")))

    (do (println "usage: concern-cli.clj <port> {declare <agent> <repo> \"<intent>\" <files,> | overlap <id> | shape <id> | ls [repo] | status <id> <st> | done <id>}")
        (System/exit 2))))
