(ns north.main
  (:gen-class)
  (:require [fram.kernel :as k]
            [fram.fold :as fold]
            [fram.import :as imp]
            [fram.export :as exp]
            [north.projections :as proj]
            [north.validate :as val]
            [north.staleness :as stale]
            [north.clock :as clk]
            [north.audit :as audit]
            [north.clockify :as cf]
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

(defn- ^String kind-bucket [^String ek]
  (cond
  (= ek "concern") "concern"
  (= ek "thread") "thread"
  (= ek "mine") "mine"
  (or (= ek "run") (or (= ek "session") (= ek "lane"))) "session-telemetry"
  :else ek))

(defn- ^String namespace-kind [^String bare]
  (cond
  (str/starts-with? bare "concern-") "concern"
  (str/starts-with? bare "agent:") "agent"
  (str/starts-with? bare "msg:") "msg"
  (str/starts-with? bare "topic-") "topic"
  (str/starts-with? bare "mine:") "mine"
  (or (str/starts-with? bare "session:") (or (str/starts-with? bare "sess-") (or (str/starts-with? bare "run-") (or (str/starts-with? bare "snapshot:") (or (str/starts-with? bare "arena-") (or (str/starts-with? bare "cc-") (str/starts-with? bare "cmd:"))))))) "session-telemetry"
  :else ""))

(defn- ^String kind-of [idx ^String te]
  (let [ek (k/one-i idx te "kind")]
  (if (some? ek) (kind-bucket ek) (let [np (namespace-kind (short-id te))]
  (if (not (str/blank? np)) np (if (some? (k/one-i idx te "title")) "thread" (if (or (some? (k/one-i idx te "cardinality")) (or (some? (k/one-i idx te "value_kind")) (some? (k/one-i idx te "acyclic")))) "predicate" "other")))))))

(defn- ^String driver-label [idx ^String te]
  (let [d (k/one-i idx te "driver")]
  (if (nil? d) "" (let [dn (k/one-i idx d "display_name")]
  (if (some? dn) dn (short-id d))))))

(defrecord LevItem [te score])

(defn levitem-te [r] (:te r))

(defn levitem-score [r] (:score r))

(defrecord NextItem [te score])

(defn nextitem-te [r] (:te r))

(defn nextitem-score [r] (:score r))

(defrecord AgendaItem [te do_on])

(defn agendaitem-te [r] (:te r))

(defn agendaitem-do_on [r] (:do_on r))

(defn- ^String fact-sig [c]
  (str (:l c) "|" (:p c) "|" (:r c)))

(defn- sig-member-map [facts]
  (reduce (fn [m c] (assoc m (fact-sig c) true)) {} facts))

(defn- read-logs-merged [^String log]
  (let [tlog (fram.rt/getenv-or "FRAM_TELEMETRY_LOG" "")]
  (if (= tlog "") (fram.rt/read-log log) (into (fram.rt/read-log log) (fram.rt/read-log tlog)))))

(defn- retracted-sigs [ops]
  (reduce (fn [m a] (if (= (:op a) "retract") (assoc m (str (:l a) "|" (:p a) "|" (:r a)) true) m)) {} ops))

(defn- live-facts [^String log]
  (let [warm (fram.rt/coord-live-facts (fram.rt/coord-port) log)]
  (if (empty? warm) (:facts (fold/fold (read-logs-merged log))) warm)))

(defn- live-idx [^String log]
  (k/build-index (live-facts log)))

(defn- ^String tell-once [port ^String op ^String te ^String pred ^String rv]
  (let [v (fram.rt/coord-version port)]
  (if (< v 0) "nodaemon" (if (= op "assert") (fram.rt/coord-assert port te pred rv v) (fram.rt/coord-retract port te pred rv v)))))

(defn- ^String tell-retry [port ^String op ^String te ^String pred ^String rv tries]
  (let [resp (tell-once port op te pred rv)]
  (if (and (= resp "conflict") (> tries 0)) (tell-retry port op te pred rv (- tries 1)) resp)))

(defn- ^Boolean ctrl? [^String s]
  (or (str/includes? s "\n") (str/includes? s "\r")))

(defn- add-fact [acc ^String te ^String p ^String v]
  (if (str/blank? v) acc (conj acc (k/->Fact te p v))))

(defn- ^String ref-or-blank [^String v]
  (if (str/blank? v) "" (str "@" v)))

(defn- capture-facts [^String te ^String title ^String owner ^String source ^String author ^String lead ^String proposed ^String created-at ^String today]
  (let [c (add-fact [] te "title" title)
   c (add-fact c te "kind" "thread")
   c (if (= owner "personal") c (add-fact c te "owner" owner))
   c (add-fact c te "source" source)
   c (add-fact c te "created_by" (ref-or-blank author))
   c (add-fact c te "lead" (ref-or-blank lead))
   c (add-fact c te "proposed_by" (ref-or-blank proposed))
   c (add-fact c te "created_at" created-at)
   c (add-fact c te "updated_at" today)
   c (add-fact c te "committed" today)]
  c))

(defn cmd-capture [^String threads-dir ^String log ^String title ^String owner]
  (let [source (fram.rt/getenv-or "NORTH_SOURCE" "self")
   author (fram.rt/getenv-or "NORTH_AUTHOR" "you")
   lead (fram.rt/getenv-or "NORTH_LEAD" "")
   proposed (fram.rt/getenv-or "NORTH_PROPOSED_BY" "")]
  (cond
  (or (str/blank? title) (ctrl? title)) (println "usage: capture <title> [owner]   (title must be a non-empty single line)")
  (ctrl? owner) (println "capture: owner must be a single line")
  (or (ctrl? source) (ctrl? author) (ctrl? lead) (ctrl? proposed)) (println "capture: NORTH_SOURCE/AUTHOR/LEAD/PROPOSED_BY must each be a single line")
  :else (do
  (fram.rt/ensure-dir threads-dir)
  (let [id (uuidv7)
   slug (fram.rt/slugify title)
   today (fram.rt/today-iso)
   created-at (fram.rt/now-iso)
   te (str "@" id)
   path (str threads-dir "/" id "-" slug ".md")
   port (fram.rt/coord-port)]
  (if (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — writes won't serialize. Run `north up`.") (let [facts (capture-facts te title owner source author lead proposed created-at today)
   results (mapv (fn [c] (tell-retry port "assert" (:l c) (:p c) (:r c) 5)) facts)
   oks (count (filterv (fn [r] (str/starts-with? r "ok:")) results))]
  (if (= oks (count facts)) (do
  (fram.rt/spit-file path (exp/thread-md (:facts (fold/fold (fram.rt/read-log log))) te))
  (println (str "captured -> " te "  " title "  [owner: " owner "]\n" "  file:      " path "\n" "  committed: " oks " facts via coordinator. Next: north tell " id " <pred> <value>"))) (println (str "capture PARTIAL: only " oks "/" (count facts) " fact(s) committed (write conflict / no daemon?). Re-run — nothing is stranded in files."))))))))))

(defn- ^Boolean id-like? [^String bare]
  (and (not (str/blank? bare)) (str/blank? (str/replace bare #"[0-9a-f-]" "")) (or (str/includes? bare "-") (>= (count bare) 8))))

(defn cmd-resolve [^String log ^String ref]
  (let [idx (live-idx log)
   r (resolve-ref idx ref)]
  (if (and (= r ref) (id-like? (short-id ref)) (nil? (k/one-i idx (str "@" (short-id ref)) "title"))) (println (str "ERROR unresolved id-like ref " ref " — not a thread id, unique prefix, or handle" " (ambiguous/truncated? `north show " (short-id ref) "` lists candidates)")) (println r))))

(defn cmd-done-bars [^String log ^String ref]
  (let [idx (live-idx log)
   te (resolve-ref idx (if (str/starts-with? ref "@") ref (str "@" ref)))
   bars (k/many-i idx te "done_when")
   evs (k/many-i idx te "bar_evidence")]
  (if (empty? bars) nil (do
  (println (str "DONE BARS on " te " — this outcome claims they are met; cite probe + observed result:"))
  (doseq [b bars]
  (println (str "  " (stale/bar-mark evs b) " " b)))
  (println (str "  evidence: north tell " (short-id te) " bar_evidence \"<bar> → <observed result>\""))))))

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

(defn cmd-ready [^String log ^Boolean all]
  (let [idx (live-idx log)
   today (fram.rt/today-iso)
   raw (proj/ready idx today fram.rt/str-lt?)
   rs (if all raw (filterv (fn [te] (= (kind-of idx te) "thread")) raw))
   ranked (vec (sort-by (fn [te] (- 0 (proj/leverage-score idx te))) rs))
   shown (if all ranked (vec (take 15 ranked)))]
  (if all (println (str "READY NOW — " (count rs))) (println (str "READY NOW — top " (count shown) " of " (count rs) " by leverage")))
  (println "  ready = committed + unblocked, start anytime (vs open = merely not-done, may still be blocked)")
  (doseq [te shown]
  (println (str "  " (short-id te) "  " (trunc (title-of idx te) 56))))
  (if (and (not all) (> (count rs) (count shown))) (do
  (println (str "  … +" (- (count rs) (count shown)) " more · north ready --all"))))))

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

(defn- lease-exp-secs [idx ^String driverref]
  (let [handle (short-id driverref)
   v (k/one-i idx (str "@lease:session:" handle) "lease")]
  (if (nil? v) -1 (let [parts (str/split v #"\|")]
  (if (< (count parts) 2) -1 (let [expms (nth parts 1)]
  (if (> (count expms) 3) (fram.rt/parse-int (subs expms 0 (- (count expms) 3))) -1)))))))

(defn- dt->secs [^String s]
  (cond
  (fram.rt/is-iso-datetime-19 s) (fram.rt/iso-to-seconds s)
  (fram.rt/is-iso-datetime-16 s) (fram.rt/iso-to-seconds s)
  (and (= 10 (count s)) (fram.rt/is-iso-datetime-19 (str s "T00:00:00"))) (fram.rt/iso-to-seconds (str s "T00:00:00"))
  :else -1))

(defn- ^Boolean driver-live? [idx ^String te now-secs window-secs]
  (let [d (k/one-i idx te "driver")]
  (if (nil? d) false (let [e (lease-exp-secs idx d)]
  (if (and (> e 0) (> e now-secs)) true (let [u (k/one-i idx te "updated_at")]
  (if (nil? u) false (let [us (dt->secs u)]
  (and (> us 0) (< (- now-secs us) window-secs))))))))))

(defn- driver-stale-window-secs []
  (let [d (fram.rt/parse-int (fram.rt/getenv-or "NORTH_DRIVER_STALE_DAYS" "14"))]
  (* (if (> d 0) d 14) 86400)))

(defn- board-full [idx ^String today before? nonterm]
  (do
  (println (str "THREADS — " (count nonterm) " open"))
  (board-group idx "active" (in-condition idx nonterm today before? "active"))
  (board-group idx "ready" (in-condition idx nonterm today before? "ready"))
  (board-group idx "blocked" (in-condition idx nonterm today before? "blocked"))
  (board-group idx "dormant" (in-condition idx nonterm today before? "dormant"))
  (board-group idx "draft" (in-condition idx nonterm today before? "draft"))))

(defn- board-curated [idx ^String today before? nonterm now-secs window-secs]
  (let [threads (filterv (fn [te] (= (kind-of idx te) "thread")) nonterm)
   active-all (in-condition idx threads today before? "active")
   active (filterv (fn [te] (driver-live? idx te now-secs window-secs)) active-all)
   nparked (- (count active-all) (count active))
   readyl (in-condition idx threads today before? "ready")
   blockedl (in-condition idx threads today before? "blocked")
   nconcern (count (filterv (fn [s] (= (kind-of idx s) "concern")) (:subjects idx)))
   ashow (vec (take 20 active))
   ritems (mapv (fn [te] (->LevItem te (proj/leverage-score idx te))) readyl)
   rranked (vec (take 15 (sort-by (fn [it] (- 0 (:score it))) ritems)))]
  (println (str "THREADS — " (count threads) " open threads · " (count active) " active · " (count readyl) " ready · " (count blockedl) " blocked · " nconcern " concerns   (north threads --all for the full kanban)"))
  (println "  open = not done · active = being driven now · ready = committed + unblocked, start anytime · blocked = waiting on a dependency")
  (if (not (empty? active)) (do
  (println (str "\n" (proj/condition-emoji idx "active") " ACTIVE — who's on what (" (count active) ")"))
  (doseq [te ashow]
  (println (str "  " (let [dl (driver-label idx te)]
  (if (str/blank? dl) "?" dl)) "  " (short-id te) "  " (trunc (title-of idx te) 44))))
  (if (> (count active) (count ashow)) (do
  (println (str "  … +" (- (count active) (count ashow)) " more · north threads --all"))))))
  (if (> nparked 0) (do
  (println (str "\n" nparked " parked driver(s) — stale, not shown (north threads --all)"))))
  (println (str "\n" (proj/condition-emoji idx "ready") " READY — top " (count rranked) " of " (count readyl) " by leverage"))
  (doseq [it rranked]
  (println (str "  unblocks " (:score it) "  " (short-id (:te it)) "  " (trunc (title-of idx (:te it)) 44))))
  (if (> (count readyl) (count rranked)) (do
  (println (str "  … +" (- (count readyl) (count rranked)) " more · north threads --all"))))
  (println "  machinery/agents/daemons → north dashboard")))

(defn cmd-board [^String log ^Boolean all]
  (let [idx (live-idx log)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?
   nonterm (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx))]
  (if all (board-full idx today before? nonterm) (board-curated idx today before? nonterm (fram.rt/iso-to-seconds (fram.rt/now-iso)) (driver-stale-window-secs)))))

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

(defrecord JFact [predicate value])

(defn jfact-predicate [r] (:predicate r))

(defn jfact-value [r] (:value r))

(defrecord JSubjectFact [subject predicate value])

(defn jsubjectfact-subject [r] (:subject r))

(defn jsubjectfact-predicate [r] (:predicate r))

(defn jsubjectfact-value [r] (:value r))

(defrecord JAgentFact [id predicate value])

(defn jagentfact-id [r] (:id r))

(defn jagentfact-predicate [r] (:predicate r))

(defn jagentfact-value [r] (:value r))

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

(defn- ready-curated-tes [idx ^String today before? ^Boolean all?]
  (let [raw (proj/ready idx today before?)
   rs (if all? raw (filterv (fn [te] (= (kind-of idx te) "thread")) raw))
   ranked (vec (sort-by (fn [te] (- 0 (proj/leverage-score idx te))) rs))]
  (if all? ranked (vec (take 15 ranked)))))

(defn- board-curated-tes [idx ^String today before? ^Boolean all?]
  (let [nonterm (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx))]
  (if all? nonterm (let [threads (filterv (fn [te] (= (kind-of idx te) "thread")) nonterm)
   now-secs (fram.rt/iso-to-seconds (fram.rt/now-iso))
   window-secs (driver-stale-window-secs)
   active (filterv (fn [te] (driver-live? idx te now-secs window-secs)) (in-condition idx threads today before? "active"))
   ready (vec (take 15 (sort-by (fn [te] (- 0 (proj/leverage-score idx te))) (in-condition idx threads today before? "ready"))))]
  (vec (concat active ready))))))

(defn cmd-json [^String log ^String what ^String arg ^Boolean all?]
  (let [facts (live-facts log)
   idx (k/build-index facts)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?]
  (cond
  (or (= what "board") (= what "plate")) (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before?)) (board-curated-tes idx today before? all?))))
  (= what "ready") (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before?)) (ready-curated-tes idx today before? all?))))
  (= what "blocked") (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before?)) (filterv (fn [te] (= (proj/condition-i idx te today before?) "blocked")) (proj/work-thread-ids-i idx)))))
  (= what "needs-review") (let [as (fram.rt/read-log log)
   cidx (k/build-index (:facts (fold/fold as)))
   latest (fold/fold-latest as)
   today (fram.rt/today-iso)
   reviews (stale/needs-review cidx latest today (fn [a b] (fram.rt/str-lt? a b)))]
  (println (fram.rt/to-json (mapv (fn [rv] (->JReview (short-id (:te rv)) (title-of cidx (:te rv)) (:pred rv) (:detail rv))) reviews))))
  (= what "clock-report") (let [rs (clk/rows idx (fn [s] (fram.rt/iso-to-seconds s)) (fn [s] (fram.rt/parse-int s)))
   cal (clk/calibration rs)]
  (println (fram.rt/to-json (->JClockReport (mapv (fn [r] (->JClockRow (short-id (:te r)) (title-of idx (:te r)) (:est-h r) (:act-sec r) (:term r))) rs) (->JCalib (:pct cal) (:sample cal))))))
  (= what "show") (println (fram.rt/to-json (mapv (fn [c] (->JFact (:p c) (:r c))) (k/q-by-l facts (str "@" arg)))))
  (= what "show-many") (let [subjects (filterv (fn [s] (not (str/blank? s))) (mapv (fn [s] (short-id s)) (vec (str/split arg #","))))
   subject-set (reduce (fn [m s] (assoc m (str "@" s) true)) {} subjects)]
  (println (fram.rt/to-json (mapv (fn [c] (->JSubjectFact (short-id (:l c)) (:p c) (:r c))) (filterv (fn [c] (get subject-set (:l c) false)) facts)))))
  (= what "agents") (println (fram.rt/to-json (mapv (fn [c] (->JAgentFact (subs (:l c) (count "@agent:")) (:p c) (:r c))) (filterv (fn [c] (let [l (:l c)]
  (and (some? l) (str/starts-with? l "@agent:")))) facts))))
  (= what "presentation") (println (fram.rt/to-json (->JPresentation (proj/condition-emoji idx "active") (proj/condition-emoji idx "ready") (proj/condition-emoji idx "blocked") (proj/condition-emoji idx "draft"))))
  :else (println "usage: json board|ready|blocked|needs-review|clock-report|show <id>|show-many <id,id,...>|agents|presentation"))))

(defn cmd-needs-review [^String log]
  (let [as (fram.rt/read-log log)
   idx (k/build-index (:facts (fold/fold as)))
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

(defn- ^String agent-id []
  (let [a (fram.rt/getenv-or "NORTH_AGENT_ID" "")]
  (if (not (str/blank? a)) a (let [b (fram.rt/getenv-or "AGENT_ID" "")]
  (if (not (str/blank? b)) b "user")))))

(defn cmd-clock-start [^String log ^String id]
  (let [idx (live-idx log)
   te (str "@" id)
   me (agent-id)
   run (clk/running-session-for idx me)]
  (cond
  (nil? (k/one-i idx te "title")) (println (str "no such thread: " id))
  (some? run) (println (str "already clocked in on " (short-id (session-thread idx run)) " (session " (short-id run) ", agent " me ") — `clock stop` first"))
  :else (let [port (fram.rt/coord-port)]
  (if (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `north up`") (let [sid (fresh-sid idx (fram.rt/now-id))
   ssub (str "@" sid)
   now (fram.rt/now-iso)
   r1 (tell-retry port "assert" ssub "session_of" te 5)
   r2 (tell-retry port "assert" ssub "start_time" now 5)
   r3 (tell-retry port "assert" ssub "clocked_by" me 5)]
  (if (and (str/starts-with? r1 "ok:") (and (str/starts-with? r2 "ok:") (str/starts-with? r3 "ok:"))) (println (str "clocked in on " id " at " now "  (session " sid ", agent " me ")")) (println (str "clock start FAILED to record (" r1 "/" r2 "/" r3 ") — retry")))))))))

(defn cmd-clock-stop [^String log]
  (let [idx (live-idx log)
   me (agent-id)
   run (clk/running-session-for idx me)
   port (fram.rt/coord-port)]
  (cond
  (nil? run) (println (str "not clocked in (agent " me ")"))
  (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `north up` (still clocked in)")
  :else (let [now (fram.rt/now-iso)
   st (k/one-i idx run "start_time")
   te (session-thread idx run)
   dur (if (some? st) (- (fram.rt/iso-to-seconds now) (fram.rt/iso-to-seconds st)) 0)
   resp (tell-retry port "assert" run "end_time" now 5)]
  (if (str/starts-with? resp "ok:") (println (str "clocked out of " (short-id te) " — this session " (fmt-hm dur))) (println (str "clock stop FAILED to record end_time (" resp ") — still clocked in, retry")))))))

(defn cmd-clock-orphan [^String log ^String agent]
  (let [idx (live-idx log)
   run (clk/running-session-for idx agent)
   port (fram.rt/coord-port)]
  (cond
  (nil? run) (println (str "no open session for agent " agent " — nothing to orphan"))
  (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `north up`")
  :else (let [now (fram.rt/now-iso)
   te (session-thread idx run)
   r1 (tell-retry port "assert" run "end_time" now 5)
   r2 (tell-retry port "assert" run "clock_orphaned" "true" 5)]
  (if (and (str/starts-with? r1 "ok:") (str/starts-with? r2 "ok:")) (println (str "orphan-closed " (short-id run) " on " (short-id te) " at " now "  (agent " agent ", clock_orphaned)")) (println (str "clock orphan FAILED (" r1 "/" r2 ") — retry")))))))

(defn cmd-clock-status [^String log]
  (let [idx (live-idx log)
   me (agent-id)
   run (clk/running-session-for idx me)
   othern (let [n (count (clk/open-sessions idx))]
  (if (some? run) (- n 1) n))]
  (if (nil? run) (do
  (println (str "not clocked in (agent " me ")"))
  (if (> othern 0) (do
  (println (str "  (" othern " other agent session(s) open)"))))) (let [now (fram.rt/now-iso)
   st (k/one-i idx run "start_time")
   te (session-thread idx run)
   dur (if (some? st) (- (fram.rt/iso-to-seconds now) (fram.rt/iso-to-seconds st)) 0)]
  (println (str "clocked in on " (short-id te) "  " (trunc (title-of idx te) 40) "  (agent " me ")"))
  (println (str "  since " (if (some? st) st "?") "  (" (fmt-hm dur) " elapsed)"))
  (if (> othern 0) (do
  (println (str "  + " othern " other agent session(s) open"))))))))

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
  (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — run `north up` (sync records clockify_id, so it must be up first)")
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

(defrecord Probe [up serving fresh port status daemon-v log-v log-facts idx stale hand log-behind tombstoned])

(defn probe-up [r] (:up r))

(defn probe-serving [r] (:serving r))

(defn probe-fresh [r] (:fresh r))

(defn probe-port [r] (:port r))

(defn probe-status [r] (:status r))

(defn probe-daemon-v [r] (:daemon-v r))

(defn probe-log-v [r] (:log-v r))

(defn probe-log-facts [r] (:log-facts r))

(defn probe-idx [r] (:idx r))

(defn probe-stale [r] (:stale r))

(defn probe-hand [r] (:hand r))

(defn probe-log-behind [r] (:log-behind r))

(defn probe-tombstoned [r] (:tombstoned r))

(defn- ^Boolean stale-projection? [idx c]
  (and (k/single? (:p c)) (let [v (k/one-i idx (:l c) (:p c))]
  (and (some? v) (not (= v (:r c)))))))

(defn- ^Probe probe [^String threads-dir ^String log]
  (let [port (fram.rt/coord-port)
   status (fram.rt/coord-status port)
   up (not (= status "down"))
   serving (str/includes? status log)
   ops (read-logs-merged log)
   f (fold/fold ops)
   log-facts (:facts f)
   log-v (:version f)
   daemon-v (fram.rt/coord-version port)
   fresh (>= daemon-v log-v)
   idx (k/build-index log-facts)
   file-facts (:facts (fold/fold (imp/load-corpus threads-dir)))
   thread-log (filterv (fn [c] (some? (k/one-i idx (:l c) "title"))) log-facts)
   tl-sigs (sig-member-map thread-log)
   file-sigs (sig-member-map file-facts)
   file-ahead (filterv (fn [c] (nil? (get tl-sigs (fact-sig c)))) file-facts)
   log-behind (filterv (fn [c] (nil? (get file-sigs (fact-sig c)))) thread-log)
   stale (filterv (fn [c] (stale-projection? idx c)) file-ahead)
   non-stale (filterv (fn [c] (not (stale-projection? idx c))) file-ahead)
   tomb-sigs (retracted-sigs ops)
   tombstoned (filterv (fn [c] (some? (get tomb-sigs (fact-sig c)))) non-stale)
   hand (filterv (fn [c] (nil? (get tomb-sigs (fact-sig c)))) non-stale)]
  (->Probe up serving fresh port status daemon-v log-v log-facts idx stale hand log-behind tombstoned)))

(defn- ^Boolean safe? [^Probe p]
  (and (:up p) (and (:serving p) (:fresh p))))

(defn- ^String safety-line [^Probe p]
  (if (safe? p) "healthy: tell/untell + warm reads are safe" (cond
  (not (:up p)) (str "DEGRADED: coordinator DOWN on 127.0.0.1:" (:port p) " — run `north up` (writes won't serialize)")
  (not (:serving p)) (str "DEGRADED: daemon not serving the canonical log — status: " (:status p))
  :else (str "DEGRADED: daemon STALE (loaded v" (:daemon-v p) " behind log v" (:log-v p) ") — the log changed out-of-band; restart it + `north up`"))))

(defn- ^String hygiene-line [^Probe p]
  (let [ns (count (:stale p))
   nh (count (:hand p))
   nb (count (:log-behind p))
   nt (count (:tombstoned p))]
  (if (and (= ns 0) (and (= nh 0) (and (= nb 0) (= nt 0)))) "" (str "hygiene: " (+ ns (+ nb nt)) " stale/lagging projection fact(s) — run `north heal`" (if (> nh 0) (str "; " nh " hand-edited fact(s) — reconcile via tell/import") "")))))

(defn cmd-doctor [^String threads-dir ^String log]
  (let [p (probe threads-dir log)]
  (println "north doctor")
  (if (:up p) (do
  (println (str "  [ok]    coordinator UP on 127.0.0.1:" (:port p)))
  (if (:serving p) (println "  [ok]    serving the canonical log") (println (str "  [WARN]  daemon is NOT serving " log " — status: " (:status p))))
  (if (:fresh p) (if (= (:daemon-v p) (:log-v p)) (println "  [ok]    daemon state matches the on-disk log") (println (str "  [ok]    daemon current with the log (loaded v" (:daemon-v p) " > log v" (:log-v p) " — in-memory lease txs, never flat-logged)"))) (println (str "  [WARN]  daemon is STALE (loaded v" (:daemon-v p) " behind log v" (:log-v p) ") — the log changed out-of-band; restart: kill it + `north up`")))) (println (str "  [DOWN]  no coordinator on 127.0.0.1:" (:port p) " — writes won't serialize. Run `north up`.")))
  (if (safe? p) (println "  => healthy: tell/untell + warm reads are safe") (println "  => DEGRADED: fix the warnings above"))
  (println "  hygiene:")
  (let [ns (count (:stale p))
   nh (count (:hand p))
   nb (count (:log-behind p))
   nt (count (:tombstoned p))]
  (if (and (= ns 0) (and (= nh 0) (and (= nb 0) (= nt 0)))) (println "    [ok]    files <-> fact log in sync") (do
  (if (> ns 0) (do
  (println (str "    " ns " stale projection fact(s) — run `north heal`"))))
  (if (> nt 0) (do
  (println (str "    " nt " retracted-but-still-in-file fact(s) (tombstones) — run `north heal`"))))
  (if (> nh 0) (do
  (println (str "    " nh " genuinely-new file fact(s) (hand edits) — reconcile via tell or import"))))
  (if (> nb 0) (do
  (println (str "    " nb " log fact(s) not yet in files — benign projection lag; run `north heal`")))))))))

(defn- distinct-ids [xs]
  (reduce (fn [acc x] (if (k/vec-contains? acc x) acc (conj acc x))) [] xs))

(defn- heal-targets [^Probe p]
  (distinct-ids (mapv (fn [c] (:l c)) (vec (concat (:stale p) (:log-behind p) (:tombstoned p))))))

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

(defn- heal-project [^String threads-dir ^Probe p]
  (let [files (fram.rt/list-md threads-dir)
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
  (fram.rt/spit-file path (exp/thread-md (:log-facts p) te))
  (println (str "  re-rendered " id "  " (trunc title 52)))))
  (println (str "heal: re-rendered " (count targets) " thread file(s) from the log. Log untouched."))))))

(defrecord AdoptResult [adopted skipped failed dropped])

(defn adoptresult-adopted [r] (:adopted r))

(defn adoptresult-skipped [r] (:skipped r))

(defn adoptresult-failed [r] (:failed r))

(defn adoptresult-dropped [r] (:dropped r))

(defn- ^Boolean adoptable? [c]
  (and (not (str/blank? (:p c))) (not (str/blank? (:r c)))))

(defn- ^AdoptResult adopt-hand-facts [port live hand]
  (reduce (fn [acc c] (cond
  (not (adoptable? c)) (do
  (println (str "  drop (parse artifact) " (short-id (:l c)) "  pred=<" (:p c) "> val=<" (trunc (:r c) 40) ">"))
  (->AdoptResult (:adopted acc) (:skipped acc) (:failed acc) (+ (:dropped acc) 1)))
  (and (k/single? (:p c)) (let [v (k/one-i live (:l c) (:p c))]
  (and (some? v) (not (= v (:r c)))))) (do
  (println (str "  skip (log won) " (short-id (:l c)) "  " (:p c) "  " (trunc (:r c) 56)))
  (->AdoptResult (:adopted acc) (+ (:skipped acc) 1) (:failed acc) (:dropped acc)))
  :else (let [r (tell-retry port "assert" (:l c) (:p c) (:r c) 5)]
  (if (str/starts-with? r "ok:") (do
  (println (str "  adopted " (short-id (:l c)) "  " (:p c) "  " (trunc (:r c) 56)))
  (->AdoptResult (+ (:adopted acc) 1) (:skipped acc) (:failed acc) (:dropped acc))) (do
  (println (str "  FAILED  " (short-id (:l c)) "  " (:p c) "  -> " r))
  (->AdoptResult (:adopted acc) (:skipped acc) (+ (:failed acc) 1) (:dropped acc))))))) (->AdoptResult 0 0 0 0) hand))

(defn- report-tombstoned [tombstoned]
  (if (empty? tombstoned) nil (do
  (println (str "retracted (stale projection) — skipped " (count tombstoned) " fact(s) net-dead in the log (re-rendered away, NOT resurrected; --resurrect to force-adopt):"))
  (doseq [c tombstoned]
  (println (str "    " (short-id (:l c)) "  " (:p c) "  " (trunc (:r c) 72)))))))

(defn cmd-heal [^String threads-dir ^String log ^Boolean adopt ^Boolean resurrect]
  (let [p (probe threads-dir log)
   adopt-list (if resurrect (vec (concat (:hand p) (:tombstoned p))) (:hand p))
   has-hand (not (empty? (:hand p)))
   has-adoptable (not (empty? adopt-list))]
  (cond
  (and has-hand (not (or adopt resurrect))) (do
  (println (str "heal REFUSED — " (count (:hand p)) " genuinely-new file fact(s) not in the log " "(hand edits). A human decides: adopt via `heal --adopt` (or `tell`/bulk `import`). " "Nothing was touched:"))
  (doseq [c (:hand p)]
  (println (str "    " (short-id (:l c)) "  " (:p c) "  " (trunc (:r c) 72))))
  (report-tombstoned (:tombstoned p)))
  :else (if (and (or adopt resurrect) has-adoptable) (let [port (fram.rt/coord-port)]
  (if (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — adopt needs the daemon to serialize writes. Run `north up`.") (do
  (if (not resurrect) (report-tombstoned (:tombstoned p)) nil)
  (let [res (adopt-hand-facts port (live-idx log) adopt-list)]
  (println (str "heal --adopt: " (:adopted res) " adopted, " (:skipped res) " skipped (log won), " (:dropped res) " dropped (parse artifact), " (:failed res) " failed via coordinator."))
  (heal-project threads-dir (probe threads-dir log)))))) (do
  (report-tombstoned (:tombstoned p))
  (heal-project threads-dir p))))))

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

(defn- ^Boolean all-ref? [facts ^String pred]
  (loop [cs facts
   seen false]
  (if (empty? cs) seen (let [c (first cs)]
  (if (= (:p c) pred) (if (str/starts-with? (:r c) "@") (recur (rest cs) true) false) (recur (rest cs) seen))))))

(defn- distinct-preds [facts]
  (reduce (fn [acc c] (if (k/vec-contains? acc (:p c)) acc (conj acc (:p c)))) [] facts))

(defn- seed-facts [^String log]
  (let [facts (live-facts log)
   card (mapv (fn [p] (k/->Fact (str "@" p) "cardinality" "single")) (single-valued-preds))
   acyc (mapv (fn [p] (k/->Fact (str "@" p) "acyclic" "true")) ["depends_on" "part_of"])
   refs (filterv (fn [p] (all-ref? facts p)) (distinct-preds facts))
   vk (mapv (fn [p] (k/->Fact (str "@" p) "value_kind" "ref")) refs)]
  (vec (concat card acyc vk))))

(defn cmd-schema-seed [^String log ^Boolean execute]
  (let [seeds (seed-facts log)]
  (if (not execute) (do
  (println (str "schema-seed DRY-RUN — " (count seeds) " fact(s); nothing written."))
  (doseq [c seeds]
  (println (str "  tell " (:l c) " " (:p c) " " (:r c))))
  (println "Run `north schema-seed --execute` (coordinator session) to write.")) (let [idx (live-idx log)
   subs (distinct-ids (mapv (fn [c] (:l c)) seeds))
   collisions (filterv (fn [s] (some? (k/one-i idx s "title"))) subs)]
  (if (not (empty? collisions)) (do
  (println (str "!!! schema-seed ABORTED — " (count collisions) " predicate name(s) collide with a live thread id."))
  (println "    Writing predicate metadata onto these would pollute real threads:")
  (doseq [s collisions]
  (println (str "      " s "  (has a `title` fact — is a thread)")))
  (println "    No facts written. Rename the colliding thread(s) or exclude the pred(s).")) (let [port (fram.rt/coord-port)]
  (if (< (fram.rt/coord-version port) 0) (println "no coordinator on 127.0.0.1:7977 — writes won't serialize. Run `north up`.") (let [results (mapv (fn [c] (tell-retry port "assert" (:l c) (:p c) (:r c) 5)) seeds)
   oks (count (filterv (fn [r] (str/starts-with? r "ok:")) results))]
  (println (str "schema-seed EXECUTED — " oks "/" (count seeds) " fact(s) committed via coordinator."))))))))))

(defn cmd-tools []
  (do
  (println "NORTH — curated tool surface (the MCP verbs; bin/north-mcp is authoritative):")
  (println "  work queue : ready · next · board · blocked · agenda · leverage · needs-review")
  (println "  vocabulary : schema (census by kind) · schema-seed (declare predicate metadata)")
  (println "  read/write : show · capture · tell · retract · validate   (untell = legacy alias of retract)")
  (println "  time       : clock start|stop|status|report")
  (println "  agents     : dispatch · spawn")
  (println "  view       : presentation")
  (println "")
  (println "Engine core underneath: fram = 10 tools (tell/retract/show/ask/validate + 5 graph-edit verbs).")
  (println "Vocabulary is DATA, not tools: `north show <pred>` reveals a predicate's metadata")
  (println "(cardinality/value_kind/acyclic facts). Seed that metadata with `north schema-seed`.")))

(defrecord PredCount [pred n])

(defn predcount-pred [r] (:pred r))

(defn predcount-n [r] (:n r))

(defrecord KindStat [kind subjects facts preds])

(defn kindstat-kind [r] (:kind r))

(defn kindstat-subjects [r] (:subjects r))

(defn kindstat-facts [r] (:facts r))

(defn kindstat-preds [r] (:preds r))

(def ^String KP-SEP "\u0001")

(defn- census [idx facts]
  (let [subj-list (:subjects idx)
   skind (reduce (fn [m s] (assoc m s (kind-of idx s))) {} subj-list)
   ksub (reduce (fn [m s] (let [kd (get skind s "other")]
  (assoc m kd (+ 1 (get m kd 0))))) {} subj-list)
   kfacts (reduce (fn [m c] (let [kd (get skind (:l c) "other")]
  (assoc m kd (+ 1 (get m kd 0))))) {} facts)
   kpreds (reduce (fn [m c] (let [kd (get skind (:l c) "other")
   kk (str kd KP-SEP (:p c))]
  (assoc m kk (+ 1 (get m kk 0))))) {} facts)
   kp-keys (vec (keys kpreds))
   stats (mapv (fn [kd] (let [pfx (str kd KP-SEP)
   off (+ (count kd) 1)
   plist (mapv (fn [kk] (->PredCount (subs kk off) (get kpreds kk 0))) (filterv (fn [kk] (str/starts-with? kk pfx)) kp-keys))
   ptop (vec (take 8 (sort-by (fn [pc] (- 0 (:n pc))) plist)))]
  (->KindStat kd (get ksub kd 0) (get kfacts kd 0) ptop))) (vec (keys ksub)))]
  (vec (sort-by (fn [ks] (- 0 (:facts ks))) stats))))

(def ^String SP24 "                        ")

(defn- ^String padr [^String s n]
  (if (>= (count s) n) s (str s (subs SP24 0 (- n (count s))))))

(defn- ^String pad7 [n]
  (let [s (str n)]
  (if (>= (count s) 7) s (str (subs "0000000" 0 (- 7 (count s))) s))))

(defn- kind-subjects [idx ^String kind]
  (filterv (fn [s] (= (kind-of idx s) kind)) (:subjects idx)))

(defrecord CovAcc [seen pc])

(defn covacc-seen [r] (:seen r))

(defn covacc-pc [r] (:pc r))

(defn- coverage [facts subjset]
  (:pc (reduce (fn [a c] (if (get subjset (:l c) false) (let [sk (str (:l c) KP-SEP (:p c))]
  (if (get (:seen a) sk false) a (->CovAcc (assoc (:seen a) sk true) (assoc (:pc a) (:p c) (+ 1 (get (:pc a) (:p c) 0)))))) a)) (->CovAcc {} {}) facts)))

(defrecord FieldStat [pred subs pct required])

(defn fieldstat-pred [r] (:pred r))

(defn fieldstat-subs [r] (:subs r))

(defn fieldstat-pct [r] (:pct r))

(defn fieldstat-required [r] (:required r))

(defn- schema-fields [idx facts ^String kind]
  (let [ksubs (kind-subjects idx kind)
   total (count ksubs)
   subjset (reduce (fn [m s] (assoc m s true)) {} ksubs)
   pc (coverage facts subjset)
   stats (mapv (fn [p] (let [n (get pc p 0)
   pct (if (> total 0) (quot (* 100 n) total) 0)
   req (if (> total 0) (>= (* n 100) (* total 98)) false)]
  (->FieldStat p n pct req))) (vec (keys pc)))]
  (vec (sort-by (fn [fs] (str (if (:required fs) "0" "1") "|" (pad7 (- 9999999 (:subs fs))) "|" (:pred fs))) stats))))

(defn- ^String pred-ann [idx ^String p]
  (let [ps (if (or (some? (k/one-i idx (str "@" p) "cardinality")) (some? (k/one-i idx (str "@" p) "value_kind"))) (str "@" p) p)
   card (k/one-i idx ps "cardinality")
   vk (k/one-i idx ps "value_kind")]
  (str (if (some? card) (str "  cardinality=" card) "") (if (some? vk) (str " value_kind=" vk) ""))))

(defn- ^String kind-writer [^String kind]
  (cond
  (= kind "thread") "north capture -> src/north/main.bclj capture-facts (title, kind=thread, created_at, committed, …)"
  (= kind "concern") "concern declare -> cli/concern-cli.clj (put! kind=concern, intent, touches, reached)"
  (= kind "agent") "agent identity -> sdk/src/identity.ts writeIdentity + bin/north-on-spawn (tell agent:<id> kind/role/display_name)"
  (= kind "session-telemetry") "run/session telemetry -> sdk/src/telemetry.ts recordRun (kind=run) + bin/north-on-spawn (kind=session) + cli/presence-cli.clj (session leases)"
  (= kind "msg") "mail + commands -> cli/msg-cli.clj (@msg: mail, @cmd: commands)"
  (= kind "mine") "personal notes -> cli/north-mine.clj (@mine:<stem> facts)"
  (= kind "predicate") "schema-as-facts -> north schema-seed (src/north/main.bclj cmd-schema-seed) / fram tell (cardinality/value_kind/acyclic)"
  (= kind "topic") "topic grouping anchors (topic- prefix)"
  :else "(writer not curated — grep the coordination log for this kind's writer)"))

(defn- print-schema-kind [idx facts ^String kind]
  (let [ksubs (kind-subjects idx kind)
   total (count ksubs)]
  (if (= total 0) (println (str "SCHEMA · " kind " — no subjects of this kind. `north schema` lists the kinds in use.")) (let [fields (schema-fields idx facts kind)
   req (filterv (fn [fs] (:required fs)) fields)
   opt (filterv (fn [fs] (not (:required fs))) fields)]
  (println (str "SCHEMA · " kind " — " total " subjects · " (count fields) " distinct predicates"))
  (println (str "  REQUIRED — carried by ≥98% of " kind " subjects (≈ every one):"))
  (doseq [fs req]
  (println (str "    " (padr (:pred fs) 20) " " (:pct fs) "%" (pred-ann idx (:pred fs)))))
  (if (empty? req) (do
  (println "    (none)")))
  (println "  OPTIONAL — coverage % of subjects that carry it:")
  (doseq [fs opt]
  (println (str "    " (padr (:pred fs) 20) " " (:pct fs) "%" (pred-ann idx (:pred fs)))))
  (if (empty? opt) (do
  (println "    (none)")))
  (println (str "  written by: " (kind-writer kind)))))))

(defn cmd-schema [^String log ^String kind]
  (let [facts (live-facts log)
   idx (k/build-index facts)]
  (if (not (str/blank? kind)) (print-schema-kind idx facts kind) (let [stats (census idx facts)
   pred-subs (filterv (fn [s] (or (some? (k/one-i idx s "cardinality")) (or (some? (k/one-i idx s "value_kind")) (some? (k/one-i idx s "acyclic"))))) (:subjects idx))]
  (println (str "SCHEMA — " (count (:subjects idx)) " subjects / " (count facts) " live facts across " (count stats) " kinds"))
  (doseq [ks stats]
  (println (str "  " (padr (:kind ks) 20) " " (:subjects ks) " subjects · " (:facts ks) " facts")))
  (println (str "  " (padr "predicate-meta" 20) " " (count pred-subs) " predicate(s) carry declared cardinality/value_kind/acyclic"))
  (let [tlog (fram.rt/getenv-or "FRAM_TELEMETRY_LOG" "")]
  (if (not (str/blank? tlog)) (do
  (let [coord-n (count (fram.rt/read-log log))
   telem-n (count (fram.rt/read-log tlog))]
  (println (str "  ── logs (on-disk fact-ops; unified in-store above) ──"))
  (println (str "  " (padr "coordination" 20) " " coord-n " fact-ops  " log))
  (println (str "  " (padr "telemetry" 20) " " telem-n " fact-ops  " tlog))
  (println (str "  " (padr "total on-disk" 20) " " (+ coord-n telem-n) " fact-ops boot-merged by :tx"))))))
  (println "→ north schema <kind> for the field spec — required vs optional preds, coverage %, who writes it")))))

(defn- ^Boolean has-flag? [args ^String f]
  (not (empty? (filterv (fn [a] (= a f)) args))))

(defn run [args ^String threads-dir ^String log]
  (let [cmd (if (empty? args) "" (first args))]
  (cond
  (= cmd "capture") (if (>= (count args) 2) (cmd-capture threads-dir log (nth args 1) (if (>= (count args) 3) (nth args 2) "personal")) (println "usage: capture <title> [owner]"))
  (= cmd "ready") (cmd-ready log (has-flag? args "--all"))
  (= cmd "blocked") (cmd-blocked log)
  (= cmd "leverage") (cmd-leverage log)
  (= cmd "next") (cmd-next log)
  (= cmd "agenda") (cmd-agenda log)
  (= cmd "board") (cmd-board log (has-flag? args "--all"))
  (= cmd "plate") (cmd-board log (has-flag? args "--all"))
  (= cmd "schema") (cmd-schema log (if (>= (count args) 2) (nth args 1) ""))
  (= cmd "needs-review") (cmd-needs-review log)
  (= cmd "audit") (cmd-audit log)
  (= cmd "resolve") (if (>= (count args) 2) (cmd-resolve log (nth args 1)) (println "usage: resolve <@handle|@id>"))
  (= cmd "done-bars") (if (>= (count args) 2) (cmd-done-bars log (nth args 1)) (println "usage: done-bars <@id|@handle>"))
  (= cmd "validate") (cmd-validate log)
  (= cmd "schema-seed") (cmd-schema-seed log (has-flag? args "--execute"))
  (= cmd "tools") (cmd-tools)
  (= cmd "doctor") (cmd-doctor threads-dir log)
  (= cmd "heal") (cmd-heal threads-dir log (has-flag? args "--adopt") (has-flag? args "--resurrect"))
  (= cmd "boot") (cmd-boot threads-dir log)
  (= cmd "json") (cmd-json log (if (> (count args) 1) (nth args 1) "") (if (> (count args) 2) (nth args 2) "") (has-flag? args "--all"))
  (= cmd "clock") (let [sub (if (> (count args) 1) (nth args 1) "status")]
  (cond
  (= sub "start") (if (>= (count args) 3) (cmd-clock-start log (nth args 2)) (println "usage: clock start <thread-id>"))
  (= sub "stop") (cmd-clock-stop log)
  (= sub "orphan") (if (>= (count args) 3) (cmd-clock-orphan log (nth args 2)) (println "usage: clock orphan <agent-id>"))
  (= sub "status") (cmd-clock-status log)
  (= sub "report") (cmd-clock-report log)
  (= sub "today") (cmd-clock-today log)
  (= sub "week") (cmd-clock-week log)
  (= sub "sync") (cmd-clock-sync log)
  (= sub "map") (if (>= (count args) 4) (cf/cmd-map (fram.rt/time-dir) (nth args 2) (nth args 3)) (println "usage: clock map <owner> <project-id>"))
  (= sub "projects") (cf/cmd-projects)
  (= sub "workspaces") (cf/cmd-workspaces)
  :else (println "usage: clock start <id> | stop | orphan <agent-id> | status | report | today | week | sync | map <owner> <project-id> | projects | workspaces")))
  :else (println "north usage: capture <title> [owner] | ready [--all] | blocked | leverage | next | agenda | board [--all] | schema | needs-review | audit | resolve <@handle|@id> | validate | schema-seed [--dry-run|--execute] | tools | doctor | heal | boot | listen <agent-id> | json <...> | clock <start|stop|orphan|status|report|today|week|sync|map|projects|workspaces>   (board/ready default to a curated top slice; --all for the full dump. engine verbs import/export/show/set/tell/retract/merge route to fram; untell = legacy alias of retract)"))))

(defn -main [& args]
  (run (vec args) (fram.rt/threads-dir) (fram.rt/log-path)))
