;; gatepolicy_test.clj — the gateway's security decisions, now REAL-typed Beagle
;; (Tenant/Bucket records, Map String Tenant), proven behavior-identical to the
;; untyped shell they were lifted from.  bb -cp out:$FRAM/out gatepolicy_test.clj
(require '[tern.gatepolicy :as gp])
(def checks (atom []))
(defn chk [n ok] (swap! checks conj [n ok]))
(chk "sha256-hex matches known vector"
     (= (gp/sha256-hex "abc") "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"))
(chk "bearer-token strips prefix" (= (gp/bearer-token "Bearer xyz") "xyz"))
(chk "bearer-token nil-safe" (= (gp/bearer-token nil) ""))
(let [t (gp/parse-tenant "acme" {:coordinator-port 7801 :coordinator-host "h"})]
  (chk "parse-tenant -> typed Tenant" (and (= (:tid t) "acme") (= (:port t) 7801) (= (:host t) "h")))
  (chk "parse-tenant default host" (= "127.0.0.1" (:host (gp/parse-tenant "x" {:coordinator-port 9}))))
  (chk "parse-tenant nil on missing port" (nil? (gp/parse-tenant "x" {}))))
(let [t (gp/parse-tenant "acme" {:coordinator-port 7801}) by {(gp/sha256-hex "tok") t}]
  (chk "token->tenant resolves" (= "acme" (:tid (gp/token->tenant by "tok"))))
  (chk "token->tenant nil on bad token" (nil? (gp/token->tenant by "nope"))))
(let [b1 (gp/bucket-step nil 0.0 1.0 1.0)]
  (chk "bucket first allows" (:ok b1))
  (chk "bucket exhausts -> deny" (not (:ok (gp/bucket-step b1 0.0 1.0 1.0)))))
(chk "valid-op? true for {:op kw}" (gp/valid-op? {:op :version}))
(chk "valid-op? false for non-map" (not (gp/valid-op? "x")))
(chk "coord-status conflict" (= "conflict" (gp/coord-status "{:reject :conflict}")))
(let [cs @checks f (remove second cs)]
  (doseq [[n ok] cs] (println (if ok "  [PASS] " "  [FAIL] ") n))
  (println (if (empty? f) (str "\ngatepolicy: " (count cs) "/" (count cs) " PASS") (str "\n" (count f) " FAILED")))
  (when (seq f) (System/exit 1)))
