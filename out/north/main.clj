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

(defn- ^String legacy-entity-kind [^String ek]
  (cond
  (or (= ek "lane") (or (= ek "managed") (= ek "session"))) "agent"
  (or (= ek "msg") (= ek "command")) "message"
  (= ek "mine") "north/mine"
  (= ek "snapshot") "north/snapshot"
  :else ek))

(defn- ^String namespace-kind [^String bare]
  (cond
  (str/starts-with? bare "concern-") "concern"
  (str/starts-with? bare "agent:") "agent"
  (or (str/starts-with? bare "msg:") (str/starts-with? bare "cmd:")) "message"
  (str/starts-with? bare "topic-") "topic"
  (str/starts-with? bare "mine:") "north/mine"
  (or (str/starts-with? bare "run-") (str/starts-with? bare "run:")) "run"
  (or (str/starts-with? bare "session:") (or (str/starts-with? bare "sess-") (str/starts-with? bare "cc-"))) "agent"
  (str/starts-with? bare "denial:") "guard_denial"
  (str/starts-with? bare "snapshot:") "north/snapshot"
  (str/starts-with? bare "arena-") "north/arena_run"
  :else ""))

(defn- ^String kind-of [idx te]
  (if (nil? te) "other" (let [explicit (k/one-i idx te "entity_kind")]
  (if (some? explicit) explicit (let [legacy (k/one-i idx te "kind")]
  (if (some? legacy) (legacy-entity-kind legacy) (let [np (namespace-kind (short-id te))]
  (if (not (str/blank? np)) np (if (some? (k/one-i idx te "title")) "thread" (if (some? (k/one-i idx te "display_name")) "person" (if (or (some? (k/one-i idx te "cardinality")) (or (some? (k/one-i idx te "value_kind")) (some? (k/one-i idx te "acyclic")))) "predicate" "other")))))))))))

(defn- ^String driver-label [idx ^String te]
  (let [d (k/one-i idx te "driver")]
  (if (nil? d) "" (let [dn (k/one-i idx d "display_name")]
  (if (some? dn) dn (short-id d))))))

(defrecord LevItem [te score])

(defn levitem-te [r] (:te r))

(defn levitem-score [r] (:score r))

(defrecord NextItem [te score leverage urgency momentum priority sequencing basis])

(defn nextitem-te [r] (:te r))

(defn nextitem-score [r] (:score r))

(defn nextitem-leverage [r] (:leverage r))

(defn nextitem-urgency [r] (:urgency r))

(defn nextitem-momentum [r] (:momentum r))

(defn nextitem-priority [r] (:priority r))

(defn nextitem-sequencing [r] (:sequencing r))

(defn nextitem-basis [r] (:basis r))

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

(defn ^String coordinator-failure-message [code port ^String log ^String consequence]
  (let [summary (cond
  (= code -1) (str "coordinator UNREACHABLE on 127.0.0.1:" port)
  (= code -2) (str "coordinator CORPUS MISMATCH on 127.0.0.1:" port " (this command requires " log ")")
  (= code -3) (str "coordinator PROTOCOL INCOMPATIBLE on 127.0.0.1:" port)
  :else (str "coordinator preflight failed on 127.0.0.1:" port " (code " code ")"))
   remedy (cond
  (= code -1) "Run `north up`"
  (= code -2) "Stop the coordinator serving the other corpus, then run `north up`"
  (= code -3) "Rebuild and restart North + Fram from one matched release"
  :else "Inspect `north doctor` before retrying")]
  (str summary (if (str/blank? consequence) "" (str " — " consequence)) ". " remedy ".")))

(defn- ^String tell-once [port ^String log ^String op ^String te ^String pred ^String rv]
  (let [v (fram.rt/coord-version-for-log port log)]
  (if (< v 0) (if (= v -2) "log-mismatch" (if (= v -3) "protocol-incompatible" "nodaemon")) (if (= op "assert") (fram.rt/coord-assert-for-log port log te pred rv v) (fram.rt/coord-retract-for-log port log te pred rv v)))))

(defn- ^String tell-retry [port ^String log ^String op ^String te ^String pred ^String rv tries]
  (let [resp (tell-once port log op te pred rv)]
  (if (and (= resp "conflict") (> tries 0)) (tell-retry port log op te pred rv (- tries 1)) resp)))

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

(defrecord CaptureReceipt [id thread title path expected committed complete reason])

(defn capturereceipt-id [r] (:id r))

(defn capturereceipt-thread [r] (:thread r))

(defn capturereceipt-title [r] (:title r))

(defn capturereceipt-path [r] (:path r))

(defn capturereceipt-expected [r] (:expected r))

(defn capturereceipt-committed [r] (:committed r))

(defn capturereceipt-complete [r] (:complete r))

(defn capturereceipt-reason [r] (:reason r))

(defn- ^Boolean structured-capture? []
  (= "1" (fram.rt/getenv-or "NORTH_CAPTURE_STRUCTURED" "")))

(defn- print-capture-receipt [^String id ^String te ^String title ^String path expected committed ^Boolean complete ^String reason]
  (println (fram.rt/to-json (->CaptureReceipt id te title path expected committed complete reason))))

