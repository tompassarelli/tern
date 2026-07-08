(ns tern.main
  (:gen-class)
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.import :as imp]
            [fram.export :as exp]
            [tern.projections :as proj]
            [tern.validate :as val]
            [tern.staleness :as stale]
            [tern.clock :as clk]
            [tern.audit :as audit]
            [tern.clockify :as cf]
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
  (if (empty? matches) (let [pms (if (str/blank? bare) [] (filterv (fn [te] (str/starts-with? (short-id te) bare)) (k/thread-ids-i idx)))]
  (if (= (count pms) 1) (first pms) ref)) (reduce (fn [best te] (if (str/blank? best) te (let [bc (let [c (k/one-i idx best "created_at")]
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

(defn- live-claims [^String log]
  (let [warm (fram.rt/coord-live-claims (fram.rt/coord-port) log)]
  (if (empty? warm) (:claims (fold/fold (fram.rt/read-log log))) warm)))

(defn- live-idx [^String log]
  (k/build-index (live-claims log)))

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
  (let [source (fram.rt/getenv-or "TERN_SOURCE" "self")
   author (fram.rt/getenv-or "TERN_AUTHOR" "you")
   lead (fram.rt/getenv-or "TERN_LEAD" "")
   proposed (fram.rt/getenv-or "TERN_PROPOSED_BY" "")]
  (cond
  (or (str/blank? title) (ctrl? title)) (println "usage: capture <title> [owner]   (title must be a non-empty single line)")
  (ctrl? owner) (println "capture: owner must be a single line")
  (or (ctrl? source) (ctrl? author) (ctrl? lead) (ctrl? proposed)) (println "capture: TERN_SOURCE/AUTHOR/LEAD/PROPOSED_BY must each be a single line")
  :else (do
  (fram.rt/ensure-dir threads-dir)
  (let [id (uuidv7)
   slug (fram.rt/slugify title)
   today (fram.rt/today-iso)
   created-at (fram.rt/now-iso)
   te (str "@" id)
   path (str threads-dir "/" id "-" slug ".md")
   port (fram.rt/coord-port)]
  (if (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — writes won't serialize. Run `tern up`.") (let [claims (capture-claims te title owner source author lead proposed created-at today)
   results (mapv (fn [c] (tell-retry port "assert" (:l c) (:p c) (:r c) 5)) claims)
   oks (count (filterv (fn [r] (str/starts-with? r "ok:")) results))]
  (if (= oks (count claims)) (do
  (fram.rt/spit-file path (exp/thread-md (:claims (fold/fold (fram.rt/read-log log))) te))
  (println (str "captured -> " te "  " title "  [owner: " owner "]\n" "  file:      " path "\n" "  committed: " oks " claims via coordinator. Next: tern tell " id " <pred> <value>"))) (println (str "capture PARTIAL: only " oks "/" (count claims) " claim(s) committed (write conflict / no daemon?). Re-run — nothing is stranded in files."))))))))))

(defn- ^Boolean id-like? [^String bare]
  (and (not (str/blank? bare)) (str/blank? (str/replace bare #"[0-9a-f-]" "")) (or (str/includes? bare "-") (>= (count bare) 8))))

(defn cmd-resolve [^String log ^String ref]
  (let [idx (live-idx log)
   r (resolve-ref idx ref)]
  (if (and (= r ref) (id-like? (short-id ref)) (nil? (k/one-i idx (str "@" (short-id ref)) "title"))) (println (str "ERROR unresolved id-like ref " ref " — not a thread id, unique prefix, or handle" " (ambiguous/truncated? `tern show " (short-id ref) "` lists candidates)")) (println r))))

(defn cmd-audit [^String log]
  (let [idx (live-idx log)
   rd (audit/repo-drift idx)]
  (println (str "REPO DRIFT — " (count rd) " group(s):"))
  (doseq [g rd]
  (println (str "  " (:norm g) ": " (str/join ", " (:forms g)))))))

(defn cmd-validate [^String log]
  (let [idx (live-idx log)
   problems (reduce (fn [acc te] (reduce (fn [a v] (conj a (str (short-id te) ": " v))) acc (val/violations-i idx te))) [] (k/thread-ids-i idx))]
  (if (empty? problems) (println (str "OK — " (count (k/thread-ids-i idx)) " threads, no violations.")) (do
  (doseq [p problems]
  (println (str "  " p)))
  (println (str (count problems) " violation(s)."))))))

(defn cmd-ready [^String log]
  (let [idx (live-idx log)
   today (fram.rt/today-iso)
   rs (proj/ready idx today fram.rt/str-lt?)]
  (println (str "READY NOW — " (count rs)))
  (doseq [te rs]
  (println (str "  " (short-id te) "  " (trunc (title-of idx te) 56))))))

(defn cmd-blocked [^String log]
  (let [idx (live-idx log)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?
   bs (filterv (fn [te] (= (proj/condition-i idx te today before?) "blocked")) (proj/work-thread-ids-i idx))]
  (println (str "BLOCKED — " (count bs)))
  (doseq [te bs]
  (println (str "  " (short-id te) "  " (trunc (title-of idx te) 48) "  (waiting on " (count (proj/incomplete-deps idx te)) ")")))))

(defn cmd-leverage [^String log]
  (let [idx (live-idx log)
   cands (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx))
   items (filterv (fn [it] (> (:score it) 0)) (mapv (fn [te] (->LevItem te (proj/leverage-score idx te))) cands))
   ranked (vec (take 15 (sort-by (fn [it] (- 0 (:score it))) items)))]
  (println "TOP UNBLOCKERS — finishing this transitively frees the most stuck threads")
  (doseq [it ranked]
  (println (str "  unblocks " (:score it) "  " (short-id (:te it)) "  " (trunc (title-of idx (:te it)) 46))))))

(defn cmd-next [^String log]
  (let [idx (live-idx log)
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
  (let [idx (live-idx log)
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

(defn- board-group [idx ^String label grp]
  (if (not (empty? grp)) (do
  (println (str "\n" (proj/condition-emoji idx label) " " label " (" (count grp) ")"))
  (doseq [te grp]
  (println (str "  " (short-id te) "  " (trunc (title-of idx te) 52)))))))

(defn- in-condition [idx nonterm ^String today before? ^String c]
  (filterv (fn [te] (= (proj/condition-i idx te today before?) c)) nonterm))

(defn cmd-board [^String log]
  (let [idx (live-idx log)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?
   nonterm (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx))]
  (println (str "BOARD — " (count nonterm) " open"))
  (board-group idx "active" (in-condition idx nonterm today before? "active"))
  (board-group idx "ready" (in-condition idx nonterm today before? "ready"))
  (board-group idx "blocked" (in-condition idx nonterm today before? "blocked"))
  (board-group idx "dormant" (in-condition idx nonterm today before? "dormant"))
  (board-group idx "draft" (in-condition idx nonterm today before? "draft"))))

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
  (let [claims (live-claims log)
   idx (k/build-index claims)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?]
  (cond
  (or (= what "board") (= what "plate")) (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before?)) (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx)))))
  (= what "ready") (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before?)) (proj/ready idx today before?))))
  (= what "blocked") (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before?)) (filterv (fn [te] (= (proj/condition-i idx te today before?) "blocked")) (proj/work-thread-ids-i idx)))))
  (= what "needs-review") (let [as (fram.rt/read-log log)
   cidx (k/build-index (:claims (fold/fold as)))
   latest (fold/fold-latest as)
   today (fram.rt/today-iso)
   reviews (stale/needs-review cidx latest today (fn [a b] (fram.rt/str-lt? a b)))]
  (println (fram.rt/to-json (mapv (fn [rv] (->JReview (short-id (:te rv)) (title-of cidx (:te rv)) (:pred rv) (:detail rv))) reviews))))
  (= what "clock-report") (let [rs (clk/rows idx (fn [s] (fram.rt/iso-to-seconds s)) (fn [s] (fram.rt/parse-int s)))
   cal (clk/calibration rs)]
  (println (fram.rt/to-json (->JClockReport (mapv (fn [r] (->JClockRow (short-id (:te r)) (title-of idx (:te r)) (:est-h r) (:act-sec r) (:term r))) rs) (->JCalib (:pct cal) (:sample cal))))))
  (= what "show") (println (fram.rt/to-json (mapv (fn [c] (->JClaim (:p c) (:r c))) (k/q-by-l claims (str "@" arg)))))
  (= what "presentation") (println (fram.rt/to-json (->JPresentation (proj/condition-emoji idx "active") (proj/condition-emoji idx "ready") (proj/condition-emoji idx "blocked") (proj/condition-emoji idx "draft"))))
  :else (println "usage: json board|ready|blocked|needs-review|clock-report|show <id>|presentation"))))

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
  (let [idx (live-idx log)
   te (str "@" id)
   run (clk/running-session idx)]
  (cond
  (nil? (k/one-i idx te "title")) (println (str "no such thread: " id))
  (some? run) (println (str "already clocked in on " (short-id (session-thread idx run)) " (session " (short-id run) ") — `clock stop` first"))
  :else (let [port (fram.rt/coord-port)]
  (if (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `tern up`") (let [sid (fresh-sid idx (fram.rt/now-id))
   ssub (str "@" sid)
   now (fram.rt/now-iso)
   r1 (tell-retry port "assert" ssub "session_of" te 5)
   r2 (tell-retry port "assert" ssub "start_time" now 5)]
  (if (and (str/starts-with? r1 "ok:") (str/starts-with? r2 "ok:")) (println (str "clocked in on " id " at " now "  (session " sid ")")) (println (str "clock start FAILED to record (" r1 "/" r2 ") — retry")))))))))

