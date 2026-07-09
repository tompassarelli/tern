;; lease-cli.clj — agent-side North lease helper (P0 shadow).
;; Speaks the daemon lease WIRE verbs (b619283): :acquire-lease / :release-lease / :fence-ok / :status.
;; This is the contract every agent session uses to take the build mutex over the socket
;; INSTEAD of dropping a per-agent BUILD-LOCK-<agent>.md lockfile.
;;
;; usage:
;;   bb lease-cli.clj <port> acquire <res> <holder> <ttl-ms>
;;   bb lease-cli.clj <port> release <res> <holder>
;;   bb lease-cli.clj <port> fence   <res> <holder> <epoch>
;;   bb lease-cli.clj <port> status
(require '[clojure.edn :as edn] '[clojure.java.io :as io])

;; shared coord substrate (Foundation Part B): send-op lives once in cli/coord.clj.
(load-file (str (.getParent (io/file (System/getProperty "babashka.file"))) "/coord.clj"))
(def send-op north.coord/send-op)

(let [[port verb & args] *command-line-args*
      port (Integer/parseInt port)
      op (case verb
           "acquire" {:op :acquire-lease :res (nth args 0) :holder (nth args 1) :ttl-ms (Integer/parseInt (nth args 2))}
           "release" {:op :release-lease :res (nth args 0) :holder (nth args 1)}
           "fence"   {:op :fence-ok :res (nth args 0) :holder (nth args 1) :epoch (Integer/parseInt (nth args 2))}
           "status"  {:op :status}
           (do (println "unknown verb:" verb) (System/exit 2)))]
  (prn (send-op port op)))