(defn- ^Boolean retract-committed-capture-facts [port ^String log facts results i]
  (if (>= i (count facts)) true (let [fact (nth facts i)
   result (nth results i)
   current-ok (if (str/starts-with? result "ok:") (str/starts-with? (tell-retry port log "retract" (:l fact) (:p fact) (:r fact) 5) "ok:") true)
   remaining-ok (retract-committed-capture-facts port log facts results (+ i 1))]
  (and current-ok remaining-ok))))

(defn- ^Boolean cleanup-partial-capture [port ^String log ^String te ^String path facts results]
  (let [retracted (retract-committed-capture-facts port log facts results 0)
   _ (fram.rt/delete-file path)
   remaining (filterv (fn [fact] (= te (:l fact))) (fram.rt/coord-live-facts port log))]
  (and retracted (empty? remaining) (not (fram.rt/file-exists path)))))

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
   port (fram.rt/coord-port)
   coord-v (fram.rt/coord-version-for-log port log)]
  (if (< coord-v 0) (if (structured-capture?) (print-capture-receipt id te title path 0 0 false "coordinator-unavailable") (println (coordinator-failure-message coord-v port log "capture was not recorded"))) (let [facts (capture-facts te title owner source author lead proposed created-at today)
   results (mapv (fn [c] (tell-retry port log "assert" (:l c) (:p c) (:r c) 5)) facts)
   oks (count (filterv (fn [r] (str/starts-with? r "ok:")) results))]
  (if (= oks (count facts)) (do
  (fram.rt/spit-file path (exp/thread-md (:facts (fold/fold (fram.rt/read-log log))) te))
  (if (structured-capture?) (print-capture-receipt id te title path (count facts) oks true "captured") (println (str "captured -> " te "  " title "  [owner: " owner "]\n" "  file:      " path "\n" "  committed: " oks " facts via coordinator. Next: north tell " id " <pred> <value>")))) (if (structured-capture?) (let [cleaned (cleanup-partial-capture port log te path facts results)]
  (print-capture-receipt id te title path (count facts) oks false (if cleaned "partial-cleaned" "partial-cleanup-failed"))) (println (str "capture PARTIAL: only " oks "/" (count facts) " fact(s) committed (write conflict / no daemon?). Re-run — nothing is stranded in files.")))))))))))

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
   ids (k/thread-ids-i idx)
   problems (reduce (fn [acc te] (reduce (fn [a v] (conj a (str (short-id te) ": " v))) acc (val/violations-i idx te))) [] ids)]
  (if (empty? problems) (do
  (println (str "OK — " (count ids) " threads, no violations."))
  0) (do
  (doseq [p problems]
  (println (str "  " p)))
  (println (str (count problems) " violation(s)."))
  1))))

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

(defn- live-driver-pred [now-secs window-secs]
  (fn [idx te] (driver-live? idx te now-secs window-secs)))

(defn- default-live? []
  (live-driver-pred (fram.rt/iso-to-seconds (fram.rt/now-iso)) (driver-stale-window-secs)))

(defn- ^Boolean parked-assignment? [idx ^String te live?]
  (and (proj/assigned? idx te) (not (live? idx te))))

(defn- parked-assignments [idx tes live?]
  (filterv (fn [te] (parked-assignment? idx te live?)) tes))

(defn cmd-ready [^String log ^Boolean all]
  (let [idx (live-idx log)
   today (fram.rt/today-iso)
   live? (default-live?)
   raw (proj/ready idx today fram.rt/str-lt? live?)
   rs (if all raw (filterv (fn [te] (= (kind-of idx te) "thread")) raw))
   ranked (vec (sort-by (fn [te] (- 0 (proj/leverage-score idx te))) rs))
   shown (if all ranked (vec (take 15 ranked)))]
  (if all (println (str "READY NOW — " (count rs))) (println (str "READY NOW — top " (count shown) " of " (count rs) " by leverage")))
  (println "  ready = committed + unblocked + no live driver + not future-scheduled (vs open = merely nonterminal)")
  (doseq [te shown]
  (println (str "  " (short-id te) "  " (trunc (title-of idx te) 56))))
  (if (and (not all) (> (count rs) (count shown))) (do
  (println (str "  … +" (- (count rs) (count shown)) " more · north ready --all"))))))

