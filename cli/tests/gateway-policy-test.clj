#!/usr/bin/env bb
;; Pure regression for the gateway's untrusted-registry and corpus-fence boundary.
(require '[clojure.edn :as edn]
         '[clojure.java.io :as io]
         '[north.gatepolicy :as gp])

(def checks (atom []))
(defn check [label ok?] (swap! checks conj [label (boolean ok?)]))

(let [tenant (gp/parse-tenant
              "acme"
              {:coordinator-host "coordinator-acme"
               :coordinator-port 7801
               :coordinator-log "/srv/north/tenants/acme/facts.log"})]
  (check "valid absolute tenant route parses"
         (and (= "acme" (:tid tenant))
              (= 7801 (:port tenant))
              (= "/srv/north/tenants/acme/facts.log" (:log tenant))))
  (check "fence carries the registry-owned corpus"
         (= {:op :for-log
             :expected-log "/srv/north/tenants/acme/facts.log"
             :request {:op :version}}
            (gp/fenced-request tenant {:op :version})))
  (check "response format is preserved on the outer envelope"
         (= :json
            (:fmt (gp/fenced-request tenant {:op :version :fmt :json})))))

(doseq [[label cfg]
        [["non-string log"
          {:coordinator-port 7801 :coordinator-log 42}]
         ["relative log"
          {:coordinator-port 7801 :coordinator-log "facts.log"}]
         ["string port"
          {:coordinator-port "7801" :coordinator-log "/tmp/facts.log"}]
         ["out-of-range port"
          {:coordinator-port 70000 :coordinator-log "/tmp/facts.log"}]
         ["non-string host"
          {:coordinator-host 42 :coordinator-port 7801 :coordinator-log "/tmp/facts.log"}]]]
  (check (str "malformed registry rejects " label)
         (nil? (gp/parse-tenant "bad" cfg))))

(check "client-authored fence is rejected"
       (not (gp/valid-op? {:op :for-log :expected-log "/tmp/other"})))
(check "ordinary inner operation is accepted"
       (gp/valid-op? {:op :version :fmt :json}))
(check "exact EDN parser accepts one request form"
       (= {:op :version} (gp/parse-exact-edn "{:op :version}\n")))
(check "exact EDN parser rejects trailing request data"
       (nil? (gp/parse-exact-edn "{:op :version} junk")))
(let [nested (str (apply str (repeat 20000 "["))
                  "0"
                  (apply str (repeat 20000 "]")))]
  (check "byte-bounded deeply nested EDN stays inside the parser boundary"
         (try
           (do (gp/parse-exact-edn nested) true)
           (catch Throwable _ false))))
(letfn [(exhaust [] (exhaust))]
  (check "parser StackOverflow is normalized to invalid"
         (nil?
          (with-redefs [edn/read (fn [_] (exhaust))]
            (gp/parse-exact-edn "0")))))
(check "EDN wrong-log response is a protocol mismatch"
       (= "log-mismatch"
          (gp/protocol-status "{:reject [\"wrong log\"] :code :log-mismatch}")))
(check "JSON wrong-log response is a protocol mismatch"
       (= "log-mismatch"
          (gp/protocol-status "{\"reject\":[\"wrong log\"],\"code\":\"log-mismatch\"}")))
(check "pre-fence daemon unknown-op response is a protocol error"
       (= "protocol-error" (gp/protocol-status "{:error \"unknown op\"}")))
(check "strict raw-wire rejection is a protocol error"
       (= "protocol-error"
          (gp/protocol-status "{:reject [\"fence required\"] :code :log-fence-required}")))
(check "successful EDN payload text cannot spoof a protocol error"
       (= "ok"
          (gp/protocol-status
           "{:ok {:message \"unknown op :log-mismatch log-fence-required\"}}")))
(check "successful JSON payload text cannot spoof a protocol error"
       (= "ok"
          (gp/protocol-status
           "{\"ok\":{\"message\":\"unknown op :log-mismatch log-fence-required\"}}")))
(check "ordinary EDN application errors remain relayable"
       (= "ok" (gp/protocol-status "{:error \"query validation failed\"}")))
(check "ordinary JSON application errors remain relayable"
       (= "ok" (gp/protocol-status "{\"error\":\"query validation failed\"}")))
(check "malformed coordinator response fails closed"
       (= "protocol-error" (gp/protocol-status "not-edn-or-json")))
(check "trailing EDN form fails closed"
       (= "protocol-error" (gp/protocol-status "{:version 1} {:version 2}")))
(check "trailing JSON garbage fails closed"
       (= "protocol-error" (gp/protocol-status "{\"version\":1} trailing")))

(let [results @checks
      passed (count (filter second results))]
  (doseq [[label ok?] results]
    (println (format "  [%s] %s" (if ok? "PASS" "FAIL") label)))
  (println (format "\ngateway policy: %d / %d PASS" passed (count results)))
  (System/exit (if (= passed (count results)) 0 1)))
