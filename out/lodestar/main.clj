(ns lodestar.main
  (:gen-class)
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.import :as imp]
            [fram.export :as exp]
            [lodestar.projections :as proj]
            [lodestar.validate :as val]
            [lodestar.staleness :as stale]
            [lodestar.clock :as clk]
            [lodestar.audit :as audit]
            [lodestar.clockify :as cf]
            [clojure.string :as str]
            [fram.rt :as rt])
  (:import [java.util Random]
           [java.util UUID]))

(defn ^String uuidv7 []
  (let [ts (System/currentTimeMillis)
   r (Random.)
   msb (bit-or (bit-shift-left ts 16) 0x7000 (bit-and (.nextInt r) 0xFFF))
   lsb (bit-or (bit-shift-left 2 62) (bit-and (.nextLong r) 0x3FFFFFFFFFFFFFFF))]
  (str (UUID. msb lsb))))

(defn- ^String title-of [idx ^String te]
  (let [t (k/one-i idx te "title")]
  (if (some? t) t "")))

(defn- ^String short-id [^String te]
  (if (str/starts-with? te "@") (subs te 1) te))

(defn ^String resolve-ref [idx ^String ref]
  (if (some? (k/one-i idx ref "title")) ref (let [bare (short-id ref)
   matches (filterv (fn [te] (let [h (k/one-i idx te "handle")]
  (and (some? h) (= h bare)))) (k/thread-ids-i idx))]
  (if (empty? matches) ref (reduce (fn [best te] (if (str/blank? best) te (let [bc (let [c (k/one-i idx best "created_at")]
  (if (some? c) c ""))
   tc (let [c (k/one-i idx te "created_at")]
  (if (some? c) c ""))]
  (if (fram.rt/str-lt? bc tc) te best)))) "" matches)))))

(defn- ^String trunc [^String s n]
  (if (> (count s) n) (str (subs s 0 (- n 1)) "…") s))

(defrecord LevItem [te score])

(defn levitem-te [r] (:te r))

(defn levitem-score [r] (:score r))

(defrecord NextItem [te score])

(defn nextitem-te [r] (:te r))

(defn nextitem-score [r] (:score r))

(defrecord AgendaItem [te do_on])

(defn agendaitem-te [r] (:te r))

(defn agendaitem-do_on [r] (:do_on r))

(defn- ^String claim-sig [c]
  (str (:l c) "|" (:p c) "|" (:r c)))

(defn- sig-member-map [claims]
  (reduce (fn [m c] (assoc m (claim-sig c) true)) {} claims))

(defn- ^String tell-once [port ^String op ^String te ^String pred ^String rv]
  (let [v (fram.rt/coord-version port)]
  (if (< v 0) "nodaemon" (if (= op "assert") (fram.rt/coord-assert port te pred rv v) (fram.rt/coord-retract port te pred rv v)))))

(defn- ^String tell-retry [port ^String op ^String te ^String pred ^String rv tries]
  (let [resp (tell-once port op te pred rv)]
  (if (and (= resp "conflict") (> tries 0)) (tell-retry port op te pred rv (- tries 1)) resp)))

(defn- ^Boolean ctrl? [^String s]
  (or (str/includes? s "\n") (str/includes? s "\r")))

(defn- add-claim [acc ^String te ^String p ^String v]
  (if (str/blank? v) acc (conj acc (k/->Claim te p v))))

(defn- ^String ref-or-blank [^String v]
  (if (str/blank? v) "" (str "@" v)))

(defn- capture-claims [^String te ^String title ^String owner ^String source ^String author ^String lead ^String proposed ^String created-at ^String today]
  (let [c (add-claim [] te "title" title)
   c (if (= owner "personal") c (add-claim c te "owner" owner))
   c (add-claim c te "source" source)
   c (add-claim c te "created_by" (ref-or-blank author))
   c (add-claim c te "lead" (ref-or-blank lead))
   c (add-claim c te "proposed_by" (ref-or-blank proposed))
   c (add-claim c te "created_at" created-at)
   c (add-claim c te "updated_at" today)
   c (add-claim c te "committed" today)]
  c))

