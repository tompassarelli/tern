;; clock-audit — drift detector: git commits in client repos vs clock coverage.
;;
;; Billable client work MUST run under a north clock. This tool makes drift LOUD
;; within a day instead of at invoice time: it compares each commit's author time
;; against the union of clock-session intervals for that repo's client, and lists
;; every UNCOVERED commit. READ-ONLY — never writes a fact.
;;
;; Session fact model (see src/north/clock.bclj):
;;   @<sess> kind client_session  owner <client>  clocked_by user
;;           start_time <iso>  end_time <iso> (end absent => open)
;; Legacy session_of rows remain coverage only when clocked_by is absent/user.
;; Explicit managed-agent rows are task telemetry, never billing coverage.
;; Client of a repo: the path segment after /code/client/  (…/client/<client>/<repo>).
;; A commit is COVERED iff its author time falls within [start-15min, end+15min]
;; of ANY session whose thread owner equals the repo's client (grace: a commit
;; lands moments after a stop).
;;
;; CONFIDENTIALITY: no client names/paths are hardcoded here — clients are derived
;; at runtime from repo paths. Only runtime OUTPUT may show them.
;;
;; Usage: clock-audit [--repo <path>]... [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--persist]
;;   --repo    repeatable; default: every git repo matching ~/code/client/*/*/.git
;;   --since   default: Monday of the current week
;;   --until   default: today (inclusive)
;;   --persist after auditing, write ONE kind=clock_audit_run summary entity through
;;             the coordinator (drift telemetry — a trend over time, not per-commit spam).
;;             DEFAULT is read-only (no flag, no write) — safe in CI/cron pipelines that
;;             only want the exit code. The daily reactor tick passes --persist.
;; Exit: 0 if every commit covered, 1 if any uncovered (cron/CI-able).
(ns clock-audit
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.rt :as rt]
            [clojure.string :as str]
            [babashka.cli :as cli]
            [babashka.fs :as fs]
            [babashka.process :as proc])
  (:import [java.time LocalDate LocalDateTime Instant ZoneId DayOfWeek]
           [java.time.temporal TemporalAdjusters]))

(def ^:private ZONE (ZoneId/systemDefault))
(def ^:private GRACE 900)                                ; ±15 min, in seconds
(def ^:private US "")                              ; git field separator

;; session/thread times are stored two ways: a UTC instant ("…Z", synthetic
;; backfills) or a zone-less local ISO (the live clock, fram.rt/now-iso). The
;; engine's own tolerant parser resolves both to an absolute epoch-second (Z/offset
;; honored, zone-less read in the system zone) — the same call north-timelog uses.
(defn- iso->epoch [s] (rt/iso-to-seconds s))

(defn- now-epoch [] (.getEpochSecond (Instant/now)))
(defn- epoch->ldt [ep] (LocalDateTime/ofInstant (Instant/ofEpochSecond ep) ZONE))
(defn- epoch->day [ep] (str (.toLocalDate (epoch->ldt ep))))
(defn- epoch->hhmm [ep] (format "%02d:%02d" (.getHour (epoch->ldt ep)) (.getMinute (epoch->ldt ep))))

(defn- day-start-epoch [^LocalDate d] (.toEpochSecond (.atStartOfDay d ZONE)))
(defn- day-end-epoch [^LocalDate d] (+ (day-start-epoch d) 86399))   ; inclusive last second

(defn- fmt-dur [secs]
  (let [s (max 0 (long secs)) h (quot s 3600) m (quot (mod s 3600) 60)]
    (if (pos? h) (format "%dh %02dm" h m) (format "%dm" m))))

(defn- monday-of-week []
  (.with (LocalDate/now) (TemporalAdjusters/previousOrSame DayOfWeek/MONDAY)))

;; union-merge intervals -> total covered seconds (overlaps never double-count).
(defn- union-secs [intervals]
  (->> (sort-by first intervals)
       (reduce (fn [acc [s e]]
                 (if-let [[ps pe] (peek acc)]
                   (if (<= s pe)
                     (conj (pop acc) [ps (max pe e)])
                     (conj acc [s e]))
                   (conj acc [s e])))
               [])
       (map (fn [[s e]] (- e s)))
       (reduce + 0)))

