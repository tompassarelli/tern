;; inbox-peek.clj — fast, quiet mail heartbeat for the PostToolUse hook.
;; Usage: bb inbox-peek.clj <port> <agent-id>
;; Find unacked messages for <agent-id> (to∈{id,"*"} AND id NOT in acked_by), print each
;; readable, then ACK each (acked_by + acked_at) so it's delivered exactly once and never
;; re-surfaces. No unacked mail => print NOTHING, exit 0. Standalone: helper fns copied
;; verbatim from msg-cli.clj (send-op/append!/put!/one/many/messages/for-me?).
(require '[clojure.edn :as edn] '[clojure.java.io :as io])

;; shared coord substrate: cardinality-typed write verbs (move-C) live once in
;; cli/coord.clj. append! = MULTI coexist; put! = SINGLE last-writer-wins.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op north.coord/send-op)
(def append! north.coord/append!)
(def put!    north.coord/put!)
(def one     north.coord/resolved)
(def many    north.coord/many)

(defn messages [port]      ; -> [[@msg-entity to-handle] ...]  (every entity carrying a `to`)
  (:ok (send-op port {:op :query
                      :query {:find "m"
                              :rules [{:head {:rel "m" :args [{:var "e"} {:var "to"}]}
                                       :body [{:rel "triple" :args [{:var "e"} "to" {:var "to"}]}]}]}})))

(defn for-me? [to me] (or (= to me) (= to "*")))

(let [[port me] *command-line-args*
      port (Integer/parseInt port)]
  (doseq [[e to] (sort (or (messages port) []))]
    (when (and (for-me? to me) (not (contains? (set (many port e "acked_by")) me)))
      (let [from (or (one port e "from") "?")
            subj (or (one port e "subject") "")
            body (or (one port e "body") "")]
        (println (str "✉ from " from " — " subj))
        (println (str "  " body))
        ;; Flush before the first ack side effect. The PostToolUse caller has a
        ;; hard deadline: if an ack blocks and the helper is terminated, the
        ;; complete message is already in its pipe and can still be delivered;
        ;; an uncommitted ack merely makes it repeat on the next hook.
        (flush)
        ;; ack last: print delivers, then mark so it never re-surfaces (exactly-once on success)
        (append! port e "acked_by" me)                            ; multi (many ackers)
        (put!    port e "acked_at" (str (java.time.Instant/now))))))) ; single