(defn cmd-capture [^String threads-dir ^String log ^String title ^String owner]
  (let [source (fram.rt/getenv-or "LODESTAR_SOURCE" "self")
   author (fram.rt/getenv-or "LODESTAR_AUTHOR" "you")
   lead (fram.rt/getenv-or "LODESTAR_LEAD" "")
   proposed (fram.rt/getenv-or "LODESTAR_PROPOSED_BY" "")]
  (cond
  (or (str/blank? title) (ctrl? title)) (println "usage: capture <title> [owner]   (title must be a non-empty single line)")
  (ctrl? owner) (println "capture: owner must be a single line")
  (or (ctrl? source) (ctrl? author) (ctrl? lead) (ctrl? proposed)) (println "capture: LODESTAR_SOURCE/AUTHOR/LEAD/PROPOSED_BY must each be a single line")
  :else (do
  (fram.rt/ensure-dir threads-dir)
  (let [id (uuidv7)
   slug (fram.rt/slugify title)
   today (fram.rt/today-iso)
   created-at (fram.rt/now-iso)
   te (str "@" id)
   path (str threads-dir "/" id "-" slug ".md")
   port (fram.rt/coord-port)]
  (if (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — writes won't serialize. Run `lodestar up`.") (let [claims (capture-claims te title owner source author lead proposed created-at today)
   results (mapv (fn [c] (tell-retry port "assert" (:l c) (:p c) (:r c) 5)) claims)
   oks (count (filterv (fn [r] (str/starts-with? r "ok:")) results))]
  (if (= oks (count claims)) (do
  (fram.rt/spit-file path (exp/thread-md (:claims (fold/fold (fram.rt/read-log log))) te))
  (println (str "captured -> " te "  " title "  [owner: " owner "]\n" "  file:      " path "\n" "  committed: " oks " claims via coordinator. Next: lodestar tell " id " <pred> <value>"))) (println (str "capture PARTIAL: only " oks "/" (count claims) " claim(s) committed (write conflict / no daemon?). Re-run — nothing is stranded in files."))))))))))

(defn cmd-resolve [^String log ^String ref]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))]
  (println (resolve-ref idx ref))))

(defn cmd-audit [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   rd (audit/repo-drift idx)]
  (println (str "REPO DRIFT — " (count rd) " group(s):"))
  (doseq [g rd]
  (println (str "  " (:norm g) ": " (str/join ", " (:forms g)))))))

(defn cmd-validate [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   problems (reduce (fn [acc te] (reduce (fn [a v] (conj a (str (short-id te) ": " v))) acc (val/violations-i idx te))) [] (k/thread-ids-i idx))]
  (if (empty? problems) (println (str "OK — " (count (k/thread-ids-i idx)) " threads, no violations.")) (do
  (doseq [p problems]
  (println (str "  " p)))
  (println (str (count problems) " violation(s)."))))))

(defn cmd-ready [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   today (fram.rt/today-iso)
   rs (proj/ready idx today fram.rt/str-lt?)]
  (println (str "READY NOW — " (count rs)))
  (doseq [te rs]
  (println (str "  " (short-id te) "  " (trunc (title-of idx te) 56))))))

(defn cmd-blocked [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?
   bs (filterv (fn [te] (= (proj/condition-i idx te today before?) "blocked")) (proj/work-thread-ids-i idx))]
  (println (str "BLOCKED — " (count bs)))
  (doseq [te bs]
  (println (str "  " (short-id te) "  " (trunc (title-of idx te) 48) "  (waiting on " (count (proj/incomplete-deps idx te)) ")")))))