(defn cmd-blocked [^String log]
  (let [idx (live-idx log)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?
   live? (default-live?)
   bs (filterv (fn [te] (= (proj/condition-i idx te today before? live?) "blocked")) (proj/work-thread-ids-i idx))]
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

(defn- ^NextItem next-item [idx ^String te ^String today before? live?]
  (let [lev (proj/leverage-score idx te)
   doo (k/one-i idx te "do_on")
   urg (if (some? doo) (cond
  (fram.rt/str-lt? doo today) 5
  (= doo today) 3
  :else 0) 0)
   mom (if (some? (k/one-i idx te "driver")) 2 0)
   pri (let [p (k/one-i idx te "priority")]
  (if (some? p) p ""))
   sequencing (count (proj/incomplete-deps idx te))
   eligibility (proj/explain idx te today before? live?)]
  (->NextItem te (+ (* 3 lev) (+ urg mom)) lev urg mom pri sequencing (:reason eligibility))))

(defn cmd-next [^String log]
  (let [idx (live-idx log)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?
   live? (default-live?)
   items (mapv (fn [te] (next-item idx te today before? live?)) (proj/ready idx today before? live?))
   ranked (vec (take 12 (sort-by (fn [it] (- 0 (:score it))) items)))]
  (println (str "WHAT TO WORK ON — top picks (" today ")"))
  (println "  eligible = ready (committed + unblocked + no live driver + not scheduled-later)")
  (println "  dependency sequencing gates eligibility · score = 3·graph-leverage + do_on urgency + parked-assignment momentum")
  (println "  stored priority is orthogonal human intent (shown, never silently scored)")
  (doseq [it ranked]
  (println (str "  [" (:score it) "] " (short-id (:te it)) "  " (trunc (title-of idx (:te it)) 46)))
  (println (str "      eligible: " (:basis it)))
  (println (str "      score: 3×" (:leverage it) " leverage + " (:urgency it) " urgency + " (:momentum it) " momentum = " (:score it) " · sequencing: " (:sequencing it) " incomplete deps" " · priority: " (if (str/blank? (:priority it)) "none" (:priority it)) " (not scored)")))))

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

(defn- in-condition [idx nonterm ^String today before? live? ^String c]
  (filterv (fn [te] (= (proj/condition-i idx te today before? live?) c)) nonterm))

(defn- parked-group [idx ^String today before? live? grp]
  (if (not (empty? grp)) (do
  (println (str "\nPARKED ASSIGNMENTS (" (count grp) ") — stale driver retained; lifecycle is not active"))
  (doseq [te grp]
  (println (str "  " (driver-label idx te) "  " (short-id te) "  " (proj/condition-i idx te today before? live?) "  " (trunc (title-of idx te) 42)))))))

(defn- board-full [idx ^String today before? live? nonterm]
  (do
  (println (str "THREADS — " (count nonterm) " open"))
  (board-group idx "active" (in-condition idx nonterm today before? live? "active"))
  (board-group idx "ready" (in-condition idx nonterm today before? live? "ready"))
  (board-group idx "blocked" (in-condition idx nonterm today before? live? "blocked"))
  (board-group idx "dormant" (in-condition idx nonterm today before? live? "dormant"))
  (board-group idx "draft" (in-condition idx nonterm today before? live? "draft"))
  (parked-group idx today before? live? (parked-assignments idx nonterm live?))))

(defn- board-curated [idx ^String today before? live? nonterm]
  (let [threads (filterv (fn [te] (= (kind-of idx te) "thread")) nonterm)
   active (in-condition idx threads today before? live? "active")
   parked (parked-assignments idx threads live?)
   nparked (count parked)
   readyl (in-condition idx threads today before? live? "ready")
   blockedl (in-condition idx threads today before? live? "blocked")
   nconcern (count (filterv (fn [s] (= (kind-of idx s) "concern")) (:subjects idx)))
   ashow (vec (take 20 active))
   ritems (mapv (fn [te] (->LevItem te (proj/leverage-score idx te))) readyl)
   rranked (vec (take 15 (sort-by (fn [it] (- 0 (:score it))) ritems)))]
  (println (str "THREADS — " (count threads) " open threads · " (count active) " active · " (count readyl) " ready · " (count blockedl) " blocked · " nconcern " concerns   (north threads --all for the full kanban)"))
  (println "  open = not terminal · active = live driver · ready = committed + unblocked + no live driver + not future-scheduled")
  (if (not (empty? active)) (do
  (println (str "\n" (proj/condition-emoji idx "active") " ACTIVE — who's on what (" (count active) ")"))
  (doseq [te ashow]
  (println (str "  " (let [dl (driver-label idx te)]
  (if (str/blank? dl) "?" dl)) "  " (short-id te) "  " (trunc (title-of idx te) 44))))
  (if (> (count active) (count ashow)) (do
  (println (str "  … +" (- (count active) (count ashow)) " more · north threads --all"))))))
  (if (> nparked 0) (do
  (let [pshow (vec (take 10 parked))]
  (println (str "\nPARKED ASSIGNMENTS — stale driver retained, lifecycle demoted (" nparked ")"))
  (doseq [te pshow]
  (println (str "  " (driver-label idx te) "  " (short-id te) "  " (proj/condition-i idx te today before? live?) "  " (trunc (title-of idx te) 36))))
  (if (> nparked (count pshow)) (do
  (println (str "  … +" (- nparked (count pshow)) " more · north needs-review")))))))
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
   live? (default-live?)
   nonterm (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx))]
  (if all (board-full idx today before? live? nonterm) (board-curated idx today before? live? nonterm))))

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

(defrecord JChildSettlementProjection [protocol version coordinator children runs])

(defn jchildsettlementprojection-protocol [r] (:protocol r))

(defn jchildsettlementprojection-version [r] (:version r))

(defn jchildsettlementprojection-coordinator [r] (:coordinator r))

(defn jchildsettlementprojection-children [r] (:children r))

(defn jchildsettlementprojection-runs [r] (:runs r))

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

(defn- ^JThread jthread [idx ^String te ^String today before? live?]
  (let [c (proj/condition-i idx te today before? live?)]
  (->JThread (short-id te) (title-of idx te) c (proj/condition-emoji idx c))))

(defn- ready-curated-tes [idx ^String today before? live? ^Boolean all?]
  (let [raw (proj/ready idx today before? live?)
   rs (if all? raw (filterv (fn [te] (= (kind-of idx te) "thread")) raw))
   ranked (vec (sort-by (fn [te] (- 0 (proj/leverage-score idx te))) rs))]
  (if all? ranked (vec (take 15 ranked)))))

