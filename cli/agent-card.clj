;; agent-card.clj — the agent-identity PROJECTION (Lane N1).
;;
;; Agent ids are meaningless + immutable; everything MEANINGFUL about an agent is
;; FACTS on subject @agent:<id> (kind/role/model/vendor/effort/repo/goal/
;; spawned_at). display_name is a STORED projection of those facts, recomputed at
;; every write site (spawn / session-register / retask) and read verbatim by every
;; listing (presence-cli, web presence.ex) — the render lives HERE, once.
;;
;; Pure functions, no coordinator dependency: load-file'd by presence-cli.clj as a
;; library and required directly by agent_identity_test.clj. No main-guard needed —
;; nothing runs at load.
(ns north.agent-card
  (:require [clojure.string :as str]))

(defn- blank? [s] (or (nil? s) (str/blank? (str s))))

;; model-short: the family token humans read (opus/sonnet/haiku/fable), derived
;; from either a full id ("claude-opus-4-8") or a bare alias ("opus"). Unknown
;; ids fall back to the id minus a leading "claude-" and trailing "-<version>".
(defn model-short [m]
  (if (blank? m) ""
    (let [ml (str/lower-case (str m))]
      (cond
        (str/includes? ml "opus")   "opus"
        (str/includes? ml "sonnet") "sonnet"
        (str/includes? ml "haiku")  "haiku"
        (str/includes? ml "fable")  "fable"
        :else (-> (str m) (str/replace #"^claude-" "") (str/replace #"-\d.*$" ""))))))

;; vendor-of: derived from the model id/alias. Anthropic families are recognized
;; by name even as bare aliases; other vendors by their id stems.
(defn vendor-of [m]
  (if (blank? m) ""
    (let [ml (str/lower-case (str m))]
      (cond
        (or (str/includes? ml "claude") (str/includes? ml "opus")
            (str/includes? ml "sonnet") (str/includes? ml "haiku")
            (str/includes? ml "fable"))                              "anthropic"
        (or (str/includes? ml "gpt") (str/starts-with? ml "o1")
            (str/starts-with? ml "o3"))                              "openai"
        (str/includes? ml "gemini")                                  "google"
        (str/includes? ml "llama")                                   "meta"
        (str/includes? ml "mistral")                                 "mistral"
        :else                                                        "unknown"))))

(defn trunc [s n]
  (let [s (str s)]
    (if (> (count s) n) (str (str/triml (subs s 0 (dec n))) "…") s)))

;; render-display-name: "<role>@<repo> <model-short>-<effort> — <goal-trunc40> (<id>)"
;; with graceful blanks — any missing field drops its segment; the (<id>) tail is
;; always present, so a fact-less agent still renders as "(<id>)".
(defn render-display-name [{:keys [id role model effort repo goal]}]
  (let [ms   (model-short model)
        head (str (when-not (blank? role) role)
                  (when-not (blank? repo) (str "@" repo)))
        mid  (cond
               (and (seq ms) (not (blank? effort))) (str ms "-" effort)
               (seq ms)                             ms
               :else                                "")
        goalp (when-not (blank? goal) (str "— " (trunc goal 40)))
        segs  (filterv seq [head mid goalp])
        left  (str/join " " segs)]
    (str (when (seq left) (str left " ")) "(" id ")")))