(defn cmd-leverage [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   cands (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx))
   items (filterv (fn [it] (> (:score it) 0)) (mapv (fn [te] (->LevItem te (proj/leverage-score idx te))) cands))
   ranked (vec (take 15 (sort-by (fn [it] (- 0 (:score it))) items)))]
  (println "TOP UNBLOCKERS — finishing this transitively frees the most stuck threads")
  (doseq [it ranked]
  (println (str "  unblocks " (:score it) "  " (short-id (:te it)) "  " (trunc (title-of idx (:te it)) 46))))))

(defn cmd-next [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   today (fram.rt/today-iso)
   items (mapv (fn [te] (let [lev (proj/leverage-score idx te)
   doo (k/one-i idx te "do_on")
   urg (if (some? doo) (cond
  (fram.rt/str-lt? doo today) 5
  (= doo today) 3
  :else 0) 0)
   mom (if (some? (k/one-i idx te "driver")) 2 0)]
  (->NextItem te (+ (* 3 lev) (+ urg mom))))) (proj/ready idx today fram.rt/str-lt?))
   ranked (vec (take 12 (sort-by (fn [it] (- 0 (:score it))) items)))]
  (println (str "WHAT TO WORK ON — top picks (" today ")"))
  (doseq [it ranked]
  (println (str "  [" (:score it) "] " (short-id (:te it)) "  " (trunc (title-of idx (:te it)) 50))))))

(defn cmd-agenda [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   today (fram.rt/today-iso)
   cands (filterv (fn [te] (and (not (proj/terminal-i? idx te)) (some? (k/one-i idx te "do_on")))) (proj/work-thread-ids-i idx))
   items (mapv (fn [te] (->AgendaItem te (let [d (k/one-i idx te "do_on")]
  (if (some? d) d "")))) cands)
   overdue (vec (sort-by (fn [it] (:do_on it)) (filterv (fn [it] (fram.rt/str-lt? (:do_on it) today)) items)))
   todayb (filterv (fn [it] (= (:do_on it) today)) items)
   upcoming (vec (sort-by (fn [it] (:do_on it)) (filterv (fn [it] (fram.rt/str-lt? today (:do_on it))) items)))]
  (println (str "AGENDA — " today))
  (println (str "OVERDUE (" (count overdue) ")"))
  (doseq [it overdue]
  (println (str "  " (:do_on it) "  " (short-id (:te it)) "  " (trunc (title-of idx (:te it)) 44))))
  (println (str "TODAY (" (count todayb) ")"))
  (doseq [it todayb]
  (println (str "  " (:do_on it) "  " (short-id (:te it)) "  " (trunc (title-of idx (:te it)) 44))))
  (println (str "UPCOMING (" (count upcoming) ")"))
  (doseq [it upcoming]
  (println (str "  " (:do_on it) "  " (short-id (:te it)) "  " (trunc (title-of idx (:te it)) 44))))))

(defn- plate-group [idx ^String label grp]
  (if (not (empty? grp)) (do
  (println (str "\n" (proj/condition-emoji idx label) " " label " (" (count grp) ")"))
  (doseq [te grp]
  (println (str "  " (short-id te) "  " (trunc (title-of idx te) 52)))))))

(defn- in-condition [idx nonterm ^String today before? ^String c]
  (filterv (fn [te] (= (proj/condition-i idx te today before?) c)) nonterm))

(defn cmd-plate [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?
   nonterm (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx))]
  (println (str "ON YOUR PLATE — " (count nonterm) " open"))
  (plate-group idx "active" (in-condition idx nonterm today before? "active"))
  (plate-group idx "ready" (in-condition idx nonterm today before? "ready"))
  (plate-group idx "blocked" (in-condition idx nonterm today before? "blocked"))
  (plate-group idx "dormant" (in-condition idx nonterm today before? "dormant"))
  (plate-group idx "draft" (in-condition idx nonterm today before? "draft"))))