(defn- board-curated-tes [idx ^String today before? live? ^Boolean all?]
  (let [nonterm (filterv (fn [te] (not (proj/terminal-i? idx te))) (proj/work-thread-ids-i idx))]
  (if all? nonterm (let [threads (filterv (fn [te] (= (kind-of idx te) "thread")) nonterm)
   active (in-condition idx threads today before? live? "active")
   ready (vec (take 15 (sort-by (fn [te] (- 0 (proj/leverage-score idx te))) (in-condition idx threads today before? live? "ready"))))]
  (vec (concat active ready))))))

(defn- matching-subjects [facts ^String predicate ^String value]
  (reduce (fn [subjects fact] (if (and (= (:p fact) predicate) (= (:r fact) value)) (assoc subjects (:l fact) true) subjects)) {} facts))

(defn- direct-child-subjects [facts ^String coordinator]
  (reduce (fn [subjects fact] (if (and (= (:p fact) "coordinator") (= (:r fact) coordinator) (str/starts-with? (:l fact) "@agent:")) (assoc subjects (:l fact) true) subjects)) {} facts))

(defn- child-agent-ids [subjects]
  (reduce-kv (fn [ids subject _present] (assoc ids (subs subject (count "@agent:")) true)) {} subjects))

(defn- child-run-subjects [facts children committed-runs]
  (reduce (fn [subjects fact] (if (and (= (:p fact) "agent") (get children (:r fact) false) (get committed-runs (:l fact) false)) (assoc subjects (:l fact) true) subjects)) {} facts))

(defn- subject-fact-projection [facts subjects]
  (mapv (fn [fact] (->JSubjectFact (short-id (:l fact)) (:p fact) (:r fact))) (filterv (fn [fact] (get subjects (:l fact) false)) facts)))

(defn- parked-assignment-reviews [idx ^String today before? live?]
  (reduce (fn [acc te] (if (and (= (kind-of idx te) "thread") (and (not (proj/terminal-i? idx te)) (parked-assignment? idx te live?))) (let [d (k/one-i idx te "driver")
   eligibility (proj/explain idx te today before? live?)]
  (conj acc (stale/->Review te "driver" (str "parked assignment " (if (some? d) d "?") " has no live lease or recent activity; lifecycle=" (:state eligibility) " — reassign or retract driver")))) acc)) [] (proj/work-thread-ids-i idx)))

(defn- canonical-grooming-reviews [cold-idx latest live-idx ^String today before? live?]
  (let [base (stale/needs-review cold-idx latest today before?)
   live-base (filterv (fn [rv] (if (= (:pred rv) "done_when") (live? live-idx (:te rv)) true)) base)]
  (vec (concat live-base (parked-assignment-reviews live-idx today before? live?)))))

