(load-file "cli/dashboard-cli.clj")
(require '[clojure.java.io :as io] '[clojure.edn :as edn])

(defn fail! [message]
  (binding [*out* *err*] (println "FAIL" message))
  (System/exit 1))

(cache-put! "probe.edn" {:ok true})
(def probe-file (io/file CACHE-DIR (str CACHE-SCOPE "-probe.edn")))

;; A future cache timestamp is invalid, never fresh.
(spit probe-file (pr-str {:ts (+ (System/currentTimeMillis) 60000) :val {:poison true}}))
(when (cache-get "probe.edn" 300000) (fail! "future cache timestamp was accepted"))

;; Nonzero concern probes must not become a cached empty-success result.
(let [concern-file (io/file CACHE-DIR (str CACHE-SCOPE "-concerns.edn"))]
  (.delete concern-file)
  (let [result (with-redefs [run (fn [& _] {:out "" :err "boom" :exit 1 :ok false})]
                 (concern-rows))]
    (when-not (:err result) (fail! "failed concern probe was treated as success"))
    (when (.exists concern-file) (fail! "failed concern probe was cached"))))

;; Java owner-only permission probes are stable across POSIX hosts.
(let [perms (java.nio.file.Files/getPosixFilePermissions
              (.toPath probe-file)
              (make-array java.nio.file.LinkOption 0))
      names (set (map str perms))]
  (when-not (= names #{"OWNER_READ" "OWNER_WRITE"})
    (fail! (str "cache permissions are not 0600: " names))))
(println "dashboard-cache: passed")