(defrecord JThread [id title condition emoji])

(defn jthread-id [r] (:id r))

(defn jthread-title [r] (:title r))

(defn jthread-condition [r] (:condition r))

(defn jthread-emoji [r] (:emoji r))

(defrecord JPresentation [active ready blocked draft])

(defn jpresentation-active [r] (:active r))

(defn jpresentation-ready [r] (:ready r))

(defn jpresentation-blocked [r] (:blocked r))

(defn jpresentation-draft [r] (:draft r))

(defrecord JReview [id title pred detail])

(defn jreview-id [r] (:id r))

(defn jreview-title [r] (:title r))

(defn jreview-pred [r] (:pred r))

(defn jreview-detail [r] (:detail r))

(defrecord JClaim [predicate value])

(defn jclaim-predicate [r] (:predicate r))

(defn jclaim-value [r] (:value r))

(defrecord JClockRow [id title est_h actual_sec done])

(defn jclockrow-id [r] (:id r))

(defn jclockrow-title [r] (:title r))

(defn jclockrow-est_h [r] (:est_h r))

(defn jclockrow-actual_sec [r] (:actual_sec r))

(defn jclockrow-done [r] (:done r))

(defrecord JCalib [pct sample])

(defn jcalib-pct [r] (:pct r))

(defn jcalib-sample [r] (:sample r))

(defrecord JClockReport [rows calibration])

(defn jclockreport-rows [r] (:rows r))

(defn jclockreport-calibration [r] (:calibration r))

(defn- ^JThread jthread [idx ^String te ^String today before?]
  (let [c (proj/condition-i idx te today before?)]
  (->JThread (short-id te) (title-of idx te) c (proj/condition-emoji idx c))))

(defn cmd-json [^String log ^String what ^String arg]
  (let [as (fram.rt/read-log log)
   f (fold/fold as)
   idx (k/build-index (:claims f))
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?]
  (cond
  (= what "plate") (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before?)) (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx)))))
  (= what "ready") (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before?)) (proj/ready idx today before?))))
  (= what "blocked") (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before?)) (filterv (fn [te] (= (proj/condition-i idx te today before?) "blocked")) (proj/work-thread-ids-i idx)))))
  (= what "needs-review") (let [latest (fold/fold-latest as)
   today (fram.rt/today-iso)
   reviews (stale/needs-review idx latest today (fn [a b] (fram.rt/str-lt? a b)))]
  (println (fram.rt/to-json (mapv (fn [rv] (->JReview (short-id (:te rv)) (title-of idx (:te rv)) (:pred rv) (:detail rv))) reviews))))
  (= what "clock-report") (let [rs (clk/rows idx (fn [s] (fram.rt/iso-to-seconds s)) (fn [s] (fram.rt/parse-int s)))
   cal (clk/calibration rs)]
  (println (fram.rt/to-json (->JClockReport (mapv (fn [r] (->JClockRow (short-id (:te r)) (title-of idx (:te r)) (:est-h r) (:act-sec r) (:term r))) rs) (->JCalib (:pct cal) (:sample cal))))))
  (= what "show") (println (fram.rt/to-json (mapv (fn [c] (->JClaim (:p c) (:r c))) (k/q-by-l (:claims f) (str "@" arg)))))
  (= what "presentation") (println (fram.rt/to-json (->JPresentation (proj/condition-emoji idx "active") (proj/condition-emoji idx "ready") (proj/condition-emoji idx "blocked") (proj/condition-emoji idx "draft"))))
  :else (println "usage: json plate|ready|blocked|needs-review|clock-report|show <id>|presentation"))))