(defn cmd-json [^String log ^String what ^String arg ^Boolean all?]
  (let [facts (live-facts log)
   idx (k/build-index facts)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?
   live? (default-live?)]
  (cond
  (or (= what "board") (= what "plate")) (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before? live?)) (board-curated-tes idx today before? live? all?))))
  (= what "ready") (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before? live?)) (ready-curated-tes idx today before? live? all?))))
  (= what "blocked") (println (fram.rt/to-json (mapv (fn [te] (jthread idx te today before? live?)) (filterv (fn [te] (= (proj/condition-i idx te today before? live?) "blocked")) (proj/work-thread-ids-i idx)))))
  (= what "needs-review") (let [as (fram.rt/read-log log)
   cidx (k/build-index (:facts (fold/fold as)))
   latest (fold/fold-latest as)
   today (fram.rt/today-iso)
   reviews (canonical-grooming-reviews cidx latest idx today before? live?)]
  (println (fram.rt/to-json (mapv (fn [rv] (->JReview (short-id (:te rv)) (title-of idx (:te rv)) (:pred rv) (:detail rv))) reviews))))
  (= what "clock-report") (let [rs (clk/rows idx (fn [s] (fram.rt/iso-to-seconds s)) (fn [s] (fram.rt/parse-int s)))
   cal (clk/calibration rs)]
  (println (fram.rt/to-json (->JClockReport (mapv (fn [r] (->JClockRow (short-id (:te r)) (title-of idx (:te r)) (:est-h r) (:act-sec r) (:term r))) rs) (->JCalib (:pct cal) (:sample cal))))))
  (= what "show") (println (fram.rt/to-json (mapv (fn [c] (->JFact (:p c) (:r c))) (k/q-by-l facts (str "@" arg)))))
  (= what "show-many") (let [subjects (filterv (fn [s] (not (str/blank? s))) (mapv (fn [s] (short-id s)) (vec (str/split arg #","))))
   subject-set (reduce (fn [m s] (assoc m (str "@" s) true)) {} subjects)]
  (println (fram.rt/to-json (mapv (fn [c] (->JSubjectFact (short-id (:l c)) (:p c) (:r c))) (filterv (fn [c] (get subject-set (:l c) false)) facts)))))
  (= what "child-settlement") (let [children (direct-child-subjects facts arg)
   child-ids (child-agent-ids children)
   committed-runs (matching-subjects facts "kind" "run")
   runs (child-run-subjects facts child-ids committed-runs)]
  (println (fram.rt/to-json (->JChildSettlementProjection "north.child-settlement" 1 arg (subject-fact-projection facts children) (subject-fact-projection facts runs)))))
  (= what "agents") (println (fram.rt/to-json (mapv (fn [c] (->JAgentFact (subs (:l c) (count "@agent:")) (:p c) (:r c))) (filterv (fn [c] (let [l (:l c)]
  (and (some? l) (str/starts-with? l "@agent:")))) facts))))
  (= what "presentation") (println (fram.rt/to-json (->JPresentation (proj/condition-emoji idx "active") (proj/condition-emoji idx "ready") (proj/condition-emoji idx "blocked") (proj/condition-emoji idx "draft"))))
  :else (println "usage: json board|ready|blocked|needs-review|clock-report|show <id>|show-many <id,id,...>|child-settlement <coordinator>|agents|presentation"))))

(defn cmd-needs-review [^String log]
  (let [as (fram.rt/read-log log)
   idx (k/build-index (:facts (fold/fold as)))
   live-idx-now (live-idx log)
   latest (fold/fold-latest as)
   today (fram.rt/today-iso)
   before? fram.rt/str-lt?
   live? (default-live?)
   reviews (canonical-grooming-reviews idx latest live-idx-now today before? live?)
   promo (stale/promotable idx)]
  (println (str "NEEDS REVIEW — " (count reviews) " judgment(s) whose inputs moved (" today ")"))
  (doseq [rv reviews]
  (println (str "  [" (:pred rv) "] " (short-id (:te rv)) "  " (trunc (title-of live-idx-now (:te rv)) 44)))
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

(defn- ^String client-rate-problem [^String owner authority]
  (let [status (:status authority)]
  (cond
  (= status "missing") (str "owner '" owner "' has no client billing rate configuration. Configure it once: north clock rate " owner " <positive-hourly-rate>")
  (= status "duplicate") (str "owner '" owner "' has " (:configs authority) " client billing rate configurations; exactly one is required")
  (= status "noncanonical") (str "owner '" owner "' has a noncanonical client billing rate configuration at " (short-id (:subject authority)) " (expected " (short-id (clk/client-rate-subject owner)) ")")
  (= status "missing-rate") (str "owner '" owner "' has a client billing rate configuration with no rate")
  (= status "ambiguous-rate") (str "owner '" owner "' has ambiguous client billing rates [" (:rate authority) "]")
  (= status "invalid-rate") (str "owner '" owner "' has invalid client billing rate '" (:rate authority) "'; rate must be a positive number")
  :else "client billing rate configuration is invalid")))

(defn cmd-clock-rate [^String log ^String owner ^String new-rate]
  (let [idx (live-idx log)
   me (agent-id)
   authority (clk/client-rate-authority idx owner)
   subject (clk/client-rate-subject owner)
   subject-kind (k/one-i idx subject "kind")
   subject-owner (k/one-i idx subject "owner")]
  (cond
  (not= me "user") (println (str "clock rate refused for managed agent " me " — client billing configuration is owned by user"))
  (str/blank? owner) (println "usage: clock rate <owner> [positive-hourly-rate]")
  (str/blank? new-rate) (if (= (:status authority) "ok") (println (str "client " owner " billing rate: " (:rate authority) "/h  (" (short-id (:subject authority)) ")")) (println (str "clock rate unavailable: " (client-rate-problem owner authority))))
  (not (clk/positive-rate? new-rate)) (println (str "clock rate refused: '" new-rate "' is not a positive numeric hourly rate"))
  (> (:configs authority) 1) (println (str "clock rate refused: " (client-rate-problem owner authority)))
  (= (:status authority) "noncanonical") (println (str "clock rate refused: " (client-rate-problem owner authority)))
  (= (:status authority) "ambiguous-rate") (println (str "clock rate refused: " (client-rate-problem owner authority)))
  (and (some? subject-kind) (not (= subject-kind "client_rate_config"))) (println (str "clock rate refused: canonical subject " (short-id subject) " is already kind=" subject-kind))
  (and (some? subject-owner) (not (= subject-owner owner))) (println (str "clock rate refused: canonical subject " (short-id subject) " is already owned by " subject-owner))
  :else (let [port (fram.rt/coord-port)
   coord-v (fram.rt/coord-version-for-log port log)]
  (if (< coord-v 0) (println (coordinator-failure-message coord-v port log "client billing rate was not recorded")) (let [r1 (tell-retry port log "assert" subject "owner" owner 5)
   r2 (if (str/starts-with? r1 "ok:") (tell-retry port log "assert" subject "rate" new-rate 5) "skipped: owner failed")
   r3 (if (str/starts-with? r2 "ok:") (tell-retry port log "assert" subject "kind" "client_rate_config" 5) "skipped: rate failed")]
  (if (and (str/starts-with? r1 "ok:") (and (str/starts-with? r2 "ok:") (str/starts-with? r3 "ok:"))) (println (str "client " owner " billing rate configured at " new-rate "/h  (" (short-id subject) ")")) (println (str "clock rate FAILED to record (" r1 "/" r2 "/" r3 ") — retry")))))))))

(defn cmd-clock-in [^String log ^String owner]
  (let [idx (live-idx log)
   me (agent-id)
   open (clk/open-human-sessions idx)
   authority (clk/client-rate-authority idx owner)
   rate (:rate authority)]
  (cond
  (not= me "user") (println (str "clock in refused for managed agent " me " — task timing is recorded as run telemetry"))
  (str/blank? owner) (println "usage: clock in <owner>")
  (not (empty? open)) (let [run (first open)
   current (clk/session-owner idx run)]
  (println (str "already clocked in for client " (if (some? current) current "?") " (session " (short-id run) ") — `clock out` first")))
  (not= (:status authority) "ok") (println (str "clock in refused: " (client-rate-problem owner authority)))
  :else (let [port (fram.rt/coord-port)
   coord-v (fram.rt/coord-version-for-log port log)]
  (if (< coord-v 0) (println (coordinator-failure-message coord-v port log "client clock in was not recorded")) (let [sid (fresh-sid idx (fram.rt/now-id))
   ssub (str "@" sid)
   now (fram.rt/now-iso)
   r1 (tell-retry port log "assert" ssub "owner" owner 5)
   r2 (if (str/starts-with? r1 "ok:") (tell-retry port log "assert" ssub "clocked_by" "user" 5) "skipped: owner failed")
   r3 (if (str/starts-with? r2 "ok:") (tell-retry port log "assert" ssub "rate" rate 5) "skipped: clocked_by failed")
   r4 (if (str/starts-with? r3 "ok:") (tell-retry port log "assert" ssub "start_time" now 5) "skipped: rate failed")
   r5 (if (str/starts-with? r4 "ok:") (tell-retry port log "assert" ssub "kind" "client_session" 5) "skipped: start_time failed")]
  (if (and (str/starts-with? r1 "ok:") (and (str/starts-with? r2 "ok:") (and (str/starts-with? r3 "ok:") (and (str/starts-with? r4 "ok:") (str/starts-with? r5 "ok:"))))) (println (str "clocked in for client " owner " at " now "  (session " sid ", rate " rate "/h)")) (println (str "clock in FAILED to record (" r1 "/" r2 "/" r3 "/" r4 "/" r5 ") — retry")))))))))

(defn cmd-clock-out [^String log]
  (let [idx (live-idx log)
   me (agent-id)
   sessions (clk/open-human-sessions idx)]
  (cond
  (not= me "user") (println (str "clock out refused for managed agent " me " — human client time is owned by user"))
  (empty? sessions) (println "not clocked in for a client")
  (> (count sessions) 1) (println (str "invalid client clock state: " (count sessions) " human sessions open — inspect `north clock status`; no session was closed"))
  :else (let [run (first sessions)
   port (fram.rt/coord-port)
   coord-v (fram.rt/coord-version-for-log port log)]
  (if (< coord-v 0) (println (coordinator-failure-message coord-v port log "still clocked in")) (let [now (fram.rt/now-iso)
   st (k/one-i idx run "start_time")
   owner (clk/session-owner idx run)
   dur (if (some? st) (- (fram.rt/iso-to-seconds now) (fram.rt/iso-to-seconds st)) 0)
   resp (tell-retry port log "assert" run "end_time" now 5)]
  (if (str/starts-with? resp "ok:") (println (str "clocked out of client " (if (some? owner) owner "?") " — this session " (fmt-hm dur))) (println (str "clock out FAILED to record end_time (" resp ") — still clocked in, retry")))))))))

(defn cmd-clock-start [^String log ^String id]
  (let [idx (live-idx log)
   te (str "@" id)
   me (agent-id)
   open (clk/open-human-sessions idx)]
  (cond
  (not= me "user") (println (str "clock start refused for managed agent " me " — task timing is recorded as run telemetry"))
  (nil? (k/one-i idx te "title")) (println (str "no such thread: " id))
  (not (empty? open)) (let [run (first open)
   owner (clk/session-owner idx run)]
  (println (str "already clocked in for client " (if (some? owner) owner "?") " (session " (short-id run) ") — `clock stop` first")))
  :else (let [port (fram.rt/coord-port)
   coord-v (fram.rt/coord-version-for-log port log)]
  (if (< coord-v 0) (println (coordinator-failure-message coord-v port log "clock start was not recorded")) (let [sid (fresh-sid idx (fram.rt/now-id))
   ssub (str "@" sid)
   now (fram.rt/now-iso)
   r1 (tell-retry port log "assert" ssub "clocked_by" me 5)
   r2 (if (str/starts-with? r1 "ok:") (tell-retry port log "assert" ssub "start_time" now 5) "skipped: clocked_by failed")
   r3 (if (str/starts-with? r2 "ok:") (tell-retry port log "assert" ssub "session_of" te 5) "skipped: start_time failed")]
  (if (and (str/starts-with? r1 "ok:") (and (str/starts-with? r2 "ok:") (str/starts-with? r3 "ok:"))) (println (str "clocked in on " id " at " now "  (session " sid ", agent " me ")")) (println (str "clock start FAILED to record (" r1 "/" r2 "/" r3 ") — retry")))))))))

(defn cmd-clock-stop [^String log]
  (cmd-clock-out log))

(defn cmd-clock-orphan [^String log ^String agent]
  (let [idx (live-idx log)
   run (clk/running-session-for idx agent)]
  (cond
  (nil? run) (println (str "no open session for agent " agent " — nothing to orphan"))
  :else (let [port (fram.rt/coord-port)
   coord-v (fram.rt/coord-version-for-log port log)]
  (if (< coord-v 0) (println (coordinator-failure-message coord-v port log "orphan close was not recorded")) (let [now (fram.rt/now-iso)
   te (session-thread idx run)
   r1 (tell-retry port log "assert" run "end_time" now 5)
   r2 (tell-retry port log "assert" run "clock_orphaned" "true" 5)]
  (if (and (str/starts-with? r1 "ok:") (str/starts-with? r2 "ok:")) (println (str "orphan-closed " (short-id run) " on " (short-id te) " at " now "  (agent " agent ", clock_orphaned)")) (println (str "clock orphan FAILED (" r1 "/" r2 ") — retry")))))))))

(defn cmd-clock-status [^String log]
  (let [idx (live-idx log)
   sessions (clk/open-human-sessions idx)]
  (cond
  (empty? sessions) (println "not clocked in for a client")
  (> (count sessions) 1) (println (str "invalid client clock state: " (count sessions) " human sessions open"))
  :else (let [run (first sessions)
   now (fram.rt/now-iso)
   st (k/one-i idx run "start_time")
   owner (clk/session-owner idx run)
   rate (k/one-i idx run "rate")
   shown-rate (if (some? rate) rate "?")
   te (session-thread idx run)
   dur (if (some? st) (- (fram.rt/iso-to-seconds now) (fram.rt/iso-to-seconds st)) 0)]
  (println (str "clocked in for client " (if (some? owner) owner "?") "  (session " (short-id run) ", rate " shown-rate "/h)"))
  (if (not (= te "")) (do
  (println (str "  legacy thread " (short-id te) "  " (trunc (title-of idx te) 40)))))
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
   port (fram.rt/coord-port)
   coord-v (if (empty? sessions) 0 (fram.rt/coord-version-for-log port log))]
  (cond
  (empty? sessions) (println "nothing to sync — no closed, unsynced sessions")
  (< coord-v 0) (println (coordinator-failure-message coord-v port log "sync cannot record clockify_id"))
  :else (let [ws (cf/default-workspace)]
  (println (str "syncing " (count sessions) " session(s) to clockify (workspace " ws ")"))
  (doseq [s sessions]
  (let [te (session-thread idx s)
   owner (let [o (clk/session-owner idx s)]
  (if (some? o) o "personal"))
   proj (cf/project-for dir owner)
   st (k/one-i idx s "start_time")
   en (k/one-i idx s "end_time")]
  (cond
  (nil? proj) (println (str "  – skip " (short-id s) "  (owner '" owner "' unmapped — `clock map " owner " <project-id>`)"))
  (or (nil? st) (nil? en)) (println (str "  ! skip " (short-id s) "  (missing start/end)"))
  :else (let [description (if (= te "") (str owner " client session") (title-of idx te))
   cid (cf/create-entry ws proj st en description)]
  (if (= cid "") (println (str "  ! " (short-id s) "  (clockify returned no id)")) (let [wb (tell-retry port log "assert" s "clockify_id" cid 5)]
  (if (str/starts-with? wb "ok:") (println (str "  ✓ " (if (= te "") (short-id s) (short-id te)) "  " st " → " en "  (clockify " cid ")")) (println (str "  !! " (short-id s) " PUSHED to clockify (" cid ") but failed to record it (" wb ") — set manually to avoid a double-push: tell " (short-id s) " clockify_id " cid)))))))))
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
   status (fram.rt/coord-status-for-log port log)
   ops (read-logs-merged log)
   f (fold/fold ops)
   log-facts (:facts f)
   log-v (:version f)
   daemon-v (fram.rt/coord-version-for-log port log)
   up (not (= daemon-v -1))
   serving (>= daemon-v 0)
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

(defn- ^AdoptResult adopt-hand-facts [port ^String log live hand]
  (reduce (fn [acc c] (cond
  (not (adoptable? c)) (do
  (println (str "  drop (parse artifact) " (short-id (:l c)) "  pred=<" (:p c) "> val=<" (trunc (:r c) 40) ">"))
  (->AdoptResult (:adopted acc) (:skipped acc) (:failed acc) (+ (:dropped acc) 1)))
  (and (k/single? (:p c)) (let [v (k/one-i live (:l c) (:p c))]
  (and (some? v) (not (= v (:r c)))))) (do
  (println (str "  skip (log won) " (short-id (:l c)) "  " (:p c) "  " (trunc (:r c) 56)))
  (->AdoptResult (:adopted acc) (+ (:skipped acc) 1) (:failed acc) (:dropped acc)))
  :else (let [r (tell-retry port log "assert" (:l c) (:p c) (:r c) 5)]
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
  :else (if (and (or adopt resurrect) has-adoptable) (let [port (fram.rt/coord-port)
   coord-v (fram.rt/coord-version-for-log port log)]
  (if (< coord-v 0) (println (coordinator-failure-message coord-v port log "heal --adopt was not recorded")) (do
  (if (not resurrect) (report-tombstoned (:tombstoned p)) nil)
  (let [res (adopt-hand-facts port log (live-idx log) adopt-list)]
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
   before? fram.rt/str-lt?
   live? (default-live?)]
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
  (println (str "\nBOARD — active " (count (in-condition idx nonterm today before? live? "active")) "  ready " (count (in-condition idx nonterm today before? live? "ready")) "  blocked " (count (in-condition idx nonterm today before? live? "blocked")) "  draft " (count (in-condition idx nonterm today before? live? "draft"))))
  (let [cands (filterv (fn [te] (not (proj/terminal-i? idx te))) nonterm)
   items (filterv (fn [it] (> (:score it) 0)) (mapv (fn [te] (->LevItem te (proj/leverage-score idx te))) cands))
   ranked (vec (take 5 (sort-by (fn [it] (- 0 (:score it))) items)))]
  (println "TOP LEVERAGE — finishing these transitively frees the most stuck threads")
  (doseq [it ranked]
  (println (str "  unblocks " (:score it) "  " (short-id (:te it)) "  " (title-of idx (:te it)))))))))

(defn cmd-schema-seed [^String _log ^Boolean _execute]
  (do
  (println "schema-seed RETIRED — no facts were written.")
  (println "Use `north schema-migrate plan`, then maintenance-approved `migrate --execute`, and `audit --strict`.")))

(defn cmd-tools []
  (do
  (println "NORTH — curated tool surface (the MCP verbs; bin/north-mcp is authoritative):")
  (println "  work queue : ready · next · board · blocked · agenda · leverage · needs-review")
  (println "  vocabulary : schema (census by kind) · predicate (executable metadata) · schema-migrate (cutover/audit)")
  (println "  read/write : show · capture · tell · retract · validate   (untell = legacy alias of retract)")
  (println "  time       : clock rate <owner> [rate] · in <owner>|out|status|report  (start/stop remain compatible)")
  (println "  agents     : dispatch · spawn")
  (println "  view       : presentation")
  (println "")
  (println "Engine core underneath: fram = 10 tools (tell/retract/show/ask/validate + 5 graph-edit verbs).")
  (println "Vocabulary is DATA, not tools: `north show <pred>` reveals a predicate's metadata")
  (println "(cardinality/value_kind/acyclic facts). Govern it with `north predicate` and `north schema-migrate`.")))

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
  (= kind "client_session") "human billing -> north clock in/out (src/north/main.bclj kind=client_session)"
  (= kind "run") "managed task telemetry -> sdk/src/telemetry.ts recordRun (kind=run)"
  (= kind "message") "mail + commands -> cli/msg-cli.clj (@msg: mail, @cmd: commands)"
  (= kind "north/mine") "personal notes -> cli/north-mine.clj (@mine:<stem> facts)"
  (= kind "predicate") "executable schema -> north predicate define + north schema-migrate"
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
  (= cmd "capture") (if (and (>= (count args) 2) (or (= (nth args 1) "--help") (= (nth args 1) "-h"))) (println "usage: capture <title> [owner]") (if (>= (count args) 2) (cmd-capture threads-dir log (nth args 1) (if (>= (count args) 3) (nth args 2) "personal")) (println "usage: capture <title> [owner]")))
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
  (= cmd "validate") (do
  (cmd-validate log)
  nil)
  (= cmd "schema-seed") (cmd-schema-seed log (has-flag? args "--execute"))
  (= cmd "tools") (cmd-tools)
  (= cmd "doctor") (cmd-doctor threads-dir log)
  (= cmd "heal") (cmd-heal threads-dir log (has-flag? args "--adopt") (has-flag? args "--resurrect"))
  (= cmd "boot") (cmd-boot threads-dir log)
  (= cmd "json") (cmd-json log (if (> (count args) 1) (nth args 1) "") (if (> (count args) 2) (nth args 2) "") (has-flag? args "--all"))
  (= cmd "clock") (let [sub (if (> (count args) 1) (nth args 1) "status")]
  (cond
  (= sub "in") (if (>= (count args) 3) (cmd-clock-in log (nth args 2)) (println "usage: clock in <owner>"))
  (= sub "rate") (if (>= (count args) 3) (cmd-clock-rate log (nth args 2) (if (>= (count args) 4) (nth args 3) "")) (println "usage: clock rate <owner> [positive-hourly-rate]"))
  (= sub "out") (cmd-clock-out log)
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
  :else (println "usage: clock rate <owner> [rate] | in <owner> | out | start <id> | stop | orphan <agent-id> | status | report | today | week | sync | map <owner> <project-id> | projects | workspaces")))
  :else (println "north usage: capture <title> [owner] | ready [--all] | blocked | leverage | next | agenda | board [--all] | schema | needs-review | audit | resolve <@handle|@id> | validate | schema-seed (retired; use schema-migrate) | tools | doctor | heal | boot | listen <agent-id> | json <...> | clock <rate|in|out|start|stop|orphan|status|report|today|week|sync|map|projects|workspaces>   (board/ready default to a curated top slice; --all for the full dump. engine verbs import/export/show/set/tell/retract/merge route to fram; untell = legacy alias of retract)"))))

(defn run-status [args ^String threads-dir ^String log]
  (cond
  (and (not (empty? args)) (= (first args) "validate")) (cmd-validate log)
  (and (not (empty? args)) (= (first args) "schema-seed")) (do
  (cmd-schema-seed log (has-flag? args "--execute"))
  2)
  :else (do
  (run args threads-dir log)
  0)))

(defn -main [& args]
  (let [argv (vec args)
   threads-dir (fram.rt/threads-dir)
   log (fram.rt/log-path)
   status (run-status argv threads-dir log)]
  (if (not (= status 0)) (do
  (System/exit status)))))
