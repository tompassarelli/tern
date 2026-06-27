;; schema-validate.clj — JSON-Schema (practical subset) validator for structured DONE payloads
;; (Lodestar primitive 5). Matches Anthropic Workflow's agent({schema}) gate: a sender attaches
;; a schema to a message/batch (msg-cli / lodestar-map), and the receiving side validates a worker's DONE
;; payload against it BEFORE accepting — invalid => reject + ask retry; absent => accept unchanged.
;;
;; DUAL MODE — this file is both a library and a CLI:
;;   * load-file'd by msg-cli.clj / lodestar-map.clj -> call (lodestar.schema-validate/validate-json p s)
;;   * run directly for the test loop:  bb schema-validate.clj '<payload-json>' '<schema-json>'
;;     prints VALID / INVALID+errors, exit 0/1. The `(when (= *file* babashka.file) ...)` guard keeps
;;     the CLI from firing when another script loads us.
;;
;; Supported keywords (parsed-data semantics, string keys via cheshire): type (string|array of),
;; enum, const, required, properties, additionalProperties:false, items, minItems/maxItems,
;; minLength/maxLength, pattern, minimum/maximum. Unknown keywords are ignored (permissive, like a
;; real validator on an unsupported draft). A blank/absent schema => valid (the backward-compat path).
(ns lodestar.schema-validate
  (:require [cheshire.core :as json]
            [clojure.string :as str]))

(defn- type-name [v]
  (cond (nil? v) "null", (boolean? v) "boolean", (integer? v) "integer",
        (number? v) "number", (string? v) "string", (map? v) "object",
        (sequential? v) "array", :else "unknown"))

;; JSON's `integer` is a subset of `number`; cheshire parses ints->Long, decimals->Double.
;; boolean? is checked first because (integer? true) is already false in Clojure, but be explicit.
(defn- type-matches? [t v]
  (case t
    "integer" (and (integer? v) (not (boolean? v)))
    "number"  (and (number? v) (not (boolean? v)))
    "string"  (string? v)
    "boolean" (boolean? v)
    "object"  (map? v)
    "array"   (sequential? v)
    "null"    (nil? v)
    true))                                   ; unknown type keyword -> don't constrain

(defn validate*
  "Collect error strings (empty = valid) for `value` against `schema` at JSON-pointer `path`."
  [value schema path]
  (if-not (map? schema)
    []                                       ; non-object schema (e.g. JSON `true`) accepts anything
    (let [errs (volatile! [])
          loc  (if (str/blank? path) "(root)" path)
          add! (fn [m] (vswap! errs conj (str loc ": " m)))]
      (when-let [t (get schema "type")]
        (let [ts (if (sequential? t) t [t])]
          (when-not (some #(type-matches? % value) ts)
            (add! (str "expected type " (str/join "|" ts) " but got " (type-name value))))))
      (when-let [e (get schema "enum")]
        (when-not (some #(= % value) e)
          (add! (str "value " (pr-str value) " not in enum " (pr-str (vec e))))))
      (when (contains? schema "const")
        (when-not (= value (get schema "const"))
          (add! (str "value " (pr-str value) " != const " (pr-str (get schema "const"))))))
      (when (string? value)
        (when-let [m (get schema "minLength")] (when (< (count value) m) (add! (str "length " (count value) " < minLength " m))))
        (when-let [m (get schema "maxLength")] (when (> (count value) m) (add! (str "length " (count value) " > maxLength " m))))
        (when-let [p (get schema "pattern")]
          (when-not (re-find (re-pattern p) value) (add! (str "does not match pattern /" p "/")))))
      (when (and (number? value) (not (boolean? value)))
        (when-let [m (get schema "minimum")] (when (< value m) (add! (str value " < minimum " m))))
        (when-let [m (get schema "maximum")] (when (> value m) (add! (str value " > maximum " m)))))
      (when (map? value)
        (doseq [req (get schema "required")]
          (when-not (contains? value req) (add! (str "missing required property '" req "'"))))
        (let [props (get schema "properties")]
          (doseq [[k sub] props]
            (when (contains? value k)
              (vswap! errs into (validate* (get value k) sub (str path "/" k)))))
          (when (false? (get schema "additionalProperties"))
            (doseq [k (keys value)]
              (when-not (contains? props k) (add! (str "additional property '" k "' not allowed")))))))
      (when (sequential? value)
        (when-let [m (get schema "minItems")] (when (< (count value) m) (add! (str "array length " (count value) " < minItems " m))))
        (when-let [m (get schema "maxItems")] (when (> (count value) m) (add! (str "array length " (count value) " > maxItems " m))))
        (when-let [is (get schema "items")]
          (doseq [[i v] (map-indexed vector value)]
            (vswap! errs into (validate* v is (str path "/" i))))))
      @errs)))

(defn validate
  "Validate parsed `value` against parsed `schema`. -> {:valid bool :errors [str ...]}."
  [value schema]
  (let [es (validate* value schema "")]
    {:valid (empty? es) :errors es}))

(defn validate-json
  "Validate a JSON payload STRING against a JSON schema STRING. Parse failures surface as errors.
   A nil/blank schema => valid with :no-schema true (the backward-compatible no-constraint path)."
  [payload-json schema-json]
  (if (or (nil? schema-json) (str/blank? schema-json))
    {:valid true :errors [] :no-schema true}
    (let [schema  (try (json/parse-string schema-json) (catch Exception e {::err (str "schema is not valid JSON: " (.getMessage e))}))
          payload (try (json/parse-string payload-json) (catch Exception _ ::payload-parse-error))]
      (cond
        (and (map? schema) (contains? schema ::err)) {:valid false :errors [(::err schema)]}
        (= payload ::payload-parse-error)            {:valid false :errors ["payload is not valid JSON"]}
        :else                                        (validate payload schema)))))

(defn -main [& args]
  (let [[payload-json schema-json] args
        {:keys [valid errors no-schema]} (validate-json payload-json schema-json)]
    (if valid
      (println (if no-schema "VALID (no schema attached)" "VALID"))
      (do (println "INVALID")
          (doseq [e errors] (println "  -" e))))
    (System/exit (if valid 0 1))))

(when (= *file* (System/getProperty "babashka.file"))
  (apply -main *command-line-args*))