(defn cmd-needs-review [^String log]
  (let [as (fram.rt/read-log log)
   idx (k/build-index (:claims (fold/fold as)))
   latest (fold/fold-latest as)
   today (fram.rt/today-iso)
   reviews (stale/needs-review idx latest today (fn [a b] (fram.rt/str-lt? a b)))
   promo (stale/promotable idx)]
  (println (str "NEEDS REVIEW — " (count reviews) " judgment(s) whose inputs moved (" today ")"))
  (doseq [rv reviews]
  (println (str "  [" (:pred rv) "] " (short-id (:te rv)) "  " (trunc (title-of idx (:te rv)) 44)))
  (println (str "      " (:detail rv))))
  (println (str "\nPROMOTABLE — " (count promo) " uncommitted draft(s) that grew real structure"))
  (doseq [te promo]
  (println (str "  " (short-id te) "  " (trunc (title-of idx te) 52))))))

(defn- ^String fmt-hm [secs]
  (str (quot secs 3600) "h " (quot (mod secs 3600) 60) "m"))

(defn- ^String session-thread [idx ^String sess]
  (let [t (k/one-i idx sess "session_of")]
  (if (some? t) t "")))

(defn- ^String fresh-sid [idx ^String seed]
  (if (k/vec-contains? (:subjects idx) (str "@" seed)) (fresh-sid idx (fram.rt/bump-id seed)) seed))

(defn cmd-clock-start [^String log ^String id]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   te (str "@" id)
   run (clk/running-session idx)]
  (cond
  (nil? (k/one-i idx te "title")) (println (str "no such thread: " id))
  (some? run) (println (str "already clocked in on " (short-id (session-thread idx run)) " (session " (short-id run) ") — `clock stop` first"))
  :else (let [port (fram.rt/coord-port)]
  (if (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `lodestar up`") (let [sid (fresh-sid idx (fram.rt/now-id))
   ssub (str "@" sid)
   now (fram.rt/now-iso)
   r1 (tell-retry port "assert" ssub "session_of" te 5)
   r2 (tell-retry port "assert" ssub "start_time" now 5)]
  (if (and (str/starts-with? r1 "ok:") (str/starts-with? r2 "ok:")) (println (str "clocked in on " id " at " now "  (session " sid ")")) (println (str "clock start FAILED to record (" r1 "/" r2 ") — retry")))))))))

(defn cmd-clock-stop [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   run (clk/running-session idx)
   port (fram.rt/coord-port)]
  (cond
  (nil? run) (println "not clocked in")
  (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `lodestar up` (still clocked in)")
  :else (let [now (fram.rt/now-iso)
   st (k/one-i idx run "start_time")
   te (session-thread idx run)
   dur (if (some? st) (- (fram.rt/iso-to-seconds now) (fram.rt/iso-to-seconds st)) 0)
   resp (tell-retry port "assert" run "end_time" now 5)]
  (if (str/starts-with? resp "ok:") (println (str "clocked out of " (short-id te) " — this session " (fmt-hm dur))) (println (str "clock stop FAILED to record end_time (" resp ") — still clocked in, retry")))))))

(defn cmd-clock-status [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   run (clk/running-session idx)]
  (if (nil? run) (println "not clocked in") (let [now (fram.rt/now-iso)
   st (k/one-i idx run "start_time")
   te (session-thread idx run)
   dur (if (some? st) (- (fram.rt/iso-to-seconds now) (fram.rt/iso-to-seconds st)) 0)]
  (println (str "clocked in on " (short-id te) "  " (trunc (title-of idx te) 40)))
  (println (str "  since " (if (some? st) st "?") "  (" (fmt-hm dur) " elapsed)"))))))

(defn cmd-clock-report [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   rs (clk/rows idx (fn [s] (fram.rt/iso-to-seconds s)) (fn [s] (fram.rt/parse-int s)))
   cal (clk/calibration rs)]
  (println (str "TIME LOGGED — estimate vs actual (" (count rs) " thread(s))"))
  (doseq [r rs]
  (println (str "  " (short-id (:te r)) "  est " (:est-h r) "h  actual " (fmt-hm (:act-sec r)) "  " (trunc (title-of idx (:te r)) 38))))
  (if (> (:sample cal) 0) (println (str "\nCALIBRATION — across " (:sample cal) " done thread(s) with both: actuals ran " (:pct cal) "% of estimate" (if (> (:pct cal) 100) " (you under-estimate)" " (you over-estimate)"))) (println "\nCALIBRATION — not enough completed estimate+actual data yet"))))