;; ---- sessions from the fact log --------------------------------------------
(defn- load-sessions []
  (let [facts (:facts (fold/fold (rt/read-configured-logs)))
        idx   (k/build-index facts)
        one   (fn [s p] (k/one-i idx s p))]
    (->> (:subjects idx)
         (keep (fn [s]
                 (let [so (one s "session_of")
                       st (one s "start_time")
                       actor (or (one s "clocked_by") "user")
                       client? (= (one s "kind") "client_session")
                       owner (if client? (one s "owner")
                                 (when (some? so) (one so "owner")))]
                   (when (and (= actor "user")
                              (and (some? st) (some? owner)))
                     {:id       s
                      :owner    owner
                      :start    (iso->epoch st)
                      :end      (if-let [en (one s "end_time")] (iso->epoch en) (now-epoch))
                      :orphaned (contains? #{"true" true} (one s "clock_orphaned"))}))))
         (into []))))

;; ---- git commits in the window ---------------------------------------------
;; --all so worktree/branch commits count (client work isn't always on main).
;; --since is a loose COMMITTER-date prefilter (bound history cheaply); the real
;; window is enforced below on AUTHOR epoch. 2-day slack absorbs committer<author
;; skew from rebase/amend near the boundary.
(defn- commits [repo lo hi]
  (let [{:keys [out exit]}
        (proc/sh {:dir (str repo)}
                 "git" "log" "--all" "--no-merges"
                 (str "--since=@" (- lo 172800))
                 (str "--pretty=format:%h" US "%at" US "%an" US "%s"))]
    (if-not (zero? exit)
      []
      (->> (str/split-lines (str/trim out))
           (remove str/blank?)
           (keep (fn [line]
                   (let [[sha at an subj] (str/split line (re-pattern US) 4)
                         t (Long/parseLong at)]
                     (when (and (>= t lo) (<= t hi))
                       {:sha (subs sha 0 (min 7 (count sha)))
                        :t t :author an :subject (or subj "")}))))
           (into [])))))

(defn- client-of [repo]
  (let [segs (-> (str repo) (str/split #"/code/client/") second (str/split #"/"))]
    (first segs)))

(defn- covered? [sessions t]
  (boolean (some (fn [s] (and (<= (- (:start s) GRACE) t) (<= t (+ (:end s) GRACE)))) sessions)))

;; ---- per-repo audit --------------------------------------------------------
(defn- audit-repo [repo all-sessions lo hi]
  (let [client   (client-of repo)
        sessions (filterv #(= (:owner %) client) all-sessions)
        ;; only sessions that overlap the reporting window matter for clocked time
        in-win   (filterv #(and (< (:start %) hi) (> (:end %) lo)) sessions)
        cmts     (commits repo lo hi)
        by-day   (into (sorted-map) (group-by #(epoch->day (:t %)) cmts))
        orphaned (filterv :orphaned in-win)]
    {:repo repo :client client :commits cmts :sessions sessions
     :in-win in-win :by-day by-day :orphaned orphaned :lo lo :hi hi}))

(defn- day-clocked-secs [sessions ^LocalDate d]
  (let [ds (day-start-epoch d) de (day-end-epoch d)]
    (->> sessions
         (keep (fn [s] (let [a (max (:start s) ds) b (min (:end s) de)]
                         (when (< a b) [a b]))))
         union-secs)))

(defn- print-repo [{:keys [repo client commits sessions in-win by-day orphaned lo hi]}]
  (let [cov (group-by #(covered? sessions (:t %)) commits)
        ncov (count (get cov true)) nunc (count (get cov false))
        pct (if (pos? (count commits)) (int (Math/round (* 100.0 (/ ncov (double (count commits)))))) 100)]
    (println)
    (println (format "REPO %s  (client: %s)" repo client))
    (when (seq orphaned)
      (println (format "  ⚠ %d session(s) carry clock_orphaned true — untrustworthy tail: %s"
                       (count orphaned) (str/join " " (map :id orphaned)))))
    (doseq [[day cs] by-day]
      (let [d (LocalDate/parse day)
            clk (day-clocked-secs sessions d)
            dcov (group-by #(covered? sessions (:t %)) cs)
            dnc (count (get dcov true)) dnu (count (get dcov false))
            dpct (if (pos? (count cs)) (int (Math/round (* 100.0 (/ dnc (double (count cs)))))) 100)]
        (println (format "  %s  clocked %-8s commits %2d  covered %2d  uncovered %2d  (%d%%)"
                         day (fmt-dur clk) (count cs) dnc dnu dpct))
        (doseq [c (sort-by :t (get dcov false))]
          (println (format "      %-7s %s  %s" (:sha c) (epoch->hhmm (:t c))
                           (let [s (:subject c)] (if (> (count s) 60) (str (subs s 0 57) "…") s)))))))
    (let [rclk (union-secs (keep (fn [s] (let [a (max (:start s) lo) b (min (:end s) hi)]
                                           (when (< a b) [a b]))) in-win))]
      (println (format "  repo total: clocked %s  commits %d  covered %d  uncovered %d  (%d%%)"
                       (fmt-dur rclk) (count commits) ncov nunc pct)))
    {:covered ncov :uncovered nunc :total (count commits)}))

;; ---- persistence (the ONE write path) --------------------------------------
;; --persist mints ONE titleless kind=clock_audit_run entity per run so a drift
;; TREND survives (the telemetry the billing failure mode needs — a 22h unbilled
;; reconstruction motivated the clock stack; the audit's own output evaporates).
;; Mirrors the guard_denial / recordRun idiom: kind-at-birth, minimal predicates,
;; titleless subject (queryable via fram show/ask, invisible to the work board).
;; The write path is DELIBERATELY one function — if this telemetry later moves
;; logs, re-aim the coordinator target HERE and nowhere else.
(defn- repo-root []
  ;; cli/clock-audit.clj -> cli -> repo root; bin/north lives under it.
  (-> (System/getProperty "babashka.file") fs/parent fs/parent))

(defn- repo-label [repo]
  ;; client/repo tail (runtime output may name clients; the graph is local) or basename.
  (or (second (str/split (str repo) #"/code/client/")) (str (fs/file-name repo))))

(defn- persist-run!
  "Write one run summary through the coordinator (`north tell`, serialized+rule-checked).
   ≤1KB: run_at, window, uncovered_count, and one repo_summary per repo. Best-effort —
   a telemetry write failure WARNS but never changes the drift exit code."
  [since-d until-d total-uncovered results]
  (let [subj  (str "clock-audit-" (Long/toString (System/currentTimeMillis) 36))
        bin   (str (fs/path (repo-root) "bin" "north"))
        base  [["kind" "clock_audit_run"]
               ["run_at" (str (Instant/now))]          ; UTC ISO (…Z) — parseable both sides
               ["window" (str since-d ".." until-d)]
               ["uncovered_count" (str total-uncovered)]]
        facts (concat base
                      (for [{:keys [repo uncovered]} results]
                        ["repo_summary" (format "%s: %d uncovered" (repo-label repo) uncovered)]))]
    (doseq [[p v] facts]
      (let [{:keys [exit err]} (proc/sh bin "tell" subj p v)]
        (when-not (zero? exit)
          (binding [*out* *err*]
            (println (format "clock-audit: persist WARN — tell %s failed: %s"
                             p (str/trim (str err))))))))
    (println (format "persisted %s  (%d fact(s))" subj (count facts)))
    subj))

;; ---- main ------------------------------------------------------------------
(let [{:keys [repo since until persist]}
      (cli/parse-opts *command-line-args* {:coerce {:repo [] :persist :boolean}})
      home   (System/getenv "HOME")
      repos  (if (seq repo)
               (mapv #(-> (fs/canonicalize %) str) repo)
               (->> (fs/glob home "code/client/*/*/.git" {:hidden true})
                    (map #(-> % fs/parent str)) sort vec))
      since-d (if since (LocalDate/parse since) (monday-of-week))
      until-d (if until (LocalDate/parse until) (LocalDate/now))
      lo      (day-start-epoch since-d)
      hi      (day-end-epoch until-d)
      sessions (load-sessions)]
  (println (format "== clock audit ==  %s .. %s  (%d repo(s))  [±%dm grace]"
                   since-d until-d (count repos) (quot GRACE 60)))
  (let [results (mapv #(let [a (audit-repo % sessions lo hi)]
                         (assoc (print-repo a) :repo (:repo a))) repos)
        C (reduce + (map :covered results))
        U (reduce + (map :uncovered results))
        T (reduce + (map :total results))
        pct (if (pos? T) (int (Math/round (* 100.0 (/ C (double T))))) 100)]
    (println)
    (println (format "== SUMMARY ==  %d/%d commits covered  (%d%%)  %d uncovered" C T pct U))
    (when persist (persist-run! since-d until-d U results))
    (System/exit (if (pos? U) 1 0))))
