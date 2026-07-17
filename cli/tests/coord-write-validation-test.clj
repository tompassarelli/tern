#!/usr/bin/env bb
;; The shared North write seam must never turn omitted arguments into malformed
;; facts. Explicit blank literals remain valid because several contracts use them.
(require '[clojure.java.io :as io])

(def root (-> (io/file (System/getProperty "babashka.file"))
              .getParentFile .getParentFile .getParentFile .getPath))
(load-file (str root "/cli/coord.clj"))

(def fails (atom 0))
(defn check [label ok?]
  (println (str "  " (if ok? "PASS" "FAIL") " — " label))
  (when-not ok? (swap! fails inc)))
(defn invalid-write? [f]
  (try
    (f)
    false
    (catch clojure.lang.ExceptionInfo e
      (= :invalid-write (:type (ex-data e))))))

(def sent (atom []))
(with-redefs [north.coord/send-op (fn [_ op] (swap! sent conj op) {:ok true})
              north.coord/cur-ver (constantly 1)]
  (check "append rejects nil subject before socket write"
         (invalid-write? #(north.coord/append! 1 nil "note" "x")))
  (check "put rejects blank subject before socket write"
         (invalid-write? #(north.coord/put! 1 " " "title" "x")))
  (check "swap rejects blank predicate before socket write"
         (invalid-write? #(north.coord/swap! 1 "@x" "" "x")))
  (check "retract rejects nil object before socket write"
         (invalid-write? #(north.coord/retract! 1 "@x" "note" nil)))
  (check "rejected writes never reach send-op" (empty? @sent))
  (north.coord/append! 1 "@x" "note" "")
  (north.coord/put! 1 "@x" "estimate" 42)
  (check "explicit blank object remains valid" (= "" (:r (first @sent))))
  (check "non-nil objects retain string coercion" (= "42" (:r (second @sent)))))

(if (zero? @fails)
  (do (println "\ncoord write validation: ALL PASS") (System/exit 0))
  (do (println (str "\ncoord write validation: " @fails " FAIL")) (System/exit 1)))