(defn cmd-clock-sync [^String log]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   dir (fram.rt/time-dir)
   sessions (clk/syncable-sessions idx)
   port (fram.rt/coord-port)]
  (cond
  (empty? sessions) (println "nothing to sync — no closed, unsynced sessions")
  (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `lodestar up` (sync records clockify_id, so it must be up first)")
  :else (let [ws (cf/default-workspace)]
  (println (str "syncing " (count sessions) " session(s) to clockify (workspace " ws ")"))
  (doseq [s sessions]
  (let [te (session-thread idx s)
   owner (let [o (k/one-i idx te "owner")]
  (if (some? o) o "personal"))
   proj (cf/project-for dir owner)
   st (k/one-i idx s "start_time")
   en (k/one-i idx s "end_time")]
  (cond
  (nil? proj) (println (str "  – skip " (short-id s) "  (owner '" owner "' unmapped — `clock map " owner " <project-id>`)"))
  (or (nil? st) (nil? en)) (println (str "  ! skip " (short-id s) "  (missing start/end)"))
  :else (let [cid (cf/create-entry ws proj st en (title-of idx te))]
  (if (= cid "") (println (str "  ! " (short-id s) "  (clockify returned no id)")) (let [wb (tell-retry port "assert" s "clockify_id" cid 5)]
  (if (str/starts-with? wb "ok:") (println (str "  ✓ " (short-id te) "  " st " → " en "  (clockify " cid ")")) (println (str "  !! " (short-id s) " PUSHED to clockify (" cid ") but failed to record it (" wb ") — set manually to avoid a double-push: tell " (short-id s) " clockify_id " cid)))))))))
  (println "done.")))))

(defn- clock-window [^String log prefixes ^String label]
  (let [idx (k/build-index (:claims (fold/fold (fram.rt/read-log log))))
   rs (clk/logged-rows idx prefixes (fn [s] (fram.rt/iso-to-seconds s)))
   total (reduce (fn [m r] (+ m (:act-sec r))) 0 rs)]
  (println (str "LOGGED " label " — " (fmt-hm total) " across " (count rs) " thread(s)"))
  (doseq [r rs]
  (println (str "  " (fmt-hm (:act-sec r)) "  " (short-id (:te r)) "  " (trunc (title-of idx (:te r)) 40))))))

(defn cmd-clock-today [^String log]
  (clock-window log (conj [] (subs (fram.rt/now-iso) 0 10)) "today"))

(defn cmd-clock-week [^String log]
  (clock-window log (fram.rt/this-week-dates) "this week"))