(defn cmd-clock-stop [^String log]
  (let [idx (live-idx log)
   run (clk/running-session idx)
   port (fram.rt/coord-port)]
  (cond
  (nil? run) (println "not clocked in")
  (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `tern up` (still clocked in)")
  :else (let [now (fram.rt/now-iso)
   st (k/one-i idx run "start_time")
   te (session-thread idx run)
   dur (if (some? st) (- (fram.rt/iso-to-seconds now) (fram.rt/iso-to-seconds st)) 0)
   resp (tell-retry port "assert" run "end_time" now 5)]
  (if (str/starts-with? resp "ok:") (println (str "clocked out of " (short-id te) " — this session " (fmt-hm dur))) (println (str "clock stop FAILED to record end_time (" resp ") — still clocked in, retry")))))))

(defn cmd-clock-status [^String log]
  (let [idx (live-idx log)
   run (clk/running-session idx)]
  (if (nil? run) (println "not clocked in") (let [now (fram.rt/now-iso)
   st (k/one-i idx run "start_time")
   te (session-thread idx run)
   dur (if (some? st) (- (fram.rt/iso-to-seconds now) (fram.rt/iso-to-seconds st)) 0)]
  (println (str "clocked in on " (short-id te) "  " (trunc (title-of idx te) 40)))
  (println (str "  since " (if (some? st) st "?") "  (" (fmt-hm dur) " elapsed)"))))))

(defn cmd-clock-report [^String log]
  (let [idx (live-idx log)
   rs (clk/rows idx (fn [s] (fram.rt/iso-to-seconds s)) (fn [s] (fram.rt/parse-int s)))
   cal (clk/calibration rs)]
  (println (str "TIME LOGGED — estimate vs actual (" (count rs) " thread(s))"))
  (doseq [r rs]
  (println (str "  " (short-id (:te r)) "  est " (:est-h r) "h  actual " (fmt-hm (:act-sec r)) "  " (trunc (title-of idx (:te r)) 38))))
  (if (> (:sample cal) 0) (println (str "\nCALIBRATION — across " (:sample cal) " done thread(s) with both: actuals ran " (:pct cal) "% of estimate" (if (> (:pct cal) 100) " (you under-estimate)" " (you over-estimate)"))) (println "\nCALIBRATION — not enough completed estimate+actual data yet"))))

(defn cmd-clock-sync [^String log]
  (let [idx (live-idx log)
   dir (fram.rt/time-dir)
   sessions (clk/syncable-sessions idx)
   port (fram.rt/coord-port)]
  (cond
  (empty? sessions) (println "nothing to sync — no closed, unsynced sessions")
  (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `tern up` (sync records clockify_id, so it must be up first)")
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
  (let [idx (live-idx log)
   rs (clk/logged-rows idx prefixes (fn [s] (fram.rt/iso-to-seconds s)))
   total (reduce (fn [m r] (+ m (:act-sec r))) 0 rs)]
  (println (str "LOGGED " label " — " (fmt-hm total) " across " (count rs) " thread(s)"))
  (doseq [r rs]
  (println (str "  " (fmt-hm (:act-sec r)) "  " (short-id (:te r)) "  " (trunc (title-of idx (:te r)) 40))))))

(defn cmd-clock-today [^String log]
  (clock-window log (conj [] (subs (fram.rt/now-iso) 0 10)) "today"))

(defn cmd-clock-week [^String log]
  (clock-window log (fram.rt/this-week-dates) "this week"))

(defrecord Probe [up serving fresh port status daemon-v log-v log-claims idx stale hand log-behind])

(defn probe-up [r] (:up r))

(defn probe-serving [r] (:serving r))

(defn probe-fresh [r] (:fresh r))

(defn probe-port [r] (:port r))

(defn probe-status [r] (:status r))

(defn probe-daemon-v [r] (:daemon-v r))

(defn probe-log-v [r] (:log-v r))

(defn probe-log-claims [r] (:log-claims r))

(defn probe-idx [r] (:idx r))

(defn probe-stale [r] (:stale r))

(defn probe-hand [r] (:hand r))

(defn probe-log-behind [r] (:log-behind r))

(defn- ^Boolean stale-projection? [idx c]
  (and (k/single? (:p c)) (let [v (k/one-i idx (:l c) (:p c))]
  (and (some? v) (not (= v (:r c)))))))

(defn- ^Probe probe [^String threads-dir ^String log]
  (let [port (fram.rt/coord-port)
   status (fram.rt/coord-status port)
   up (not (= status "down"))
   serving (str/includes? status log)
   f (fold/fold (fram.rt/read-log log))
   log-claims (:claims f)
   log-v (:version f)
   daemon-v (fram.rt/coord-version port)
   fresh (>= daemon-v log-v)
   idx (k/build-index log-claims)
   file-claims (:claims (fold/fold (imp/load-corpus threads-dir)))
   thread-log (filterv (fn [c] (some? (k/one-i idx (:l c) "title"))) log-claims)
   tl-sigs (sig-member-map thread-log)
   file-sigs (sig-member-map file-claims)
   file-ahead (filterv (fn [c] (nil? (get tl-sigs (claim-sig c)))) file-claims)
   log-behind (filterv (fn [c] (nil? (get file-sigs (claim-sig c)))) thread-log)
   stale (filterv (fn [c] (stale-projection? idx c)) file-ahead)
   hand (filterv (fn [c] (not (stale-projection? idx c))) file-ahead)]
  (->Probe up serving fresh port status daemon-v log-v log-claims idx stale hand log-behind)))

(defn- ^Boolean safe? [^Probe p]
  (and (:up p) (and (:serving p) (:fresh p))))

(defn- ^String safety-line [^Probe p]
  (if (safe? p) "healthy: tell/untell + warm reads are safe" (cond
  (not (:up p)) (str "DEGRADED: coordinator DOWN on 127.0.0.1:" (:port p) " — run `tern up` (writes won't serialize)")
  (not (:serving p)) (str "DEGRADED: daemon not serving the canonical log — status: " (:status p))
  :else (str "DEGRADED: daemon STALE (loaded v" (:daemon-v p) " behind log v" (:log-v p) ") — the log changed out-of-band; restart it + `tern up`"))))

(defn- ^String hygiene-line [^Probe p]
  (let [ns (count (:stale p))
   nh (count (:hand p))
   nb (count (:log-behind p))]
  (if (and (= ns 0) (and (= nh 0) (= nb 0))) "" (str "hygiene: " (+ ns nb) " stale/lagging projection claim(s) — run `tern heal`" (if (> nh 0) (str "; " nh " hand-edited claim(s) — reconcile via tell/import") "")))))

(defn cmd-doctor [^String threads-dir ^String log]
  (let [p (probe threads-dir log)]
  (println "tern doctor")
  (if (:up p) (do
  (println (str "  [ok]    coordinator UP on 127.0.0.1:" (:port p)))
  (if (:serving p) (println "  [ok]    serving the canonical log") (println (str "  [WARN]  daemon is NOT serving " log " — status: " (:status p))))
  (if (:fresh p) (if (= (:daemon-v p) (:log-v p)) (println "  [ok]    daemon state matches the on-disk log") (println (str "  [ok]    daemon current with the log (loaded v" (:daemon-v p) " > log v" (:log-v p) " — in-memory lease txs, never flat-logged)"))) (println (str "  [WARN]  daemon is STALE (loaded v" (:daemon-v p) " behind log v" (:log-v p) ") — the log changed out-of-band; restart: kill it + `tern up`")))) (println (str "  [DOWN]  no coordinator on 127.0.0.1:" (:port p) " — writes won't serialize. Run `tern up`.")))
  (if (safe? p) (println "  => healthy: tell/untell + warm reads are safe") (println "  => DEGRADED: fix the warnings above"))
  (println "  hygiene:")
  (let [ns (count (:stale p))
   nh (count (:hand p))
   nb (count (:log-behind p))]
  (if (and (= ns 0) (and (= nh 0) (= nb 0))) (println "    [ok]    files <-> claim log in sync") (do
  (if (> ns 0) (do
  (println (str "    " ns " stale projection claim(s) — run `tern heal`"))))
  (if (> nh 0) (do
  (println (str "    " nh " genuinely-new file claim(s) (hand edits) — reconcile via tell or import"))))
  (if (> nb 0) (do
  (println (str "    " nb " log claim(s) not yet in files — benign projection lag; run `tern heal`")))))))))

(defn- distinct-ids [xs]
  (reduce (fn [acc x] (if (k/vec-contains? acc x) acc (conj acc x))) [] xs))

(defn- heal-targets [^Probe p]
  (distinct-ids (mapv (fn [c] (:l c)) (vec (concat (:stale p) (:log-behind p))))))

(defn- ^String file-subject [^String content]
  (let [lines (fram.rt/split-on content "\n")
   n (count lines)]
  (loop [i 0]
  (cond
  (>= i n) ""
  (= "---" (str/trim (nth lines i))) ""
  (str/starts-with? (str/trim (nth lines i)) "@") (str/trim (nth lines i))
  :else (recur (+ i 1))))))

(defn- ^String basename [^String threads-dir ^String path]
  (let [pre (+ (count threads-dir) 1)]
  (if (> (count path) pre) (subs path pre) path)))

(defn- ^String file-owner [ids ^String name]
  (reduce (fn [best id] (if (and (or (str/starts-with? name (str id "-")) (= name (str id ".md"))) (> (count id) (count best))) id best)) "" ids))

(defrecord FileInfo [path owner head])

(defn fileinfo-path [r] (:path r))

(defn fileinfo-owner [r] (:owner r))

(defn fileinfo-head [r] (:head r))

(defn- scan-files [^String threads-dir files ids]
  (mapv (fn [path] (->FileInfo path (file-owner ids (basename threads-dir path)) (file-subject (fram.rt/slurp path)))) files))

(defn- ^String path-of [scan ^String id]
  (reduce (fn [acc fi] (if (and (str/blank? acc) (= (:owner fi) id)) (:path fi) acc)) "" scan))

(defn- broken-head-ids [scan idx]
  (distinct-ids (reduce (fn [acc fi] (if (and (not (str/blank? (:owner fi))) (and (not (= (:head fi) (str "@" (:owner fi)))) (some? (k/one-i idx (str "@" (:owner fi)) "title")))) (conj acc (:owner fi)) acc)) [] scan)))

(defn cmd-heal [^String threads-dir ^String log]
  (let [p (probe threads-dir log)]
  (cond
  (not (empty? (:hand p))) (do
  (println (str "heal REFUSED — " (count (:hand p)) " genuinely-new file claim(s) not in the log " "(hand edits). A human decides: adopt via `tell`, or bulk `import`. Nothing was touched:"))
  (doseq [c (:hand p)]
  (println (str "    " (short-id (:l c)) "  " (:p c) "  " (trunc (:r c) 72)))))
  :else (let [files (fram.rt/list-md threads-dir)
   ids (mapv (fn [te] (short-id te)) (k/thread-ids-i (:idx p)))
   scan (scan-files threads-dir files ids)
   diff-ids (mapv (fn [te] (short-id te)) (heal-targets p))
   targets (distinct-ids (vec (concat diff-ids (broken-head-ids scan (:idx p)))))]
  (if (empty? targets) (println "heal: nothing to do — every thread file already matches the log.") (do
  (doseq [id targets]
  (let [te (str "@" id)
   title (let [t (k/one-i (:idx p) te "title")]
  (if (some? t) t "untitled"))
   existing (path-of scan id)
   path (if (str/blank? existing) (str threads-dir "/" id "-" (fram.rt/slugify title) ".md") existing)]
  (fram.rt/spit-file path (exp/thread-md (:log-claims p) te))
  (println (str "  re-rendered " id "  " (trunc title 52)))))
  (println (str "heal: re-rendered " (count targets) " thread file(s) from the log. Log untouched."))))))))

(defrecord EntryPoint [te note created])

(defn entrypoint-te [r] (:te r))

(defn entrypoint-note [r] (:note r))

(defn entrypoint-created [r] (:created r))

(defn- ^String entry-note [idx ^String te]
  (reduce (fn [acc v] (if (and (str/blank? acc) (str/starts-with? v "SESSION ENTRY POINT")) v acc)) "" (k/many-i idx te "note")))

(defn- ^EntryPoint find-entry [idx]
  (reduce (fn [best te] (let [note (entry-note idx te)]
  (if (str/blank? note) best (let [c (let [cc (k/one-i idx te "created_at")]
  (if (some? cc) cc ""))]
  (if (or (str/blank? (:te best)) (fram.rt/str-lt? (:created best) c)) (->EntryPoint te note c) best))))) (->EntryPoint "" "" "") (k/thread-ids-i idx)))

(defn cmd-boot [^String threads-dir ^String log]
  (let [p (probe threads-dir log)
   idx (:idx p)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?]
  (println (str "=> " (safety-line p)))
  (let [h (hygiene-line p)]
  (if (not (str/blank? h)) (do
  (println (str "   " h)))))
  (let [e (find-entry idx)]
  (if (str/blank? (:te e)) (println "\nENTRY POINT — none (no thread carries a `SESSION ENTRY POINT` note)") (do
  (println (str "\nENTRY POINT — " (short-id (:te e)) "  " (title-of idx (:te e))))
  (println (:note e))
  (let [ls (k/many-i idx (:te e) "learning")]
  (if (not (empty? ls)) (do
  (println "\nSTANDING MANDATES (learning):")
  (doseq [l ls]
  (println (str "  - " l)))))))))
  (let [nonterm (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx))]
  (println (str "\nBOARD — active " (count (in-condition idx nonterm today before? "active")) "  ready " (count (in-condition idx nonterm today before? "ready")) "  blocked " (count (in-condition idx nonterm today before? "blocked")) "  draft " (count (in-condition idx nonterm today before? "draft"))))
  (let [cands (filterv (fn [te] (not (proj/terminal-i? idx te))) nonterm)
   items (filterv (fn [it] (> (:score it) 0)) (mapv (fn [te] (->LevItem te (proj/leverage-score idx te))) cands))
   ranked (vec (take 5 (sort-by (fn [it] (- 0 (:score it))) items)))]
  (println "TOP LEVERAGE — finishing these transitively frees the most stuck threads")
  (doseq [it ranked]
  (println (str "  unblocks " (:score it) "  " (short-id (:te it)) "  " (title-of idx (:te it)))))))))

(defn- split-ws [^String s]
  (filterv (fn [w] (not (str/blank? w))) (vec (str/split s #"\s+"))))

(defn- single-valued-preds []
  (split-ws (fram.rt/getenv-or "FRAM_SINGLE_VALUED" "")))

(defn- ^Boolean all-ref? [claims ^String pred]
  (loop [cs claims
   seen false]
  (if (empty? cs) seen (let [c (first cs)]
  (if (= (:p c) pred) (if (str/starts-with? (:r c) "@") (recur (rest cs) true) false) (recur (rest cs) seen))))))

(defn- distinct-preds [claims]
  (reduce (fn [acc c] (if (k/vec-contains? acc (:p c)) acc (conj acc (:p c)))) [] claims))

(defn- seed-claims [^String log]
  (let [claims (live-claims log)
   card (mapv (fn [p] (k/->Claim (str "@" p) "cardinality" "single")) (single-valued-preds))
   acyc (mapv (fn [p] (k/->Claim (str "@" p) "acyclic" "true")) ["depends_on" "part_of"])
   refs (filterv (fn [p] (all-ref? claims p)) (distinct-preds claims))
   vk (mapv (fn [p] (k/->Claim (str "@" p) "value_kind" "ref")) refs)]
  (vec (concat card acyc vk))))

(defn cmd-schema-seed [^String log ^Boolean execute]
  (let [seeds (seed-claims log)]
  (if (not execute) (do
  (println (str "schema-seed DRY-RUN — " (count seeds) " claim(s); nothing written."))
  (doseq [c seeds]
  (println (str "  tell " (:l c) " " (:p c) " " (:r c))))
  (println "Run `tern schema-seed --execute` (coordinator session) to write.")) (let [idx (live-idx log)
   subs (distinct-ids (mapv (fn [c] (:l c)) seeds))
   collisions (filterv (fn [s] (some? (k/one-i idx s "title"))) subs)]
  (if (not (empty? collisions)) (do
  (println (str "!!! schema-seed ABORTED — " (count collisions) " predicate name(s) collide with a live thread id."))
  (println "    Writing predicate metadata onto these would pollute real threads:")
  (doseq [s collisions]
  (println (str "      " s "  (has a `title` claim — is a thread)")))
  (println "    No claims written. Rename the colliding thread(s) or exclude the pred(s).")) (let [port (fram.rt/coord-port)]
  (if (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — writes won't serialize. Run `tern up`.") (let [results (mapv (fn [c] (tell-retry port "assert" (:l c) (:p c) (:r c) 5)) seeds)
   oks (count (filterv (fn [r] (str/starts-with? r "ok:")) results))]
  (println (str "schema-seed EXECUTED — " oks "/" (count seeds) " claim(s) committed via coordinator."))))))))))

(defn cmd-tools []
  (do
  (println "TERN — curated tool surface (the MCP verbs; bin/tern-mcp is authoritative):")
  (println "  work queue : ready · next · board · blocked · agenda · leverage · needs-review")
  (println "  read/write : show · capture · tell · untell · validate")
  (println "  time       : clock start|stop|status|report")
  (println "  agents     : dispatch · spawn")
  (println "  view       : presentation")
  (println "")
  (println "Engine core underneath: fram = 10 tools (tell/untell/show/ask/validate + 5 graph-edit verbs).")
  (println "Vocabulary is DATA, not tools: `tern show <pred>` reveals a predicate's metadata")
  (println "(cardinality/value_kind/acyclic claims). Seed that metadata with `tern schema-seed`.")))

(defn- ^Boolean has-flag? [args ^String f]
  (not (empty? (filterv (fn [a] (= a f)) args))))

(defn run [args ^String threads-dir ^String log]
  (let [cmd (if (empty? args) "" (first args))]
  (cond
  (= cmd "capture") (if (>= (count args) 2) (cmd-capture threads-dir log (nth args 1) (if (>= (count args) 3) (nth args 2) "personal")) (println "usage: capture <title> [owner]"))
  (= cmd "ready") (cmd-ready log)
  (= cmd "blocked") (cmd-blocked log)
  (= cmd "leverage") (cmd-leverage log)
  (= cmd "next") (cmd-next log)
  (= cmd "agenda") (cmd-agenda log)
  (= cmd "board") (cmd-board log)
  (= cmd "plate") (cmd-board log)
  (= cmd "needs-review") (cmd-needs-review log)
  (= cmd "audit") (cmd-audit log)
  (= cmd "resolve") (if (>= (count args) 2) (cmd-resolve log (nth args 1)) (println "usage: resolve <@handle|@id>"))
  (= cmd "validate") (cmd-validate log)
  (= cmd "schema-seed") (cmd-schema-seed log (has-flag? args "--execute"))
  (= cmd "tools") (cmd-tools)
  (= cmd "doctor") (cmd-doctor threads-dir log)
  (= cmd "heal") (cmd-heal threads-dir log)
  (= cmd "boot") (cmd-boot threads-dir log)
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
  :else (println "tern usage: capture <title> [owner] | ready | blocked | leverage | next | agenda | board | needs-review | audit | resolve <@handle|@id> | validate | schema-seed [--dry-run|--execute] | tools | doctor | heal | boot | listen <agent-id> | json <...> | clock <start|stop|status|report|today|week|sync|map|projects|workspaces>   (engine verbs import/export/show/set/tell/merge route to fram)"))))

(defn -main [& args]
  (run (vec args) (fram.rt/threads-dir) (fram.rt/log-path)))