(defn cmd-doctor [^String threads-dir ^String log]
  (let [port (fram.rt/coord-port)
   status (fram.rt/coord-status port)
   up (not (= status "down"))
   serving (str/includes? status log)
   f (fold/fold (fram.rt/read-log log))
   log-v (:version f)
   daemon-v (fram.rt/coord-version port)
   fresh (= daemon-v log-v)
   file-claims (:claims (fold/fold (imp/load-corpus threads-dir)))
   idx (k/build-index (:claims f))
   thread-log (filterv (fn [c] (some? (k/one-i idx (:l c) "title"))) (:claims f))
   tl-sigs (sig-member-map thread-log)
   file-sigs (sig-member-map file-claims)
   file-ahead (filterv (fn [c] (nil? (get tl-sigs (claim-sig c)))) file-claims)
   log-behind (filterv (fn [c] (nil? (get file-sigs (claim-sig c)))) thread-log)
   clean (empty? file-ahead)
   synced (and clean (empty? log-behind))]
  (println "lodestar doctor")
  (if up (do
  (println (str "  [ok]    coordinator UP on 127.0.0.1:" port))
  (if serving (println "  [ok]    serving the canonical log") (println (str "  [WARN]  daemon is NOT serving " log " — status: " status)))
  (if fresh (println "  [ok]    daemon state matches the on-disk log") (println (str "  [WARN]  daemon is STALE (loaded v" daemon-v ", log is v" log-v ") — the log changed out-of-band; restart: kill it + `lodestar up`")))) (println (str "  [DOWN]  no coordinator on 127.0.0.1:" port " — writes won't serialize. Run `lodestar up`.")))
  (cond
  synced (println "  [ok]    files <-> claim log in sync")
  clean (println (str "  [ok]    files behind the log by " (count log-behind) " thread-claim(s) — benign projection lag; `lodestar export` to refresh"))
  :else (println (str "  [WARN]  " (count file-ahead) " file claim(s) not in the log " "(a thread .md was hand-edited?) — reconcile via the coordinator, or `import`")))
  (if (and up (and serving (and clean fresh))) (println "  => healthy: tell/untell + warm reads are safe") (println "  => DEGRADED: fix the warnings above"))))

(defn run [args ^String threads-dir ^String log]
  (let [cmd (if (empty? args) "" (first args))]
  (cond
  (= cmd "capture") (if (>= (count args) 2) (cmd-capture threads-dir log (nth args 1) (if (>= (count args) 3) (nth args 2) "personal")) (println "usage: capture <title> [owner]"))
  (= cmd "ready") (cmd-ready log)
  (= cmd "blocked") (cmd-blocked log)
  (= cmd "leverage") (cmd-leverage log)
  (= cmd "next") (cmd-next log)
  (= cmd "agenda") (cmd-agenda log)
  (= cmd "plate") (cmd-plate log)
  (= cmd "needs-review") (cmd-needs-review log)
  (= cmd "audit") (cmd-audit log)
  (= cmd "resolve") (if (>= (count args) 2) (cmd-resolve log (nth args 1)) (println "usage: resolve <@handle|@id>"))
  (= cmd "validate") (cmd-validate log)
  (= cmd "doctor") (cmd-doctor threads-dir log)
  (= cmd "json") (cmd-json log (if (> (count args) 1) (nth args 1) "") (if (> (count args) 2) (nth args 2) ""))
  (= cmd "clock") (let [sub (if (> (count args) 1) (nth args 1) "status")]
  (cond
  (= sub "start") (if (>= (count args) 3) (cmd-clock-start log (nth args 2)) (println "usage: clock start <thread-id>"))
  (= sub "stop") (cmd-clock-stop log)
  (= sub "status") (cmd-clock-status log)
  (= sub "report") (cmd-clock-report log)
  (= sub "today") (cmd-clock-today log)
  (= sub "week") (cmd-clock-week log)
  (= sub "sync") (cmd-clock-sync log)
  (= sub "map") (if (>= (count args) 4) (cf/cmd-map (fram.rt/time-dir) (nth args 2) (nth args 3)) (println "usage: clock map <owner> <project-id>"))
  (= sub "projects") (cf/cmd-projects)
  (= sub "workspaces") (cf/cmd-workspaces)
  :else (println "usage: clock start <id> | stop | status | report | today | week | sync | map <owner> <project-id> | projects | workspaces")))
  :else (println "lodestar usage: capture <title> [owner] | ready | blocked | leverage | next | agenda | plate | needs-review | audit | resolve <@handle|@id> | validate | doctor | json <...> | clock <start|stop|status|report|today|week|sync|map|projects|workspaces>   (engine verbs import/export/show/set/tell/merge route to fram)"))))

(defn -main [& args]
  (run (vec args) (fram.rt/threads-dir) (fram.rt/log-path)))
